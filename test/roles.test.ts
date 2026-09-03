import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { RoleStore } from "../src/roles/store";
import { rolesBlocks, CLAIM_ACTION_PREFIX, __setRolesSlackClient } from "../src/roles/service";
import { handleSlackInteractivity } from "../src/slack/interactivity";
import { FakeSlackClient } from "../src/clients/fakeSlack";

const SIGNING_SECRET = "e2e-signing-secret";
const encoder = new TextEncoder();

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

async function seedChannel(incidentId: string, channel: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO incidents (id, name, status, created_at, resolved_at) VALUES (?, ?, 'investigating', ?, NULL)",
  )
    .bind(incidentId, "Checkout 500s", "2026-09-03T01:00:00Z")
    .run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO incident_channels (channel, incident_id, do_id) VALUES (?, ?, ?)",
  )
    .bind(channel, incidentId, incidentId)
    .run();
}

describe("RoleStore", () => {
  beforeEach(async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO incidents (id, name, status, created_at, resolved_at) VALUES ('inc_roles_store','X','investigating','2026-09-03T01:00:00Z',NULL)",
    ).run();
  });
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = 'inc_roles_store'").run();
    await env.DB.prepare("DELETE FROM incidents WHERE id = 'inc_roles_store'").run();
  });

  it("claims and lists a role", async () => {
    const store = new RoleStore(new D1Db(env.DB));
    await store.claim("inc_roles_store", "engineering_lead", "U_ALICE");
    const roles = await store.list("inc_roles_store");
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ role: "engineering_lead", slack_user_id: "U_ALICE" });
  });

  it("transfers a role on re-claim (one holder per role)", async () => {
    const store = new RoleStore(new D1Db(env.DB));
    await store.claim("inc_roles_store", "engineering_lead", "U_ALICE");
    await store.claim("inc_roles_store", "engineering_lead", "U_BOB");
    const roles = await store.list("inc_roles_store");
    expect(roles).toHaveLength(1);
    expect(roles[0].slack_user_id).toBe("U_BOB");
  });
});

describe("rolesBlocks", () => {
  it("renders a Take button per role with the claim action_id", () => {
    const blocks = rolesBlocks({ engineering_lead: "U_ALICE" }) as any[];
    const actions = blocks.find((b) => b.type === "actions");
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toContain(`${CLAIM_ACTION_PREFIX}engineering_lead`);
    expect(ids).toContain(`${CLAIM_ACTION_PREFIX}customer_support_lead`);
    // holder shown in the section text
    expect(JSON.stringify(blocks)).toContain("U_ALICE");
  });
});

describe("interactivity endpoint", () => {
  beforeEach(() => __setRolesSlackClient(() => new FakeSlackClient(false)));
  afterEach(async () => {
    __setRolesSlackClient(undefined);
    await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = 'inc_role'").run();
    await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id = 'inc_role'").run();
    await env.DB.prepare("DELETE FROM incidents WHERE id = 'inc_role'").run();
  });

  async function postInteractivity(payload: unknown, ts: string, sig?: string) {
    const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const signature = sig ?? (await sign(raw, ts));
    return SELF.fetch("https://example.com/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": signature,
      },
      body: raw,
    });
  }

  it("rejects a bad signature with 401", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await postInteractivity({ type: "block_actions" }, ts, "v0=deadbeef");
    expect(res.status).toBe(401);
  });

  it("claims a role from a signed block_actions payload", async () => {
    await seedChannel("inc_role", "C_INC");
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: "block_actions",
      user: { id: "U_ALICE" },
      channel: { id: "C_INC" },
      actions: [{ action_id: `${CLAIM_ACTION_PREFIX}engineering_lead`, value: "engineering_lead" }],
    };
    // Drive the handler in-isolate so the override + waitUntil D1 write are
    // visible to env.DB (SELF.fetch's waitUntil writes are not reliably visible;
    // see project.incident.workers_pool_limits).
    const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const req = new Request("https://example.com/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": await sign(raw, ts),
      },
      body: raw,
    });
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(req, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    const roles = await new RoleStore(new D1Db(env.DB)).list("inc_role");
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ role: "engineering_lead", slack_user_id: "U_ALICE" });
  });
});
