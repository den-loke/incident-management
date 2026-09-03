/// <reference types="@cloudflare/workers-types" />
// App Home tab + stakeholder subscription.
//
//  - publishHomeView: renders and pushes the Home tab (recent incidents +
//    a stakeholder opt-in/opt-out button), called on `app_home_opened`.
//  - toggleStakeholder: flips the caller's subscription (from the Home button)
//    and re-publishes their Home tab.
//  - inviteStakeholdersToChannel: invites every subscriber to a new incident's
//    channel — wired into declareIncident so opting in once covers all FUTURE
//    incidents.
//
// Single-tenant / hard-coded process: one standing list, no per-incident
// invite config. See migrations/0010_stakeholders.sql.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import { StakeholderStore } from "./store";
import {
  SEVERITY_LABEL,
  INCIDENT_SEVERITIES,
  ROUTING_PATHS,
  ROUTING_PATH_LABEL,
  isRoutingPath,
  type IncidentSeverity,
  type IncidentStatus,
  type RoutingPath,
} from "../status/types";
import { declareIncident } from "../incidents/commands";

// Test/bypass seam mirroring the roles service.
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setStakeholderSlackClient(
  f: ((env: Env) => SlackClient) | undefined,
): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

// Home-tab button that flips the caller's stakeholder subscription.
export const STAKEHOLDER_TOGGLE_ACTION = "stakeholder_toggle";

// Home-tab "Declare incident" button + the modal it opens.
export const DECLARE_ACTION = "declare_incident_open";
export const DECLARE_MODAL_CALLBACK = "declare_incident_modal";
// Block/action ids inside the declare modal (used to read view.state on submit).
const DECLARE_NAME_BLOCK = "declare_name_block";
const DECLARE_NAME_ACTION = "declare_name_input";
const DECLARE_SEV_BLOCK = "declare_sev_block";
const DECLARE_SEV_ACTION = "declare_sev_select";
const DECLARE_PATH_BLOCK = "declare_path_block";
const DECLARE_PATH_ACTION = "declare_path_select";

const STATUS_EMOJI: Record<IncidentStatus, string> = {
  investigating: "🔴",
  identified: "🟠",
  monitoring: "🟡",
  resolved: "🟢",
};

interface RecentIncidentRow {
  id: string;
  name: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  created_at: string;
  resolved_at: string | null;
  channel: string | null;
}

/** Load the most recent incidents (newest first) for the Home tab. */
async function recentIncidents(
  db: D1Db,
  limit = 10,
): Promise<RecentIncidentRow[]> {
  return db.all<RecentIncidentRow>(
    "SELECT i.id, i.name, i.status, i.severity, i.created_at, i.resolved_at, " +
      "c.channel AS channel " +
      "FROM incidents i " +
      "LEFT JOIN incident_channels c ON c.incident_id = i.id " +
      "ORDER BY i.created_at DESC LIMIT ?",
    [limit],
  );
}

