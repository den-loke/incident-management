/**
 * End-to-end: a fake incident driven to resolution, deterministically, no
 * Slack/OpenAI network. See docs/ARCHITECTURE.md §9.
 *
 * Two layers:
 *  - The REAL Worker HTTP entry (SELF.fetch) proves Slack signature
 *    verification accepts a validly-signed webhook and rejects a bad one.
 *  - The incident lifecycle is driven through `routeSlackEvent` (the exact
 *    routing the Worker runs post-ack) with test-injected fake Slack/OpenAI
 *    clients — so the test can seed inbound channel messages the alarm then
 *    summarizes — asserting against D1 (the source of truth) and the DO's
 *    alarm state across multiple ticks.
 */
import {
  SELF,
  env,
  listDurableObjectIds,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeSlackEvent } from "../src/router";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const SIGNING_SECRET = "e2e-signing-secret"; // matches vitest.config.ts binding
const TEAM_ID = "T_E2E";
const encoder = new TextEncoder();

let slack: FakeSlackClient;
let summarizer: FakeSummarizer;

beforeEach(() => {
  slack = new FakeSlackClient();
  summarizer = new FakeSummarizer();
  __setIncidentClientOverrides({
    slack: () => slack,
    summarizer: () => summarizer,
    // sink defaults to the real InternalStatusSink over the test D1.
  });
});
afterEach(() => __resetIncidentClientOverrides());

async function sign(rawBody: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function msgEvent(event: { channel: string; user: string; text: string }) {
  return {
    type: "event_callback",
    team_id: TEAM_ID,
    event: { type: "message", ts: "1700000000.000100", ...event },
  } as Parameters<typeof routeSlackEvent>[0];
}

async function countUpdates(incidentId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM incident_updates WHERE incident_id = ?",
  )
    .bind(incidentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("E2E: Slack signature (HTTP) + full incident lifecycle", () => {
  it("accepts a validly-signed webhook and rejects a mis-signed one (real Worker HTTP)", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: TEAM_ID,
      event: { type: "message", channel: "C_SIG", user: "U", text: "hi" },
    });
    const ts = `${Math.floor(Date.now() / 1000)}`;

    const good = await SELF.fetch("https://worker/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": await sign(body, ts),
      },
      body,
    });
    expect(good.status).toBe(200); // verified + acked

    const bad = await SELF.fetch("https://worker/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": "v0=deadbeef",
      },
      body,
    });
    expect(bad.status).toBe(401); // rejected
  });

  it("declare -> seed chatter -> multi-tick alarm -> resolve, asserted against D1", async () => {
    // 1) Declare via the routing layer (same code the Worker runs post-ack).
    const declared = await routeSlackEvent(
      msgEvent({
        channel: "C_ORIGIN",
        user: "U_alice",
        text: "declare Checkout 500s spiking",
      }),
      env,
    );
    expect(declared.action).toBe("declared");
    const incidentId = declared.incidentId!;
    const channelId = declared.channelId!;

    const inc = await env.DB.prepare(
      "SELECT name, status FROM incidents WHERE id = ?",
    )
      .bind(incidentId)
      .first<{ name: string; status: string }>();
    expect(inc?.name).toBe("Checkout 500s spiking");
    expect(inc?.status).toBe("investigating");

    const ids = await listDurableObjectIds(env.INCIDENT);
    expect(ids.length).toBe(1);
    const stub = env.INCIDENT.get(ids[0]);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    const afterDeclare = await countUpdates(incidentId);

    // 2) TICK ONE — seed genuine channel activity, then fire the alarm; it
    // summarizes the new messages into an update and reschedules.
    slack.seedMessage(channelId, "U_bob", "500s on /checkout, ~20%");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterTick1 = await countUpdates(incidentId);
    expect(afterTick1).toBeGreaterThan(afterDeclare);
    expect(summarizer.calls.length).toBe(1);
    expect(slack.posted.some((p) => p.channel === channelId)).toBe(true);
    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull(); // rescheduled
    });

    // 3) TICK TWO — more chatter, alarm fires again, another update.
    slack.seedMessage(channelId, "U_alice", "rolled back deploy, recovering");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await countUpdates(incidentId)).toBeGreaterThan(afterTick1);
    expect(summarizer.calls.length).toBe(2);

    // 4) Resolve; assert closed + alarm cancelled + no ghost update.
    await stub.fetch(
      new Request("https://do/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "resolve", body: "fix deployed" }),
      }),
    );
    const resolved = await env.DB.prepare(
      "SELECT status, resolved_at FROM incidents WHERE id = ?",
    )
      .bind(incidentId)
      .first<{ status: string; resolved_at: string | null }>();
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolved_at).not.toBeNull();

    await runInDurableObject(stub, async (_i, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
    const beforeGhost = await countUpdates(incidentId);
    await runInDurableObject(stub, async (instance, state) => {
      await instance.alarm?.();
      expect(await state.storage.getAlarm()).toBeNull(); // does not reschedule
    });
    expect(await countUpdates(incidentId)).toBe(beforeGhost); // no ghost update
  });
});
