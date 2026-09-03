import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setJointResolveSlackClient, confirmResolve } from "../src/incidents/jointResolve";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function authedCookie() {
  const session = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
  return `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;
}

function post(path: string, cookie: string | null, body: unknown) {
  return SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("incident management API", () => {
  beforeEach(() => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(true),
      summarizer: () => new FakeSummarizer(true),
    });
    __setJointResolveSlackClient(() => new FakeSlackClient(false));
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setJointResolveSlackClient(undefined);
    for (const t of ["incident_resolution_requests", "postmortem_action_items", "postmortems", "incident_roles", "incident_updates", "incidents", "incident_channels"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("rejects unauthenticated writes with 401", async () => {
    expect((await post("/api/incidents", null, { name: "X" })).status).toBe(401);
    expect((await post("/api/incidents/inc_1/updates", null, { body: "y" })).status).toBe(401);
    expect((await post("/api/incidents/inc_1/resolve", null, {})).status).toBe(401);
  });

  it("validates required fields", async () => {
    const cookie = await authedCookie();
    expect((await post("/api/incidents", cookie, {})).status).toBe(400);
    expect((await post("/api/incidents", cookie, { name: "   " })).status).toBe(400);
  });

  it("declares an incident and persists it to D1", async () => {
    const cookie = await authedCookie();
    const res = await post("/api/incidents", cookie, {
      name: "Checkout 500s",
      body: "Elevated 500s on /checkout",
    });
    expect(res.status).toBe(201);
    const { incidentId, channelId } = (await res.json()) as {
      incidentId: string;
      channelId: string;
    };
    expect(incidentId).toMatch(/^inc_/);
    expect(channelId).toBeTruthy();

    const row = await env.DB.prepare("SELECT * FROM incidents WHERE id = ?")
      .bind(incidentId)
      .first<{ name: string; status: string }>();
    expect(row?.name).toBe("Checkout 500s");
    expect(row?.status).toBe("investigating");

    const map = await env.DB.prepare(
      "SELECT incident_id FROM incident_channels WHERE incident_id = ?",
    )
      .bind(incidentId)
      .first<{ incident_id: string }>();
    expect(map?.incident_id).toBe(incidentId);
  });

  it("posts an update advancing status", async () => {
    const cookie = await authedCookie();
    const declared = (await (
      await post("/api/incidents", cookie, { name: "DB latency" })
    ).json()) as { incidentId: string };

    const res = await post(`/api/incidents/${declared.incidentId}/updates`, cookie, {
      body: "Root cause found",
      status: "identified",
    });
    expect(res.status).toBe(200);

    const inc = await env.DB.prepare("SELECT status FROM incidents WHERE id = ?")
      .bind(declared.incidentId)
      .first<{ status: string }>();
    expect(inc?.status).toBe("identified");
  });

  it("rejects an update with no body", async () => {
    const cookie = await authedCookie();
    const declared = (await (
      await post("/api/incidents", cookie, { name: "X" })
    ).json()) as { incidentId: string };
    const res = await post(`/api/incidents/${declared.incidentId}/updates`, cookie, {});
    expect(res.status).toBe(400);
  });

  it("requests resolve via API, then a different person confirms to resolve", async () => {
    const cookie = await authedCookie();
    const declared = (await (
      await post("/api/incidents", cookie, { name: "Outage" })
    ).json()) as { incidentId: string };

    // Web resolve now REQUESTS (joint sign-off) — incident stays open.
    const res = await post(`/api/incidents/${declared.incidentId}/resolve`, cookie, {
      body: "All clear",
    });
    expect(res.status).toBe(200);
    let inc = await env.DB.prepare("SELECT status FROM incidents WHERE id = ?")
      .bind(declared.incidentId)
      .first<{ status: string }>();
    expect(inc?.status).not.toBe("resolved");

    // A DIFFERENT person confirms (in-isolate; SELF waitUntil resolve isn't
    // reliably visible to env.DB — see project.incident.workers_pool_limits).
    const outcome = await confirmResolve(env as any, declared.incidentId, "web:U_OTHER");
    expect(outcome.ok).toBe(true);
    inc = await env.DB.prepare("SELECT status, resolved_at FROM incidents WHERE id = ?")
      .bind(declared.incidentId)
      .first<{ status: string; resolved_at: string | null }>() as any;
    expect(inc?.status).toBe("resolved");
    expect((inc as any)?.resolved_at).not.toBeNull();
  });
});
