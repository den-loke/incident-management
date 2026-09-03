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
  type IncidentSeverity,
  type IncidentStatus,
} from "../status/types";

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
