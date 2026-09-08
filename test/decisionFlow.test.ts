import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import { buildDecisionFlow, severityHeadline } from "../src/incidents/decisionFlow";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

describe("decision flow", () => {
  it("buildDecisionFlow returns the three severities (fixed order) + routing/escalation/comms", () => {
    const f = buildDecisionFlow();
    expect(f.severity.map((s) => s.severity)).toEqual(["sev1", "sev2", "sev3"]);
    expect(f.routing.map((r) => r.path)).toEqual(["internal", "external"]);
    expect(f.escalation_triggers.length).toBeGreaterThan(0);
    expect(f.external_comms_threshold.length).toBeGreaterThan(0);
    // Every severity carries a headline + includes.
    for (const s of f.severity) {
      expect(s.headline.length).toBeGreaterThan(0);
      expect(s.includes.length).toBeGreaterThan(0);
    }
  });

  it("severityHeadline resolves per level", () => {
    expect(severityHeadline("sev1")).toContain("Tier-1");
    expect(severityHeadline("sev3")).toContain("Minor");
  });

  it("GET /api/decision-flow requires a session and returns the flow", async () => {
    expect((await SELF.fetch("https://x/api/decision-flow")).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const res = await SELF.fetch("https://x/api/decision-flow", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { severity: unknown[]; routing: unknown[] };
    expect(Array.isArray(body.severity)).toBe(true);
    expect(body.severity.length).toBe(3);
    expect(Array.isArray(body.routing)).toBe(true);
  });
});
