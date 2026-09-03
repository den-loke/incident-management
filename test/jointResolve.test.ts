import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import {
  __setJointResolveSlackClient,
  requestResolve,
  confirmResolve,
  getResolutionRequest,
} from "../src/incidents/jointResolve";
import { __setPostmortemSummarizer } from "../src/postmortem/service";
import { declareIncident } from "../src/incidents/commands";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";
import { PostmortemStore } from "../src/postmortem/store";

async function channelOf(incidentId: string): Promise<string> {
  const row = await new D1Db(env.DB).get<{ channel: string }>(
    "SELECT channel FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row?.channel ?? "";
}

describe("joint sign-off resolve", () => {
  beforeEach(() => {
    __setIncidentClientOverrides({
      slack: () => new FakeSlackClient(false),
      summarizer: () => new FakeSummarizer(),
    });
    __setJointResolveSlackClient(() => new FakeSlackClient(false));
    __setPostmortemSummarizer(() => new FakeSummarizer());
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setJointResolveSlackClient(undefined);
    __setPostmortemSummarizer(undefined);
    for (const t of ["incident_resolution_requests", "postmortem_action_items", "postmortems", "incident_roles", "incident_updates", "incidents", "incident_channels"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  async function declare(name = "Joint resolve incident") {
    const { incidentId } = await declareIncident(env as any, name);
    return incidentId;
  }

  it("records a pending request and does not resolve yet", async () => {
    const id = await declare();
    const ch = await channelOf(id);
    await requestResolve(env as any, id, ch, "U_ENG", "believed fixed");

    const pending = await getResolutionRequest(env as any, id);
    expect(pending?.requested_by).toBe("U_ENG");
    expect(pending?.note).toBe("believed fixed");

    const inc = await new D1Db(env.DB).get<{ status: string }>(
      "SELECT status FROM incidents WHERE id = ?",
      [id],
    );
    expect(inc?.status).not.toBe("resolved");
  });

  it("confirm by a different person resolves + auto-drafts the post-mortem", async () => {
    const id = await declare();
    const ch = await channelOf(id);
    await requestResolve(env as any, id, ch, "U_ENG", "believed fixed");

    const outcome = await confirmResolve(env as any, id, "U_SUPPORT");
    expect(outcome.ok).toBe(true);

    const inc = await new D1Db(env.DB).get<{ status: string; resolved_at: string | null }>(
      "SELECT status, resolved_at FROM incidents WHERE id = ?",
      [id],
    );
    expect(inc?.status).toBe("resolved");
    expect(inc?.resolved_at).not.toBeNull();

    // Auto-draft ran on resolve.
    const pm = await new PostmortemStore(new D1Db(env.DB)).get(id);
    expect(pm?.status).toBe("draft");

    // The pending request is now confirmed (no longer open).
    expect(await getResolutionRequest(env as any, id)).toBeNull();
  });

  it("refuses confirm by the same person who requested", async () => {
    const id = await declare();
    const ch = await channelOf(id);
    await requestResolve(env as any, id, ch, "U_ENG");
    expect(await confirmResolve(env as any, id, "U_ENG")).toEqual({
      ok: false,
      reason: "same_person",
    });
    const inc = await new D1Db(env.DB).get<{ status: string }>(
      "SELECT status FROM incidents WHERE id = ?",
      [id],
    );
    expect(inc?.status).not.toBe("resolved");
  });

  it("refuses confirm when there is no open request", async () => {
    const id = await declare();
    expect(await confirmResolve(env as any, id, "U_SUPPORT")).toEqual({
      ok: false,
      reason: "no_request",
    });
  });
});