/** Compact human date, e.g. "3 Sep, 21:33". Falls back to the raw ISO string. */
function fmtDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Build the App Home Block Kit view for one user. */
export function homeBlocks(
  incidents: RecentIncidentRow[],
  isStakeholder: boolean,
  appBaseUrl?: string,
): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🚨 Incident Management", emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: isStakeholder
          ? "You're a *stakeholder*. You'll be added to every new incident channel."
          : "You're *not* a stakeholder. Opt in to be added to every new incident channel.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Declare incident", emoji: true },
          style: "danger",
          action_id: DECLARE_ACTION,
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: isStakeholder
              ? "Stop being a stakeholder"
              : "Include me in future incidents",
            emoji: true,
          },
          style: isStakeholder ? undefined : "primary",
          action_id: STAKEHOLDER_TOGGLE_ACTION,
          value: isStakeholder ? "off" : "on",
        },
      ],
    },
    { type: "divider" },
    {
      type: "header",
      text: { type: "plain_text", text: "Recent incidents", emoji: true },
    },
  ];

  if (incidents.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No incidents yet._" },
    });
    return blocks;
  }

  const base = appBaseUrl?.replace(/\/$/, "");
  for (const inc of incidents) {
    const when =
      inc.status === "resolved" && inc.resolved_at
        ? `resolved ${fmtDate(inc.resolved_at)}`
        : `opened ${fmtDate(inc.created_at)}`;
    // Primary link is the Slack channel: `<#Cxxx>` renders as a clickable
    // #channel mention that jumps straight into the incident channel. Fall back
    // to the dashboard deep-link (then plain bold) when the channel is unknown.
    let namePart: string;
    if (inc.channel) {
      namePart = `<#${inc.channel}> — ${inc.name}`;
    } else if (base) {
      namePart = `<${base}/?incident=${inc.id}|${inc.name}>`;
    } else {
      namePart = `*${inc.name}*`;
    }
    // When we have BOTH a channel link and a dashboard, offer the dashboard as
    // a small secondary link so the web view is still reachable.
    const dashboardTail =
      inc.channel && base
        ? ` · <${base}/?incident=${inc.id}|dashboard ↗>`
        : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${STATUS_EMOJI[inc.status]} ${namePart}\n` +
          `${SEVERITY_LABEL[inc.severity]} · ${inc.status} · ${when}${dashboardTail}`,
      },
    });
  }

  return blocks;
}

/** Render and publish a user's Home tab. Called on `app_home_opened`. */
export async function publishHomeView(env: Env, userId: string): Promise<void> {
  const db = new D1Db(env.DB);
  const [incidents, isStakeholder] = await Promise.all([
    recentIncidents(db),
    new StakeholderStore(db).isSubscribed(userId),
  ]);
  const blocks = homeBlocks(incidents, isStakeholder, env.APP_BASE_URL);
  await buildSlack(env).viewsPublish(userId, blocks);
}

/** Flip the caller's stakeholder subscription, then re-publish their Home tab. */
export async function toggleStakeholder(
  env: Env,
  userId: string,
  turnOn: boolean,
): Promise<void> {
  const store = new StakeholderStore(new D1Db(env.DB));
  if (turnOn) {
    await store.subscribe(userId);
  } else {
    await store.unsubscribe(userId);
  }
  // Reflect the new state back in the Home tab. Best-effort — the subscription
  // (source of truth) already persisted above.
  try {
    await publishHomeView(env, userId);
  } catch {
    /* non-fatal */
  }
}

/**
 * Invite every standing stakeholder to a new incident's channel. Best-effort:
 * a Slack failure here must never fail the declare. Called from declareIncident.
 */
export async function inviteStakeholdersToChannel(
  env: Env,
  channelId: string,
): Promise<void> {
  const users = await new StakeholderStore(new D1Db(env.DB)).list();
  if (users.length === 0) return;
  await buildSlack(env).inviteToChannel(channelId, users);
}

/** Build the "Declare incident" modal view (name input + severity select). */
export function declareModalView(): unknown {
  return {
    type: "modal",
    callback_id: DECLARE_MODAL_CALLBACK,
    title: { type: "plain_text", text: "Declare incident" },
    submit: { type: "plain_text", text: "Declare" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: DECLARE_NAME_BLOCK,
        label: { type: "plain_text", text: "What's going on?" },
        element: {
          type: "plain_text_input",
          action_id: DECLARE_NAME_ACTION,
          placeholder: {
            type: "plain_text",
            text: "e.g. Checkout returning 500s",
          },
        },
      },
      {
        type: "input",
        block_id: DECLARE_SEV_BLOCK,
        label: { type: "plain_text", text: "Severity" },
        element: {
          type: "static_select",
          action_id: DECLARE_SEV_ACTION,
          initial_option: {
            text: { type: "plain_text", text: SEVERITY_LABEL.sev2 },
            value: "sev2",
          },
          options: INCIDENT_SEVERITIES.map((s) => ({
            text: { type: "plain_text", text: SEVERITY_LABEL[s] },
            value: s,
          })),
        },
      },
      {
        type: "input",
        block_id: DECLARE_PATH_BLOCK,
        label: { type: "plain_text", text: "Routing path" },
        element: {
          type: "static_select",
          action_id: DECLARE_PATH_ACTION,
          initial_option: {
            text: { type: "plain_text", text: ROUTING_PATH_LABEL.internal },
            value: "internal",
          },
          options: ROUTING_PATHS.map((p) => ({
            text: { type: "plain_text", text: ROUTING_PATH_LABEL[p] },
            value: p,
          })),
        },
      },
    ],
  };
}

/** Open the declare modal in response to the Home-tab button's trigger_id. */
export async function openDeclareModal(
  env: Env,
  triggerId: string,
): Promise<void> {
  await buildSlack(env).viewsOpen(triggerId, declareModalView());
}

// Shape of the parts of a view_submission payload we read.
interface DeclareSubmission {
  user?: { id?: string };
  view?: {
    callback_id?: string;
    state?: {
      values?: Record<
        string,
        Record<string, { value?: string; selected_option?: { value?: string } }>
      >;
    };
  };
}

/**
 * Handle the declare modal's submission: read the name + severity, declare the
 * incident (same path as Slack/web), then re-publish the submitter's Home tab
 * so the new incident shows immediately. Returns true if it was our modal.
 */
export async function submitDeclareModal(
  env: Env,
  payload: DeclareSubmission,
): Promise<boolean> {
  if (payload.view?.callback_id !== DECLARE_MODAL_CALLBACK) return false;
  const values = payload.view?.state?.values ?? {};
  const name =
    values[DECLARE_NAME_BLOCK]?.[DECLARE_NAME_ACTION]?.value?.trim() ?? "";
  const sev =
    values[DECLARE_SEV_BLOCK]?.[DECLARE_SEV_ACTION]?.selected_option?.value;
  const severity = (INCIDENT_SEVERITIES as readonly string[]).includes(sev ?? "")
    ? (sev as IncidentSeverity)
    : undefined;
  const pathVal =
    values[DECLARE_PATH_BLOCK]?.[DECLARE_PATH_ACTION]?.selected_option?.value;
  const routingPath: RoutingPath | undefined = isRoutingPath(pathVal) ? pathVal : undefined;

  if (name) {
    await declareIncident(env, name, undefined, severity, routingPath);
  }

  // Refresh the submitter's Home tab so the new incident appears.
  const userId = payload.user?.id;
  if (userId) {
    try {
      await publishHomeView(env, userId);
    } catch {
      /* non-fatal */
    }
  }
  return true;
}
