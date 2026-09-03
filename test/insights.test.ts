import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { buildInsights } from "../src/reporting/insights";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function inc(
  id: string,
  severity: string,
  routing: string,
  created: string,
  resolved: string | null,
) {
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, id, resolved ? "resolved" : "investigating", severity, routing, created, resolved).run();
}

describe("insights", () => {
  afterEach(async () => {
    for (const t of ["postmortem_action_items", "postmortems", "incident_updates", "incidents"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("buckets by severity + routing path, builds a monthly trend, computes MTTR", async () => {
    const from = "2026-08-01T00:00:00.000Z";
    const to = "2026-10-01T00:00:00.000Z";

    // Aug: 1 sev1 internal (resolved +2h), 1 sev2 external (open).
    await inc("A", "sev1", "internal", "2026-08-05T00:00:00.000Z", "2026-08-05T02:00:00.000Z");
    await inc("B", "sev2", "external", "2026-08-20T00:00:00.000Z", null);
    // Sep: 2 sev3 internal (one resolved +1h).
    await inc("C", "sev3", "internal", "2026-09-10T00:00:00.000Z", "2026-09-10T01:00:00.000Z");
    await inc("D", "sev3", "internal", "2026-09-15T00:00:00.000Z", null);

    const ins = await buildInsights(new D1Db(env.DB), from, to);
    expect(ins.total_opened).toBe(4);

    const sev = Object.fromEntries(ins.by_severity.map((b) => [b.key, b.count]));
    expect(sev).toEqual({ sev1: 1, sev2: 1, sev3: 2 });
    // sev1 bucket MTTR = 2h = 7200s.
    expect(ins.by_severity.find((b) => b.key === "sev1")?.mttr_seconds).toBe(7200);
    // sev2 has no resolved → null MTTR.
    expect(ins.by_severity.find((b) => b.key === "sev2")?.mttr_seconds).toBeNull();

    const path = Object.fromEntries(ins.by_routing_path.map((b) => [b.key, b.count]));
    expect(path).toEqual({ internal: 3, external: 1 });

    // Monthly trend: Aug (1 opened resolved that month, 2 opened) + Sep.
    const aug = ins.by_month.find((m) => m.month === "2026-08");
    const sep = ins.by_month.find((m) => m.month === "2026-09");
    expect(aug?.opened).toBe(2);
    expect(aug?.resolved).toBe(1); // A resolved in Aug
    expect(sep?.opened).toBe(2);
    expect(sep?.resolved).toBe(1); // C resolved in Sep
    // months are chronological
    expect(ins.by_month.map((m) => m.month)).toEqual(["2026-08", "2026-09"]);

    // overall MTTR = mean(7200, 3600) = 5400.
    expect(ins.overall_mttr_seconds).toBe(5400);
  });

  it("GET /api/insights requires a session and returns the payload", async () => {
    expect((await SELF.fetch("https://x/api/insights")).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const res = await SELF.fetch("https://x/api/insights?period=all", {
      headers: { Cookie: cookie, accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { by_severity: unknown[]; by_month: unknown[] };
    expect(Array.isArray(body.by_severity)).toBe(true);
    expect(Array.isArray(body.by_month)).toBe(true);
  });
});
