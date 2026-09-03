/// <reference types="@cloudflare/workers-types" />
// Incident controls panel — every incident action as a Slack button/modal, so
// slash commands are OPTIONAL rather than the primary interface. Posted to the
// incident channel on declare, alongside the roles panel. Requested 2026-09-03.
//
// Text-entry actions (update, escalate) open a modal (views.open) — the same
// view_submission pattern the declare modal uses — so nothing needs typing in
// channel. Every action routes through the SHARED command functions
// (postIncidentUpdate / setSeverity / requestResolve), so Slack buttons, slash
// commands, and the web UI all drive one path. One fixed button set — not a
// configurable action builder.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import { postIncidentUpdate } from "./commands";
import { requestResolve } from "./jointResolve";
import { setSeverity } from "./severity";
import {
  INCIDENT_SEVERITIES,
  SEVERITY_LABEL,
  type IncidentSeverity,
  type IncidentStatus,
} from "../status/types";

// Test/bypass seam mirroring the roles/stakeholder services.
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setControlsSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

// --- Button action_ids (block_actions) ---
export const CONTROL_UPDATE_ACTION = "inc_ctl_update";
export const CONTROL_STATUS_ACTION = "inc_ctl_status";
export const CONTROL_ESCALATE_ACTION = "inc_ctl_escalate";
export const CONTROL_RESOLVE_ACTION = "inc_ctl_resolve";
export const CONTROL_SEVERITY_ACTION = "inc_ctl_severity";

export const CONTROL_ACTION_IDS = [
  CONTROL_UPDATE_ACTION,
  CONTROL_STATUS_ACTION,
  CONTROL_ESCALATE_ACTION,
  CONTROL_RESOLVE_ACTION,
  CONTROL_SEVERITY_ACTION,
];

// --- Modal callback_ids (view_submission) ---
export const UPDATE_MODAL_CALLBACK = "inc_update_modal";
export const STATUS_MODAL_CALLBACK = "inc_status_modal";
export const ESCALATE_MODAL_CALLBACK = "inc_escalate_modal";
export const SEVERITY_MODAL_CALLBACK = "inc_severity_modal";

export const CONTROL_MODAL_CALLBACKS = [
  UPDATE_MODAL_CALLBACK,
  STATUS_MODAL_CALLBACK,
  ESCALATE_MODAL_CALLBACK,
  SEVERITY_MODAL_CALLBACK,
];

// Settable lifecycle statuses (resolved is intentionally EXCLUDED — that's the
// two-person joint-resolve flow, surfaced via the Request resolve button).
const SETTABLE_STATUSES: Exclude<IncidentStatus, "resolved">[] = [
  "investigating",
  "identified",
  "monitoring",
];
const STATUS_LABEL: Record<Exclude<IncidentStatus, "resolved">, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
};

/** The controls panel Block Kit. `channelId` is carried in each button value so
 * the interactivity handler can resolve the incident without a channel lookup. */
export function controlsBlocks(): unknown[] {
  const btn = (text: string, action_id: string, style?: "primary" | "danger") => ({
    type: "button",
    text: { type: "plain_text", text },
    action_id,
    ...(style ? { style } : {}),
  });
  return [
    { type: "section", text: { type: "mrkdwn", text: "*Incident controls*" } },
    {
      type: "actions",
      elements: [
        btn("Post update", CONTROL_UPDATE_ACTION),
        btn("Change status", CONTROL_STATUS_ACTION),
        btn("Escalate", CONTROL_ESCALATE_ACTION),
        btn("Change severity", CONTROL_SEVERITY_ACTION),
        btn("Request resolve", CONTROL_RESOLVE_ACTION, "danger"),
      ],
    },
  ];
}

/** Post the controls panel to an incident channel (best-effort). */
export async function postControlsPanel(env: Env, channelId: string): Promise<void> {
  await buildSlack(env).postBlocks(
    channelId,
    "Incident controls: post update · change status · escalate · change severity · request resolve",
    controlsBlocks(),
  );
}

// --- Modal views. Each carries the incident id in private_metadata so the
// submission handler needs no channel lookup. ---

