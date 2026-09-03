import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import { ingestAlert } from "../src/oncall/alerts";
import { escalateNew } from "../src/oncall/escalation";
import { buildOncallSection } from "../src/oncall/webApi";
import { __setNotifierSlackClient } from "../src/oncall/notifier";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";
const KEY = "test_webapi_alert";
const RESP = ["U_wa_a", "U_wa_b"];

async function cookie() {
  const s = makeSession({ user_id: "U_WEB", team_id: TEAM, name: "Den" });
  return `${SESSION_COOKIE}=${await signSession(s, SECRET)}`;
}

function get(path: string, c: string | null) {
  return SELF.fetch(`https://example.com${path}`, {
    headers: { accept: "application/json", ...(c ? { Cookie: c } : {}) },
  });
}
function post(path: string, c: string | null, body: unknown) {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(c ? { Cookie: c } : {}) },
    body: JSON.stringify(body),
  });
}

async function seedResponders() {
  let i = 0;
  for (const id of RESP) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, NULL, 1, ?)",
    ).bind(id, id, i++).run();
  }
  await env.DB.prepare(
    "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 1)",
  ).bind(
    "shift_wa_test", RESP[0],
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() + 3600_000).toISOString(),
  ).run();
}

async function clean() {
  await env.DB.prepare(
    "DELETE FROM oncall_escalations WHERE alert_id IN (SELECT id FROM oncall_alerts WHERE dedup_key LIKE 'test_webapi_%')",
  ).run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_webapi_%'").run();
  await env.DB.prepare("DELETE FROM oncall_shifts WHERE id LIKE 'shift_wa_%'").run();
  const ph = RESP.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM oncall_responders WHERE id IN (${ph})`).bind(...RESP).run();
  await env.DB.prepare("DELETE FROM incidents WHERE name LIKE 'WA_%'").run();
  await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id NOT IN (SELECT id FROM incidents)").run();
}

describe("on-call web section (slice 6)", () => {
  beforeEach(async () => {
    await clean();
    await seedResponders();
    (env as any).ONCALL_FALLBACK_CHANNEL = "C_wa_fallback";
    __setNotifierSlackClient(() => new FakeSlackClient(false));
    __setIncidentClientOverrides({ slack: () => new FakeSlackClient(false), summarizer: () => new FakeSummarizer() });
  });
  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    __resetIncidentClientOverrides();
    delete (env as any).ONCALL_FALLBACK_CHANNEL;
    await clean();
  });

  it("GET /api/oncall requires a session", async () => {
    expect((await get("/api/oncall", null)).status).toBe(401);
  });

  it("buildOncallSection reports who's on now/next, rotation, and open alerts with trail", async () => {
    const out = await ingestAlert(env as any, { title: "WA_disk", dedup_key: KEY, severity: "sev2" });
    if (out.result !== "created") throw new Error("expected created");
    await escalateNew(env as any, out.alert);

    const section = await buildOncallSection(env as any);
    expect(section.now?.id).toBe(RESP[0]);
    expect(section.next?.id).toBe(RESP[1]);
    expect(section.upcoming.length).toBeGreaterThan(0);
    const mine = section.open_alerts.find((a) => a.id === out.alert.id);
    expect(mine).toBeTruthy();
    expect(mine!.trail.length).toBeGreaterThan(0); // escalation row(s) recorded
  });

  it("POST ack sets the alert to ack via the session route", async () => {
    const out = await ingestAlert(env as any, { title: "WA_ack", dedup_key: KEY });
    if (out.result !== "created") throw new Error("expected created");
    await escalateNew(env as any, out.alert);

    const c = await cookie();
    const res = await post(`/api/oncall/alerts/${out.alert.id}/ack`, c, {});
    expect(res.status).toBe(200);
    const a = await env.DB.prepare("SELECT status FROM oncall_alerts WHERE id = ?")
      .bind(out.alert.id).first<{ status: string }>();
    expect(a?.status).toBe("ack");
  });

  it("POST promote links an incident (404 for unknown alert)", async () => {
    const out = await ingestAlert(env as any, { title: "WA_promote", dedup_key: KEY, severity: "sev1" });
    if (out.result !== "created") throw new Error("expected created");
    const c = await cookie();

    const res = await post(`/api/oncall/alerts/${out.alert.id}/promote`, c, {});
    expect(res.status).toBe(200);
    const linked = await env.DB.prepare("SELECT incident_id FROM oncall_alerts WHERE id = ?")
      .bind(out.alert.id).first<{ incident_id: string | null }>();
    expect(linked?.incident_id).toBeTruthy();

    expect((await post(`/api/oncall/alerts/alert_missing/promote`, c, {})).status).toBe(404);
  });

  it("POST override validates and inserts an is_override shift", async () => {
    const c = await cookie();
    expect((await post("/api/oncall/overrides", null, {})).status).toBe(401);
    expect((await post("/api/oncall/overrides", c, {})).status).toBe(400);
    const start = new Date(Date.now() + 3600_000).toISOString();
    const bad = await post("/api/oncall/overrides", c, { responder: RESP[1], starts_at: start, ends_at: start });
    expect(bad.status).toBe(400); // end not after start

    const end = new Date(Date.now() + 7200_000).toISOString();
    const ok = await post("/api/oncall/overrides", c, { responder: RESP[1], starts_at: start, ends_at: end });
    expect(ok.status).toBe(201);
    const id = ((await ok.json()) as { id: string }).id;
    const row = await env.DB.prepare("SELECT is_override, responder FROM oncall_shifts WHERE id = ?")
      .bind(id).first<{ is_override: number; responder: string }>();
    expect(row?.is_override).toBe(1);
    expect(row?.responder).toBe(RESP[1]);
    // cleanup this override (not matched by shift_wa_ prefix)
    await env.DB.prepare("DELETE FROM oncall_shifts WHERE id = ?").bind(id).run();
  });
});
