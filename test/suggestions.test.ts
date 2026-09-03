import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordSuggestion, applyReaction } from "../src/incidents/suggestions";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import {
  requestResolve,
  getResolutionRequest,
  __setJointResolveSlackClient,
} from "../src/incidents/jointResolve";
import { __setPostmortemSummarizer } from "../src/postmortem/service";
import { declareIncident } from "../src/incidents/commands";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";

// A standalone seeded incident id for the pure-dispatch (no-DO) cases.
const INC = "inc_sug_test";
const CH = "C_sug_test";
const created: string[] = [];

async function channelOf(incidentId: string): Promise<string> {
  const row = await new D1Db(env.DB).get<{ channel: string }>(
    "SELECT channel FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row?.channel ?? "";
}

async function clean() {
  const ids = [INC, ...created];
  for (const id of ids) {
    await env.DB.prepare("DELETE FROM incident_suggestions WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_resolution_requests WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM postmortem_action_items WHERE postmortem_id IN (SELECT id FROM postmortems WHERE incident_id = ?)").bind(id).run();
    await env.DB.prepare("DELETE FROM postmortems WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
  }
  created.length = 0;
}

describe("emoji accept/reject on suggestions", () => {
  beforeEach(async () => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(false),
      summarizer: () => new FakeSummarizer(),
    });
    __setJointResolveSlackClient(() => new FakeSlackClient(false));
    __setPostmortemSummarizer(() => new FakeSummarizer());
    await clean();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO incidents (id, name, status, severity) VALUES (?, 'Suggestion test', 'investigating', 'sev2')",
    ).bind(INC).run();
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setJointResolveSlackClient(undefined);
    __setPostmortemSummarizer(undefined);
    await clean();
  });

  it("ignores a reaction on a message that is not a tracked suggestion", async () => {
    const out = await applyReaction(env as any, CH, "9999.0001", "white_check_mark", "U_someone");
    expect(out).toEqual({ result: "ignored", reason: "not_a_suggestion" });
  });

  it("ignores an unknown emoji on a tracked suggestion", async () => {
    await recordSuggestion(env as any, {
      incidentId: INC, channel: CH, ts: "111.1", kind: "confirm_resolve", payload: { requestedBy: "U_req" },
    });
    const out = await applyReaction(env as any, CH, "111.1", "eyes", "U_other");
    expect(out.result).toBe("ignored");
  });

  it("first reaction wins — a second decision is ignored", async () => {
    await recordSuggestion(env as any, {
      incidentId: INC, channel: CH, ts: "222.2", kind: "confirm_resolve", payload: { requestedBy: "U_req" },
    });
    // Accept it (dispatch calls confirmResolve; no resolve request exists so it's a
    // no-op 'no_request', but the suggestion is still claimed 'accepted').
    const first = await applyReaction(env as any, CH, "222.2", "white_check_mark", "U_first");
    expect(first.result).toBe("accepted");
    const second = await applyReaction(env as any, CH, "222.2", "x", "U_second");
    expect(second).toEqual({ result: "ignored", reason: "not_a_suggestion" });
  });

  it("✅ on a real confirm_resolve suggestion confirms the joint sign-off", async () => {
    // Declare a REAL incident so the DO exists and confirmResolve's resolve works.
    const { incidentId } = await declareIncident(env as any, "Confirm via emoji");
    created.push(incidentId);
    const channel = await channelOf(incidentId);

    await requestResolve(env as any, incidentId, channel, "U_requester", "wrapping up");
    const sug = await env.DB.prepare(
      "SELECT ts FROM incident_suggestions WHERE incident_id = ? AND kind = 'confirm_resolve'",
    ).bind(incidentId).first<{ ts: string }>();
    expect(sug?.ts).toBeTruthy();

    const out = await applyReaction(env as any, channel, sug!.ts, "white_check_mark", "U_confirmer");
    expect(out).toEqual({ result: "accepted", kind: "confirm_resolve" });

    // Confirm succeeded → request is no longer pending and the incident resolved.
    const req = await getResolutionRequest(env as any, incidentId);
    expect(req).toBeNull();
    const inc = await env.DB.prepare("SELECT status FROM incidents WHERE id = ?")
      .bind(incidentId).first<{ status: string }>();
    expect(inc?.status).toBe("resolved");
  });

  it("❌ marks the suggestion rejected and does not confirm", async () => {
    const { incidentId } = await declareIncident(env as any, "Reject via emoji");
    created.push(incidentId);
    const channel = await channelOf(incidentId);

    await requestResolve(env as any, incidentId, channel, "U_requester");
    const sug = await env.DB.prepare(
      "SELECT ts FROM incident_suggestions WHERE incident_id = ? AND kind = 'confirm_resolve'",
    ).bind(incidentId).first<{ ts: string }>();

    const out = await applyReaction(env as any, channel, sug!.ts, "x", "U_rejecter");
    expect(out).toEqual({ result: "rejected", kind: "confirm_resolve" });

    const req = await getResolutionRequest(env as any, incidentId);
    expect(req?.confirmed_by ?? null).toBeNull();
    const row = await env.DB.prepare(
      "SELECT status FROM incident_suggestions WHERE incident_id = ?",
    ).bind(incidentId).first<{ status: string }>();
    expect(row?.status).toBe("rejected");
  });
});
