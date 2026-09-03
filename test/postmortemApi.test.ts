import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setPostmortemSummarizer } from "../src/postmortem/service";
import { __setJointResolveSlackClient, requestResolve, confirmResolve } from "../src/incidents/jointResolve";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";
import type { PostmortemWithItems } from "../src/postmortem/types";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function cookie() {
  const s = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
  return `${SESSION_COOKIE}=${await signSession(s, SECRET)}`;
}
function req(method: string, path: string, c: string | null, body?: unknown) {
  return SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(c ? { Cookie: c } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function channelOf(incidentId: string): Promise<string> {
  const row = await new D1Db(env.DB).get<{ channel: string }>(
    "SELECT channel FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row?.channel ?? "";
}

async function declareAndResolve(c: string): Promise<string> {
  const d = (await (await req("POST", "/api/incidents", c, { name: "Checkout 500s" })).json()) as {
    incidentId: string;
  };
  await req("POST", `/api/incidents/${d.incidentId}/updates`, c, {
    body: "Rolling back the bad deploy",
    status: "identified",
  });
  // Joint sign-off resolve driven in-isolate (SELF.fetch's waitUntil resolve is
  // not reliably visible to env.DB — see project.incident.workers_pool_limits).
  const channel = await channelOf(d.incidentId);
  await requestResolve(env as any, d.incidentId, channel, "U_ENG", "Fixed");
  await confirmResolve(env as any, d.incidentId, "U_SUPPORT");
  return d.incidentId;
}

describe("post-mortem API", () => {
  beforeEach(() => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(true),
      summarizer: () => new FakeSummarizer(true),
    });
    __setPostmortemSummarizer(() => new FakeSummarizer());
    __setJointResolveSlackClient(() => new FakeSlackClient(false));
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setPostmortemSummarizer(undefined);
    __setJointResolveSlackClient(undefined);
    for (const t of ["incident_resolution_requests", "postmortem_action_items", "postmortems", "incident_roles", "incident_updates", "incidents", "incident_channels"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("gates all post-mortem routes behind a session", async () => {
    expect((await req("GET", "/api/incidents/x/postmortem", null)).status).toBe(401);
    expect((await req("POST", "/api/incidents/x/postmortem", null)).status).toBe(401);
    expect((await req("POST", "/api/incidents/x/postmortem/publish", null)).status).toBe(401);
    expect((await req("POST", "/api/postmortem-action-items/x", null)).status).toBe(401);
  });

  it("auto-drafts a post-mortem when an incident resolves", async () => {
    const c = await cookie();
    const id = await declareAndResolve(c);
    const res = await req("GET", `/api/incidents/${id}/postmortem`, c);
    expect(res.status).toBe(200);
    const pm = (await res.json()) as PostmortemWithItems;
    expect(pm.status).toBe("draft");
    expect(pm.summary).toContain("Post-mortem draft");
    expect(pm.action_items.length).toBeGreaterThan(0);
  });

  it("regenerates the draft on POST", async () => {
    const c = await cookie();
    const id = await declareAndResolve(c);
    const res = await req("POST", `/api/incidents/${id}/postmortem`, c);
    expect(res.status).toBe(200);
    const pm = (await res.json()) as PostmortemWithItems;
    expect(pm.status).toBe("draft");
  });

  it("saves human edits on PUT", async () => {
    const c = await cookie();
    const id = await declareAndResolve(c);
    const res = await req("PUT", `/api/incidents/${id}/postmortem`, c, {
      summary: "Human-written summary",
      impact: "Edited impact",
      root_cause: "Edited cause",
      contributing_factors: "Edited factors",
      action_items: ["Do the thing"],
    });
    expect(res.status).toBe(200);
    const pm = (await res.json()) as PostmortemWithItems;
    expect(pm.summary).toBe("Human-written summary");
    expect(pm.action_items).toHaveLength(1);
  });

  it("toggles an action item and publishes", async () => {
    const c = await cookie();
    const id = await declareAndResolve(c);
    const pm = (await (await req("GET", `/api/incidents/${id}/postmortem`, c)).json()) as PostmortemWithItems;

    const toggle = await req("POST", `/api/postmortem-action-items/${pm.action_items[0].id}`, c, { done: true });
    expect(toggle.status).toBe(200);

    const pub = await req("POST", `/api/incidents/${id}/postmortem/publish`, c);
    expect(pub.status).toBe(200);

    const after = (await (await req("GET", `/api/incidents/${id}/postmortem`, c)).json()) as PostmortemWithItems;
    expect(after.status).toBe("published");
    expect(after.action_items[0].done).toBe(true);
  });

  it("404s when no post-mortem exists", async () => {
    const c = await cookie();
    expect((await req("GET", "/api/incidents/nope/postmortem", c)).status).toBe(404);
  });
});
