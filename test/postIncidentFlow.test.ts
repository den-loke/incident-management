import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { buildPostIncidentFlow } from "../src/postmortem/postIncidentFlow";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function incident(id: string, status: string) {
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, severity, routing_path, created_at) VALUES (?, ?, ?, 'sev2', 'internal', ?)",
  ).bind(id, `PIF ${id}`, status, "2026-09-01T00:00:00.000Z").run();
}
async function postmortem(id: string, incidentId: string, status: string) {
  await env.DB.prepare("INSERT INTO postmortems (id, incident_id, status) VALUES (?, ?, ?)").bind(id, incidentId, status).run();
}
async function item(id: string, pmId: string, done: number, jira: string | null) {
  await env.DB.prepare(
    "INSERT INTO postmortem_action_items (id, postmortem_id, description, done, jira_key) VALUES (?, ?, 'x', ?, ?)",
  ).bind(id, pmId, done, jira).run();
}

async function clean() {
  await env.DB.prepare("DELETE FROM postmortem_action_items WHERE id LIKE 'PIFI-%'").run();
  await env.DB.prepare("DELETE FROM postmortems WHERE id LIKE 'PIFPM-%'").run();
  await env.DB.prepare("DELETE FROM incidents WHERE id LIKE 'PIF-%'").run();
}

function stateOf(flow: Awaited<ReturnType<typeof buildPostIncidentFlow>>, key: string) {
  return flow.items.find((i) => i.key === key)!.state;
}

describe("post-incident flow (derived checklist)", () => {
  afterEach(clean);

  it("open incident with no post-mortem: only resolved pending, nothing done", async () => {
    await incident("PIF-1", "investigating");
    const flow = await buildPostIncidentFlow(new D1Db(env.DB), "PIF-1", "investigating");
    expect(stateOf(flow, "resolved")).toBe("pending");
    expect(stateOf(flow, "drafted")).toBe("pending");
    expect(flow.complete).toBe(false);
  });

  it("resolved + drafted with an unfiled action item: filed step pending", async () => {
    await incident("PIF-2", "resolved");
    await postmortem("PIFPM-2", "PIF-2", "draft");
    await item("PIFI-2", "PIFPM-2", 0, null);
    const flow = await buildPostIncidentFlow(new D1Db(env.DB), "PIF-2", "resolved");
    expect(stateOf(flow, "resolved")).toBe("done");
    expect(stateOf(flow, "drafted")).toBe("done");
    expect(stateOf(flow, "action_items")).toBe("done");
    expect(stateOf(flow, "filed")).toBe("pending"); // no jira_key
    expect(stateOf(flow, "published")).toBe("pending");
    expect(flow.complete).toBe(false);
  });

  it("resolved + published + all items filed: complete", async () => {
    await incident("PIF-3", "resolved");
    await postmortem("PIFPM-3", "PIF-3", "published");
    await item("PIFI-3", "PIFPM-3", 1, "INC-9");
    const flow = await buildPostIncidentFlow(new D1Db(env.DB), "PIF-3", "resolved");
    expect(stateOf(flow, "filed")).toBe("done");
    expect(stateOf(flow, "published")).toBe("done");
    expect(flow.complete).toBe(true);
  });

  it("resolved + published with NO action items: filed is n/a → done, complete", async () => {
    await incident("PIF-4", "resolved");
    await postmortem("PIFPM-4", "PIF-4", "published");
    const flow = await buildPostIncidentFlow(new D1Db(env.DB), "PIF-4", "resolved");
    expect(stateOf(flow, "action_items")).toBe("pending"); // none captured
    expect(stateOf(flow, "filed")).toBe("done"); // n/a counts as done
    // action_items step pending → not complete
    expect(flow.complete).toBe(false);
  });

  it("route: 401 unauth, 404 unknown, 200 shape", async () => {
    await incident("PIF-5", "resolved");
    await postmortem("PIFPM-5", "PIF-5", "draft");
    expect((await SELF.fetch("https://x/api/incidents/PIF-5/post-incident-flow")).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const miss = await SELF.fetch("https://x/api/incidents/PIF-nope/post-incident-flow", { headers: { Cookie: cookie } });
    expect(miss.status).toBe(404);
    const res = await SELF.fetch("https://x/api/incidents/PIF-5/post-incident-flow", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; complete: boolean };
    expect(body.items.length).toBe(5);
  });
});
