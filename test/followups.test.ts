import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { listFollowUps, listIncidentHistory } from "../src/reporting/followups";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function seed() {
  // Two incidents, each with a post-mortem + action items.
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind("FU-1", "FU_Checkout", "resolved", "sev1", "internal", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z").run();
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind("FU-2", "FU_Partner", "resolved", "sev3", "external", "2026-09-02T00:00:00.000Z", "2026-09-02T00:30:00.000Z").run();

  await env.DB.prepare("INSERT INTO postmortems (id, incident_id, status) VALUES (?, ?, 'published')").bind("PM-1", "FU-1").run();
  await env.DB.prepare("INSERT INTO postmortems (id, incident_id, status) VALUES (?, ?, 'draft')").bind("PM-2", "FU-2").run();

  // FU-1: one open (with owner+jira), one done. FU-2: one open.
  await env.DB.prepare(
    "INSERT INTO postmortem_action_items (id, postmortem_id, description, owner, done, jira_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("AI-1", "PM-1", "Add a rate limiter", "alice", 0, "INC-101").run();
  await env.DB.prepare(
    "INSERT INTO postmortem_action_items (id, postmortem_id, description, owner, done, jira_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("AI-2", "PM-1", "Write a runbook", null, 1, null).run();
  await env.DB.prepare(
    "INSERT INTO postmortem_action_items (id, postmortem_id, description, owner, done, jira_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("AI-3", "PM-2", "Email the partner", "bob", 0, null).run();
}

async function clean() {
  await env.DB.prepare("DELETE FROM postmortem_action_items WHERE id LIKE 'AI-%'").run();
  await env.DB.prepare("DELETE FROM postmortems WHERE id LIKE 'PM-%'").run();
  await env.DB.prepare("DELETE FROM incidents WHERE id LIKE 'FU-%'").run();
}

describe("follow-ups + history", () => {
  afterEach(clean);

  it("listFollowUps: open-only by default, all when requested", async () => {
    await seed();
    const db = new D1Db(env.DB);
    const open = await listFollowUps(db, true);
    const openIds = open.map((f) => f.id).sort();
    expect(openIds).toEqual(["AI-1", "AI-3"]);
    // carries incident context + jira + owner
    const a1 = open.find((f) => f.id === "AI-1")!;
    expect(a1.incident_name).toBe("FU_Checkout");
    expect(a1.owner).toBe("alice");
    expect(a1.jira_key).toBe("INC-101");
    expect(a1.postmortem_status).toBe("published");

    const all = await listFollowUps(db, false);
    expect(all.length).toBe(3); // includes the done one
    expect(all.some((f) => f.id === "AI-2" && f.done)).toBe(true);
  });

  it("listIncidentHistory: newest first + open-action counts + filters", async () => {
    await seed();
    const db = new D1Db(env.DB);
    const all = await listIncidentHistory(db);
    const mine = all.filter((h) => h.id.startsWith("FU-"));
    // FU-2 resolved later → first
    expect(mine[0].id).toBe("FU-2");
    const fu1 = mine.find((h) => h.id === "FU-1")!;
    expect(fu1.has_postmortem).toBe(true);
    expect(fu1.open_action_items).toBe(1); // AI-1 open, AI-2 done

    // Filter by severity + path.
    const sev1 = (await listIncidentHistory(db, { severity: "sev1" })).filter((h) => h.id.startsWith("FU-"));
    expect(sev1.map((h) => h.id)).toEqual(["FU-1"]);
    const external = (await listIncidentHistory(db, { routing_path: "external" })).filter((h) => h.id.startsWith("FU-"));
    expect(external.map((h) => h.id)).toEqual(["FU-2"]);
  });

  it("routes require a session and return the lists", async () => {
    await seed();
    expect((await SELF.fetch("https://x/api/followups")).status).toBe(401);
    expect((await SELF.fetch("https://x/api/history")).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const fu = await SELF.fetch("https://x/api/followups", { headers: { Cookie: cookie } });
    expect(fu.status).toBe(200);
    expect(Array.isArray(((await fu.json()) as { followups: unknown[] }).followups)).toBe(true);
    const h = await SELF.fetch("https://x/api/history?severity=sev1", { headers: { Cookie: cookie } });
    expect(h.status).toBe(200);
  });
});
