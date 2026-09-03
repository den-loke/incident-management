import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTeam,
  resolveTeams,
  isTeamMember,
  __setUsergroupClient,
  type UsergroupClient,
} from "../src/teams/service";
import type { Env } from "../src/env";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

function fakeClient(map: Record<string, string[]>): UsergroupClient {
  return { listUsers: async (id) => map[id] ?? [] };
}
function baseEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

afterEach(() => __setUsergroupClient(null));

describe("linked Slack-group teams (service)", () => {
  it("resolves a configured team to its usergroup members", async () => {
    __setUsergroupClient(fakeClient({ S_ENG: ["U1", "U2"] }));
    const t = await resolveTeam(baseEnv({ TEAM_ENGINEERING_USERGROUP: "S_ENG" }), "engineering");
    expect(t.configured).toBe(true);
    expect(t.usergroup_id).toBe("S_ENG");
    expect(t.members).toEqual(["U1", "U2"]);
    expect(t.label).toBe("Engineering");
  });

  it("an unconfigured team resolves to an empty roster, configured:false, no lookup", async () => {
    let called = false;
    __setUsergroupClient({ listUsers: async () => { called = true; return []; } });
    const t = await resolveTeam(baseEnv({ TEAM_SUPPORT_USERGROUP: undefined }), "support");
    expect(t.configured).toBe(false);
    expect(t.members).toEqual([]);
    expect(called).toBe(false); // never calls Slack when unconfigured
  });

  it("swallows a Slack lookup failure to an empty roster (best-effort)", async () => {
    __setUsergroupClient({ listUsers: async () => { throw new Error("slack usergroups.users.list failed: fatal"); } });
    const t = await resolveTeam(baseEnv({ TEAM_ENGINEERING_USERGROUP: "S_ENG" }), "engineering");
    expect(t.configured).toBe(true);
    expect(t.members).toEqual([]); // failure → empty, not thrown
  });

  it("resolveTeams returns all three fixed teams; isTeamMember checks membership", async () => {
    __setUsergroupClient(fakeClient({ S_ENG: ["U1"], S_SUP: ["U9"], S_STK: ["U5"] }));
    const e = baseEnv({ TEAM_ENGINEERING_USERGROUP: "S_ENG", TEAM_SUPPORT_USERGROUP: "S_SUP", TEAM_STAKEHOLDERS_USERGROUP: "S_STK" });
    const teams = await resolveTeams(e);
    expect(teams.map((t) => t.key)).toEqual(["engineering", "support", "stakeholders"]);
    expect(await isTeamMember(e, "engineering", "U1")).toBe(true);
    expect(await isTeamMember(e, "engineering", "U9")).toBe(false);
    expect(await isTeamMember(e, "support", "U9")).toBe(true);
    expect(await isTeamMember(e, "stakeholders", "U5")).toBe(true);
  });
});

describe("GET /api/teams route", () => {
  it("requires a session, then returns the teams array", async () => {
    __setUsergroupClient(fakeClient({ S_ENG_E2E: ["U_A", "U_B"] }));
    expect((await SELF.fetch("https://x/api/teams")).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const res = await SELF.fetch("https://x/api/teams", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { teams: { key: string; members: string[]; configured: boolean }[]; stakeholder_optins: string[] };
    const eng = body.teams.find((t) => t.key === "engineering")!;
    expect(eng.configured).toBe(true); // TEAM_ENGINEERING_USERGROUP bound in vitest.config
    expect(eng.members).toEqual(["U_A", "U_B"]);
    const sup = body.teams.find((t) => t.key === "support")!;
    expect(sup.configured).toBe(false); // no support usergroup bound
    expect(body.teams.find((t) => t.key === "stakeholders")).toBeTruthy(); // third team present
    expect(Array.isArray(body.stakeholder_optins)).toBe(true); // opt-in list included
  });
});
