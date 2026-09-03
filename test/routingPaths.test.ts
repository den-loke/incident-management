import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import { InternalStatusSink } from "../src/status/internalSink";
import { D1Db } from "../src/status/d1";
import { rolesForPath, rolesBlocks } from "../src/roles/service";
import { declareIncident } from "../src/incidents/commands";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setControlsSlackClient } from "../src/incidents/controls";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const TEAM = "T_E2E";
const SECRET = "e2e-signing-secret";

const RP_NAMES = ["A", "B", "Upstream POS down", "Checkout 500s", "Partner outage"];

async function cleanIncidents() {
  // Scoped cleanup (shared D1): only this file's rows — by id prefix or name.
  const ph = RP_NAMES.map(() => "?").join(",");
  const ids = await env.DB.prepare(
    `SELECT id FROM incidents WHERE id LIKE 'INC-rp-%' OR name IN (${ph})`,
  ).bind(...RP_NAMES).all<{ id: string }>();
  for (const { id } of ids.results ?? []) {
    await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
  }
}

describe("routing paths — model", () => {
  afterEach(cleanIncidents);

  it("openIncident persists routing_path (default internal)", async () => {
    const sink = new InternalStatusSink(new D1Db(env.DB));
    const a = await sink.openIncident({ id: "INC-rp-1", name: "A" });
    const b = await sink.openIncident({ id: "INC-rp-2", name: "B", routingPath: "external" });
    expect(a.routing_path).toBe("internal");
    expect(b.routing_path).toBe("external");
    const row = await env.DB.prepare("SELECT routing_path FROM incidents WHERE id = ?")
      .bind("INC-rp-2").first<{ routing_path: string }>();
    expect(row?.routing_path).toBe("external");
  });

  it("rolesForPath: internal = both roles, external = Support Lead only", () => {
    expect(rolesForPath("internal")).toEqual(["engineering_lead", "customer_support_lead"]);
    expect(rolesForPath("external")).toEqual(["customer_support_lead"]);
  });

  it("rolesBlocks for external offers only one Take button", () => {
    const blocks = rolesBlocks({}, rolesForPath("external")) as any[];
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements[0].value).toBe("customer_support_lead");
  });
});

describe("routing paths — declare", () => {
  let fake: FakeSlackClient;
  beforeEach(() => {
    fake = new FakeSlackClient(false);
    __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
    __setRolesSlackClient(() => fake);
    __setControlsSlackClient(() => fake);
    __setStakeholderSlackClient(() => fake);
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setRolesSlackClient(undefined);
    __setControlsSlackClient(undefined);
    __setStakeholderSlackClient(undefined);
    await cleanIncidents();
  });

  it("external declare posts a roles panel with only the Support Lead button", async () => {
    const { incidentId } = await declareIncident(env as any, "Upstream POS down", undefined, "sev2", "external");
    const row = await env.DB.prepare("SELECT routing_path FROM incidents WHERE id = ?")
      .bind(incidentId).first<{ routing_path: string }>();
    expect(row?.routing_path).toBe("external");
    // Roles panel: find the postBlocks whose blocks have an actions block.
    const panel = fake.postedBlocks.find((b) =>
      (b.blocks as any[]).some((blk) => blk.type === "actions"),
    );
    const actions = (panel!.blocks as any[]).find((blk) => blk.type === "actions");
    // Only the Support-Lead Take button (no Engineering Lead) for external.
    const claimBtns = actions.elements.filter((e: any) => String(e.action_id).startsWith("claim_role:"));
    expect(claimBtns).toHaveLength(1);
    expect(claimBtns[0].value).toBe("customer_support_lead");
  });

  it("internal declare (default) offers both role buttons", async () => {
    const { incidentId } = await declareIncident(env as any, "Checkout 500s");
    const row = await env.DB.prepare("SELECT routing_path FROM incidents WHERE id = ?")
      .bind(incidentId).first<{ routing_path: string }>();
    expect(row?.routing_path).toBe("internal");
    const panel = fake.postedBlocks.find((b) =>
      (b.blocks as any[]).some((blk) => blk.type === "actions"),
    );
    const actions = (panel!.blocks as any[]).find((blk) => blk.type === "actions");
    const claimBtns = actions.elements.filter((e: any) => String(e.action_id).startsWith("claim_role:"));
    expect(claimBtns).toHaveLength(2);
  });
});

describe("routing paths — web API", () => {
  beforeEach(() => {
    __setIncidentClientOverrides({ slack: () => new FakeSlackClient(false), summarizer: () => new FakeSummarizer() });
    __setRolesSlackClient(() => new FakeSlackClient(false));
    __setControlsSlackClient(() => new FakeSlackClient(false));
    __setStakeholderSlackClient(() => new FakeSlackClient(false));
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setRolesSlackClient(undefined);
    __setControlsSlackClient(undefined);
    __setStakeholderSlackClient(undefined);
    await cleanIncidents();
  });

  it("POST /api/incidents accepts routing_path and persists it", async () => {
    const cookie = `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U1", team_id: TEAM, name: "Den" }), SECRET)}`;
    const res = await SELF.fetch("https://example.com/api/incidents", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Partner outage", routing_path: "external" }),
    });
    expect(res.status).toBe(201);
    const { incidentId } = (await res.json()) as { incidentId: string };
    const row = await env.DB.prepare("SELECT routing_path FROM incidents WHERE id = ?")
      .bind(incidentId).first<{ routing_path: string }>();
    expect(row?.routing_path).toBe("external");
  });
});
