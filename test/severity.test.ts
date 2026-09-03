import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setJointResolveSlackClient } from "../src/incidents/jointResolve";
import { declareIncident } from "../src/incidents/commands";
import { setSeverity } from "../src/incidents/severity";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";

const TEAM = "T_E2E";
const SECRET = "e2e-signing-secret";

async function cookie() {
  return `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
}

describe("incident severity", () => {
  const created: string[] = [];
  async function declare(name: string, body?: string, severity?: string) {
    const r = await declareIncident(env as any, name, body, severity as any);
    created.push(r.incidentId);
    return r;
  }

  beforeEach(() => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(false),
      summarizer: () => new FakeSummarizer(),
    });
    __setJointResolveSlackClient(() => new FakeSlackClient(false));
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setJointResolveSlackClient(undefined);
    for (const id of created.splice(0)) {
      await env.DB.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
    }
  });

  it("defaults to sev2 on declare", async () => {
    const { incidentId } = await declare("No severity given");
    const row = await new D1Db(env.DB).get<{ severity: string }>(
      "SELECT severity FROM incidents WHERE id = ?",
      [incidentId],
    );
    expect(row?.severity).toBe("sev2");
  });

  it("honours a severity passed at declare", async () => {
    const { incidentId } = await declare("Major outage", undefined, "sev1");
    const row = await new D1Db(env.DB).get<{ severity: string }>(
      "SELECT severity FROM incidents WHERE id = ?",
      [incidentId],
    );
    expect(row?.severity).toBe("sev1");
  });

  it("setSeverity changes it and records a timeline event", async () => {
    const { incidentId } = await declare("Bump me");
    const ok = await setSeverity(env as any, incidentId, "sev1");
    expect(ok).toBe(true);

    const row = await new D1Db(env.DB).get<{ severity: string }>(
      "SELECT severity FROM incidents WHERE id = ?",
      [incidentId],
    );
    expect(row?.severity).toBe("sev1");

    const upd = await new D1Db(env.DB).get<{ body: string }>(
      "SELECT body FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC LIMIT 1",
      [incidentId],
    );
    expect(upd?.body).toContain("Severity set to");
  });

  it("setSeverity returns false for an unknown incident", async () => {
    expect(await setSeverity(env as any, "nope", "sev1")).toBe(false);
  });

  it("PUT /severity validates and gates", async () => {
    const { incidentId } = await declare("Via API");
    const c = await cookie();

    // unauth
    const un = await SELF.fetch(`https://x/api/incidents/${incidentId}/severity`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ severity: "sev1" }),
    });
    expect(un.status).toBe(401);

    // invalid value
    const bad = await SELF.fetch(`https://x/api/incidents/${incidentId}/severity`, {
      method: "PUT",
      headers: { "content-type": "application/json", Cookie: c },
      body: JSON.stringify({ severity: "sev9" }),
    });
    expect(bad.status).toBe(400);

    // valid
    const ok = await SELF.fetch(`https://x/api/incidents/${incidentId}/severity`, {
      method: "PUT",
      headers: { "content-type": "application/json", Cookie: c },
      body: JSON.stringify({ severity: "sev3" }),
    });
    expect(ok.status).toBe(200);
  });
});
