import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { recordAudit, listAudit } from "../src/audit/log";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function authedCookie() {
  const session = makeSession({ user_id: "U_AUDIT", team_id: TEAM, name: "Den" });
  return `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;
}

describe("audit log", () => {
  const clean = async () => {
    for (const t of ["audit_log", "incident_channels", "incident_updates", "incidents"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  };
  beforeEach(async () => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(true),
      summarizer: () => new FakeSummarizer(true),
    });
    // isolatedStorage is off (shared D1); other files' API calls write audit rows,
    // so clean before each test too, not just after.
    await clean();
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    await clean();
  });

  it("recordAudit persists and listAudit reads it back (newest first, target-scoped)", async () => {
    await recordAudit(env as any, { actor: "web:U1", action: "incident.declare", target_type: "incident", target_id: "INC-1" });
    await recordAudit(env as any, { actor: "web:U2", action: "incident.resolve.request", target_type: "incident", target_id: "INC-1", detail: { note: "x" } });
    await recordAudit(env as any, { actor: "web:U3", action: "incident.declare", target_type: "incident", target_id: "INC-2" });

    const all = await listAudit(env as any);
    expect(all.length).toBe(3);
    // newest first
    expect(all[0].action).toBe("incident.declare");
    expect(all[0].target_id).toBe("INC-2");

    const scoped = await listAudit(env as any, { targetId: "INC-1" });
    expect(scoped.map((e) => e.action)).toEqual(["incident.resolve.request", "incident.declare"]);
    // detail round-trips as parsed JSON
    expect(scoped[0].detail).toEqual({ note: "x" });
  });

  it("declaring an incident via the API writes an audit row attributed to the session user", async () => {
    const cookie = await authedCookie();
    const res = await SELF.fetch("https://example.com/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Audited incident", severity: "sev2" }),
    });
    expect(res.status).toBe(201);
    const { incidentId } = (await res.json()) as { incidentId: string };

    const scoped = await listAudit(env as any, { targetId: incidentId });
    expect(scoped.length).toBe(1);
    expect(scoped[0]).toMatchObject({
      actor: "web:U_AUDIT",
      action: "incident.declare",
      target_type: "incident",
      target_id: incidentId,
      source: "web",
    });
  });

  it("GET /api/audit requires a session and returns entries", async () => {
    expect((await SELF.fetch("https://example.com/api/audit")).status).toBe(401);
    await recordAudit(env as any, { actor: "web:U1", action: "incident.declare", target_type: "incident", target_id: "INC-9" });
    const cookie = await authedCookie();
    const res = await SELF.fetch("https://example.com/api/audit", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
  });
});