function textInput(blockId: string, actionId: string, label: string, placeholder: string, multiline = true) {
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: actionId,
      multiline,
      placeholder: { type: "plain_text", text: placeholder },
    },
  };
}

const UPDATE_BODY_BLOCK = "u_body_b";
const UPDATE_BODY_ACTION = "u_body_a";
const STATUS_SELECT_BLOCK = "s_sel_b";
const STATUS_SELECT_ACTION = "s_sel_a";
const STATUS_NOTE_BLOCK = "s_note_b";
const STATUS_NOTE_ACTION = "s_note_a";
const ESCALATE_USER_BLOCK = "e_user_b";
const ESCALATE_USER_ACTION = "e_user_a";
const ESCALATE_MSG_BLOCK = "e_msg_b";
const ESCALATE_MSG_ACTION = "e_msg_a";
const SEV_SELECT_BLOCK = "v_sel_b";
const SEV_SELECT_ACTION = "v_sel_a";
const RESOLVE_NOTE_BLOCK = "r_note_b";
const RESOLVE_NOTE_ACTION = "r_note_a";

function modal(callbackId: string, title: string, submit: string, incidentId: string, blocks: unknown[]) {
  return {
    type: "modal",
    callback_id: callbackId,
    private_metadata: incidentId,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: submit },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

export function updateModalView(incidentId: string): unknown {
  return modal(UPDATE_MODAL_CALLBACK, "Post update", "Post", incidentId, [
    textInput(UPDATE_BODY_BLOCK, UPDATE_BODY_ACTION, "What changed?", "Rolled back the deploy…"),
  ]);
}

export function statusModalView(incidentId: string): unknown {
  return modal(STATUS_MODAL_CALLBACK, "Change status", "Update", incidentId, [
    {
      type: "input",
      block_id: STATUS_SELECT_BLOCK,
      label: { type: "plain_text", text: "Status" },
      element: {
        type: "static_select",
        action_id: STATUS_SELECT_ACTION,
        options: SETTABLE_STATUSES.map((s) => ({
          text: { type: "plain_text", text: STATUS_LABEL[s] },
          value: s,
        })),
      },
    },
    { ...textInput(STATUS_NOTE_BLOCK, STATUS_NOTE_ACTION, "Note (optional)", "Optional detail…"), optional: true },
  ]);
}

export function escalateModalView(incidentId: string): unknown {
  return modal(ESCALATE_MODAL_CALLBACK, "Escalate", "Page", incidentId, [
    {
      type: "input",
      block_id: ESCALATE_USER_BLOCK,
      label: { type: "plain_text", text: "Who to page" },
      element: { type: "users_select", action_id: ESCALATE_USER_ACTION },
    },
    { ...textInput(ESCALATE_MSG_BLOCK, ESCALATE_MSG_ACTION, "Message (optional)", "Need eyes on the DB…"), optional: true },
  ]);
}

export function severityModalView(incidentId: string): unknown {
  return modal(SEVERITY_MODAL_CALLBACK, "Change severity", "Set", incidentId, [
    {
      type: "input",
      block_id: SEV_SELECT_BLOCK,
      label: { type: "plain_text", text: "Severity" },
      element: {
        type: "static_select",
        action_id: SEV_SELECT_ACTION,
        options: INCIDENT_SEVERITIES.map((s) => ({
          text: { type: "plain_text", text: SEVERITY_LABEL[s] },
          value: s,
        })),
      },
    },
  ]);
}

// --- block_actions dispatch: open the right modal (or act for resolve). ---

/**
 * Handle a controls-panel button press. `incidentId` and `channelId` are the
 * incident owning the panel's channel (resolved by the interactivity handler).
 * Returns true if this was a controls action. Resolve acts directly (its own
 * two-person flow); the rest open a modal via the trigger_id.
 */
export async function handleControlAction(
  env: Env,
  actionId: string,
  incidentId: string,
  channelId: string,
  userId: string,
  triggerId: string,
): Promise<boolean> {
  const slack = buildSlack(env);
  switch (actionId) {
    case CONTROL_UPDATE_ACTION:
      await slack.viewsOpen(triggerId, updateModalView(incidentId));
      return true;
    case CONTROL_STATUS_ACTION:
      await slack.viewsOpen(triggerId, statusModalView(incidentId));
      return true;
    case CONTROL_ESCALATE_ACTION:
      await slack.viewsOpen(triggerId, escalateModalView(incidentId));
      return true;
    case CONTROL_SEVERITY_ACTION:
      await slack.viewsOpen(triggerId, severityModalView(incidentId));
      return true;
    case CONTROL_RESOLVE_ACTION:
      // Request resolution directly (joint sign-off: a different person confirms).
      await requestResolve(env, incidentId, channelId, userId, undefined);
      return true;
    default:
      return false;
  }
}

// --- view_submission dispatch ---

interface ViewSubmission {
  user?: { id?: string };
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: {
      values?: Record<
        string,
        Record<
          string,
          { value?: string; selected_option?: { value?: string }; selected_user?: string }
        >
      >;
    };
  };
}

