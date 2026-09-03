import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import {
  handleSlackCommand,
  __setCommandsSlackClient,
} from "../src/slack/commands";
import { declareIncident } from "../src/incidents/commands";
import { __setJointResolveSlackClient } from "../src/incidents/jointResolve";
import { DECLARE_MODAL_CALLBACK } from "../src/stakeholders/service";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const SIGNING_SECRET = "e2e-signing-secret";
const encoder = new TextEncoder();

/** Wire EVERY Slack-touching seam (command handler + DO + roles/stakeholders/joint-resolve) to one fake. */
function wireFakes(fake: FakeSlackClient) {
  __setCommandsSlackClient(() => fake);
  __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
  __setRolesSlackClient(() => fake);
  __setStakeholderSlackClient(() => fake);
  __setJointResolveSlackClient(() => fake);
}
function unwireFakes() {
  __setCommandsSlackClient(undefined);
  __resetIncidentClientOverrides();
  __setRolesSlackClient(undefined);
  __setStakeholderSlackClient(undefined);
  __setJointResolveSlackClient(undefined);
}

async function sign(rawBody: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${rawBody}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

/** Build a signed slash-command request and run it in-isolate (waitUntil visible to env.DB). */
async function runCommand(fields: Record<string, string>) {
  const raw = new URLSearchParams({ command: "/incident", ...fields }).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request("https://example.com/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": await sign(raw, ts),
    },
    body: raw,
  });
  const ctx = createExecutionContext();
  const res = await handleSlackCommand(req, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const body = (await res.clone().json().catch(() => null)) as { text?: string } | null;
  return { res, text: body?.text ?? "" };
}

/** Declare a real incident through the DO (fakes wired) and return its ids. */
async function declareVia(name: string): Promise<{ incidentId: string; channelId: string }> {
  return declareIncident(env as any, name);
}

async function updateBodies(incidentId: string): Promise<{ body: string; status: string }[]> {
  const rows = await new D1Db(env.DB).all<{ body: string; status: string }>(
    "SELECT body, status FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    [incidentId],
  );
  return rows;
}

describe("slash command signature", () => {
  it("rejects a bad signature with 401", async () => {
    const raw = new URLSearchParams({ command: "/incident", text: "help" }).toString();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await SELF.fetch("https://example.com/slack/commands", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=deadbeef",
      },
      body: raw,
    });
    expect(res.status).toBe(401);
  });
});

describe("/incident declare", () => {
  let fake: FakeSlackClient;
  beforeEach(() => {
    fake = new FakeSlackClient(false);
    wireFakes(fake);
  });
  afterEach(async () => {
    unwireFakes();
    await env.DB.prepare("DELETE FROM incident_channels").run();
    await env.DB.prepare("DELETE FROM incident_updates").run();
    await env.DB.prepare("DELETE FROM incidents").run();
  });

  it("opens the shared declare modal when invoked bare", async () => {
    const { res } = await runCommand({ text: "", trigger_id: "T123", user_id: "U_ALICE" });
    // Empty 200 body so Slack shows no message.
    expect(res.status).toBe(200);
    expect(await res.clone().text()).toBe("");
    // Reuses the SAME modal the Home-tab "Declare incident" button opens.
    expect(fake.openedViews).toHaveLength(1);
    expect(fake.openedViews[0].triggerId).toBe("T123");
    expect((fake.openedViews[0].view as any).callback_id).toBe(DECLARE_MODAL_CALLBACK);
  });

  it("declares immediately when a title is supplied", async () => {
    const { text } = await runCommand({
      text: "declare Checkout API is down",
      user_id: "U_ALICE",
      channel_id: "C_GENERAL",
    });
    expect(text).toContain("Checkout API is down");
    // The shared declare path created the incident + its channel.
    expect(fake.created).toHaveLength(1);
    const rows = await new D1Db(env.DB).all("SELECT id FROM incidents");
    expect(rows.length).toBe(1);
  });
});

describe("channel-scoped commands", () => {
  let fake: FakeSlackClient;
  beforeEach(() => {
    fake = new FakeSlackClient(false);
    wireFakes(fake);
  });
  afterEach(async () => {
    unwireFakes();
    await env.DB.prepare("DELETE FROM incident_resolution_requests").run();
    await env.DB.prepare("DELETE FROM incident_updates").run();
    await env.DB.prepare("DELETE FROM incident_channels").run();
    await env.DB.prepare("DELETE FROM incidents").run();
  });

  it("update posts to this channel's incident", async () => {
    const { incidentId, channelId } = await declareVia("Checkout 500s");
    const { text } = await runCommand({
      text: "update rolled back the deploy",
      user_id: "U_BOB",
      channel_id: channelId,
    });
    expect(text).toContain("Update posted");
    const updates = await updateBodies(incidentId);
    expect(updates.some((u) => u.body.includes("rolled back the deploy"))).toBe(true);
  });

  it("update in a non-incident channel is refused with guidance", async () => {
    const { text } = await runCommand({
      text: "update nothing here",
      user_id: "U_BOB",
      channel_id: "C_RANDOM",
    });
    expect(text).toContain("isn't an incident channel");
  });

  it("status advances the lifecycle and records the note", async () => {
    const { incidentId, channelId } = await declareVia("Checkout 500s");
    const { text } = await runCommand({
      text: "status identified root cause found",
      user_id: "U_BOB",
      channel_id: channelId,
    });
    expect(text).toContain("identified");
    const updates = await updateBodies(incidentId);
    const advancing = updates.find((u) => u.status === "identified");
    expect(advancing).toBeTruthy();
    expect(advancing!.body).toContain("root cause found");
  });

  it("status rejects an invalid status", async () => {
    const { channelId } = await declareVia("Checkout 500s");
    const { text } = await runCommand({
      text: "status kaput",
      user_id: "U_BOB",
      channel_id: channelId,
    });
    expect(text).toContain("not a settable status");
  });

  it("status refuses 'resolved' (that's the joint-resolve command)", async () => {
    const { channelId } = await declareVia("Checkout 500s");
    const { text } = await runCommand({
      text: "status resolved",
      user_id: "U_BOB",
      channel_id: channelId,
    });
    expect(text).toContain("not a settable status");
  });

  it("resolve records a resolution request (joint sign-off)", async () => {
    const { incidentId, channelId } = await declareVia("Checkout 500s");
    const { text } = await runCommand({
      text: "resolve mitigated, monitoring",
      user_id: "U_BOB",
      channel_id: channelId,
    });
    expect(text).toContain("different person needs to confirm");
    const req = await new D1Db(env.DB).get<{ requested_by: string; note: string }>(
      "SELECT requested_by, note FROM incident_resolution_requests WHERE incident_id = ?",
      [incidentId],
    );
    expect(req).toMatchObject({ requested_by: "U_BOB", note: "mitigated, monitoring" });
  });
});

describe("help + unknown", () => {
  it("help returns usage", async () => {
    const { text } = await runCommand({ text: "help", user_id: "U_ALICE" });
    expect(text).toContain("/incident declare");
    expect(text).toContain("/incident update");
  });

  it("unknown subcommand returns usage", async () => {
    const { text } = await runCommand({ text: "frobnicate", user_id: "U_ALICE" });
    expect(text).toContain("Unknown subcommand");
  });
});
