import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { declareIncident } from "../src/incidents/commands";
import {
  __setControlsSlackClient,
  handleControlAction,
  submitControlModal,
  controlsBlocks,
  CONTROL_UPDATE_ACTION,
  CONTROL_STATUS_ACTION,
  CONTROL_ESCALATE_ACTION,
  CONTROL_SEVERITY_ACTION,
  CONTROL_RESOLVE_ACTION,
  UPDATE_MODAL_CALLBACK,
  STATUS_MODAL_CALLBACK,
  ESCALATE_MODAL_CALLBACK,
  SEVERITY_MODAL_CALLBACK,
} from "../src/incidents/controls";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { __setJointResolveSlackClient } from "../src/incidents/jointResolve";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

function wire(fake: FakeSlackClient) {
  __setControlsSlackClient(() => fake);
  __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
  __setRolesSlackClient(() => fake);
  __setStakeholderSlackClient(() => fake);
  __setJointResolveSlackClient(() => fake);
}
function unwire() {
  __setControlsSlackClient(undefined);
  __resetIncidentClientOverrides();
  __setRolesSlackClient(undefined);
  __setStakeholderSlackClient(undefined);
  __setJointResolveSlackClient(undefined);
}

async function updates(incidentId: string) {
  return new D1Db(env.DB).all<{ body: string; status: string }>(
    "SELECT body, status FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    [incidentId],
  );
}
function submission(callbackId: string, incidentId: string, values: Record<string, Record<string, unknown>>) {
  return {
    user: { id: "U_ACTOR" },
    view: { callback_id: callbackId, private_metadata: incidentId, state: { values } },
  } as unknown as Parameters<typeof submitControlModal>[1];
}

describe("incident controls panel", () => {
  let fake: FakeSlackClient;
  beforeEach(() => {
    fake = new FakeSlackClient(false);
    wire(fake);
  });
  afterEach(async () => {
    unwire();
    for (const t of ["incident_resolution_requests", "incident_updates", "incident_roles", "incidents", "incident_channels"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("declare posts a controls panel to the incident channel", async () => {
    const { channelId } = await declareIncident(env as any, "CTL Checkout down");
    const panel = fake.postedBlocks.find(
      (b) => b.channel === channelId && b.text.includes("Incident controls"),
    );
    expect(panel).toBeTruthy();
    // Five buttons.
    const blocks = controlsBlocks() as any[];
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements).toHaveLength(5);
  });

  it("update/status/escalate/severity buttons open the matching modal", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "CTL modal open");
    fake.openedViews.length = 0;

    for (const [action] of [
      [CONTROL_UPDATE_ACTION, UPDATE_MODAL_CALLBACK],
      [CONTROL_STATUS_ACTION, STATUS_MODAL_CALLBACK],
      [CONTROL_ESCALATE_ACTION, ESCALATE_MODAL_CALLBACK],
      [CONTROL_SEVERITY_ACTION, SEVERITY_MODAL_CALLBACK],
    ] as const) {
      const handled = await handleControlAction(env as any, action, incidentId, channelId, "U_ACTOR", "T_TRIG");
      expect(handled).toBe(true);
    }
    const callbacks = fake.openedViews.map((v) => (v.view as any).callback_id);
    expect(callbacks).toEqual([
      UPDATE_MODAL_CALLBACK,
      STATUS_MODAL_CALLBACK,
      ESCALATE_MODAL_CALLBACK,
      SEVERITY_MODAL_CALLBACK,
    ]);
    // Each modal carries the incident id in private_metadata.
    expect((fake.openedViews[0].view as any).private_metadata).toBe(incidentId);
  });

  it("Request resolve button records a resolution request (joint sign-off)", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "CTL resolve");
    await handleControlAction(env as any, CONTROL_RESOLVE_ACTION, incidentId, channelId, "U_REQ", "T_TRIG");
    const req = await new D1Db(env.DB).get<{ requested_by: string }>(
      "SELECT requested_by FROM incident_resolution_requests WHERE incident_id = ?",
      [incidentId],
    );
    expect(req?.requested_by).toBe("U_REQ");
  });

  it("update modal submission posts an update", async () => {
    const { incidentId } = await declareIncident(env as any, "CTL update");
    const handled = await submitControlModal(
      env as any,
      submission(UPDATE_MODAL_CALLBACK, incidentId, {
        u_body_b: { u_body_a: { value: "rolled back deploy" } },
      }),
    );
    expect(handled).toBe(true);
    expect((await updates(incidentId)).some((u) => u.body.includes("rolled back deploy"))).toBe(true);
  });

  it("status modal submission advances the lifecycle with the note", async () => {
    const { incidentId } = await declareIncident(env as any, "CTL status");
    await submitControlModal(
      env as any,
      submission(STATUS_MODAL_CALLBACK, incidentId, {
        s_sel_b: { s_sel_a: { selected_option: { value: "identified" } } },
        s_note_b: { s_note_a: { value: "found the cause" } },
      }),
    );
    const advancing = (await updates(incidentId)).find((u) => u.status === "identified");
    expect(advancing).toBeTruthy();
    expect(advancing!.body).toContain("found the cause");
  });

  it("severity modal submission changes the incident severity", async () => {
    const { incidentId } = await declareIncident(env as any, "CTL severity");
    await submitControlModal(
      env as any,
      submission(SEVERITY_MODAL_CALLBACK, incidentId, {
        v_sel_b: { v_sel_a: { selected_option: { value: "sev1" } } },
      }),
    );
    const inc = await new D1Db(env.DB).get<{ severity: string }>(
      "SELECT severity FROM incidents WHERE id = ?",
      [incidentId],
    );
    expect(inc?.severity).toBe("sev1");
  });

  it("escalate modal submission DMs the target and notes in-channel", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "CTL escalate");
    fake.posted.length = 0;
    await submitControlModal(
      env as any,
      submission(ESCALATE_MODAL_CALLBACK, incidentId, {
        e_user_b: { e_user_a: { selected_user: "U_DEV" } },
        e_msg_b: { e_msg_a: { value: "need eyes" } },
      }),
    );
    expect(fake.posted.some((p) => p.channel === "U_DEV" && p.text.includes("need eyes"))).toBe(true);
    expect(fake.posted.some((p) => p.channel === channelId && p.text.includes("<@U_DEV>"))).toBe(true);
  });

  it("submitControlModal ignores a foreign callback_id", async () => {
    const handled = await submitControlModal(
      env as any,
      submission("some_other_modal", "INC-999", {}),
    );
    expect(handled).toBe(false);
  });
});