function val(sub: ViewSubmission, block: string, action: string) {
  return sub.view?.state?.values?.[block]?.[action];
}

/**
 * Handle a controls modal submission. Returns true if it was one of ours.
 * All work routes through the shared command functions (parity with slash/web).
 */
export async function submitControlModal(env: Env, sub: ViewSubmission): Promise<boolean> {
  const cb = sub.view?.callback_id;
  const incidentId = sub.view?.private_metadata ?? "";
  if (!incidentId || !cb) return false;
  const userId = sub.user?.id ?? "unknown";

  switch (cb) {
    case UPDATE_MODAL_CALLBACK: {
      const body = val(sub, UPDATE_BODY_BLOCK, UPDATE_BODY_ACTION)?.value?.trim() ?? "";
      if (body) await postIncidentUpdate(env, incidentId, `<@${userId}>: ${body}`);
      return true;
    }
    case STATUS_MODAL_CALLBACK: {
      const status = val(sub, STATUS_SELECT_BLOCK, STATUS_SELECT_ACTION)?.selected_option?.value as
        | IncidentStatus
        | undefined;
      const note = val(sub, STATUS_NOTE_BLOCK, STATUS_NOTE_ACTION)?.value?.trim();
      if (status && SETTABLE_STATUSES.includes(status as Exclude<IncidentStatus, "resolved">)) {
        const body = note || `Status set to *${status}* by <@${userId}>.`;
        await postIncidentUpdate(env, incidentId, body, status);
      }
      return true;
    }
    case ESCALATE_MODAL_CALLBACK: {
      const target = val(sub, ESCALATE_USER_BLOCK, ESCALATE_USER_ACTION)?.selected_user;
      const msg = val(sub, ESCALATE_MSG_BLOCK, ESCALATE_MSG_ACTION)?.value?.trim();
      if (target) {
        const slack = buildSlack(env);
        const chan = await new D1Db(env.DB).get<{ channel: string }>(
          "SELECT channel FROM incident_channels WHERE incident_id = ?",
          [incidentId],
        );
        const mention = chan?.channel ? `<#${chan.channel}>` : "an incident";
        const reason = msg ? `: “${msg}”` : ".";
        await slack
          .postMessage(target, `:rotating_light: <@${userId}> is pulling you into ${mention}${reason}`)
          .catch(() => {});
        if (chan?.channel) {
          await slack
            .postMessage(chan.channel, `<@${userId}> escalated to <@${target}> for more hands${reason}`)
            .catch(() => {});
        }
      }
      return true;
    }
    case SEVERITY_MODAL_CALLBACK: {
      const sev = val(sub, SEV_SELECT_BLOCK, SEV_SELECT_ACTION)?.selected_option?.value;
      if ((INCIDENT_SEVERITIES as readonly string[]).includes(sev ?? "")) {
        await setSeverity(env, incidentId, sev as IncidentSeverity);
      }
      return true;
    }
    default:
      return false;
  }
}

// keep RESOLVE_NOTE_* referenced for potential future note modal without lint noise
void RESOLVE_NOTE_BLOCK;
void RESOLVE_NOTE_ACTION;
