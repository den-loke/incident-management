/// <reference types="@cloudflare/workers-types" />
// Sticky in-Slack incident "dashboard" — ONE pinned Block Kit message that is
// the channel's control surface. Posted + pinned on declare; every later state
// change (status, severity, role claim, resolve) chat.update()s THIS SAME
// message in place instead of posting a fresh panel. So the channel keeps a
// single, always-current card at the top: current status/severity, who holds
// each role, and the action buttons — people find "what to do" without
// remembering slash commands. Requested 2026-09-11.
//
// The buttons reuse the existing control action_ids (controls.ts) and role
// claim action_ids (roles/service.ts), so the interactivity handler already
// dispatches them — no new wiring there. Roles/controls are folded INTO this
// one card, replacing the two separate panels that used to be re-posted.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import { RoleStore } from "../roles/store";
import { ROLE_LABEL, type IncidentRole } from "../roles/types";
import { rolesForPath } from "../roles/service";
import { CLAIM_ACTION_PREFIX } from "../roles/service";
import {
  SEVERITY_LABEL,
  type IncidentSeverity,
  type IncidentStatus,
  type RoutingPath,
} from "../status/types";
import {
  CONTROL_UPDATE_ACTION,
  CONTROL_STATUS_ACTION,
  CONTROL_ESCALATE_ACTION,
  CONTROL_SEVERITY_ACTION,
  CONTROL_RESOLVE_ACTION,
} from "./controls";

// Test/bypass seam mirroring the other services.
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setDashboardSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

const STATUS_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

const STATUS_EMOJI: Record<IncidentStatus, string> = {
  investigating: ":mag:",
  identified: ":wrench:",
  monitoring: ":eyes:",
  resolved: ":white_check_mark:",
};

export interface DashboardState {
  incidentId: string;
  name: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  routingPath: RoutingPath;
  holders: Partial<Record<IncidentRole, string>>;
  appBaseUrl?: string;
}

/** Plain-text fallback (notifications, no-blocks clients). */
export function dashboardText(s: DashboardState): string {
  const roles = rolesForPath(s.routingPath)
    .map((r) => `${ROLE_LABEL[r]}: ${s.holders[r] ? `<@${s.holders[r]}>` : "unassigned"}`)
    .join(" · ");
  return `${s.incidentId} — ${s.name} · ${STATUS_LABEL[s.status]} · ${SEVERITY_LABEL[s.severity]} · ${roles}`;
}

/** Render the unified dashboard card. Buttons reuse existing action_ids so the
 * interactivity handler dispatches them unchanged. Resolved incidents drop the
 * action buttons (the incident is closed). */
export function dashboardBlocks(s: DashboardState): unknown[] {
  const resolved = s.status === "resolved";
  const roles = rolesForPath(s.routingPath);
  const roleLines = roles
    .map((r) => `*${ROLE_LABEL[r]}:* ${s.holders[r] ? `<@${s.holders[r]}>` : "_unassigned_"}`)
    .join("\n");

  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${s.incidentId} · ${s.name}`.slice(0, 150) },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${STATUS_EMOJI[s.status]} ${STATUS_LABEL[s.status]}` },
        { type: "mrkdwn", text: `*Severity*\n${SEVERITY_LABEL[s.severity]}` },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: `*Roles*\n${roleLines}` } },
  ];

  if (!resolved) {
    // Role claim buttons (transfer/claim in place).
    blocks.push({
      type: "actions",
      block_id: "inc_dash_roles",
      elements: roles.map((role) => ({
        type: "button",
        text: { type: "plain_text", text: `Take ${ROLE_LABEL[role]}` },
        action_id: `${CLAIM_ACTION_PREFIX}${role}`,
        value: role,
      })),
    });
    // Incident controls (same actions as the old controls panel).
    const btn = (text: string, action_id: string, style?: "primary" | "danger") => ({
      type: "button",
      text: { type: "plain_text", text },
      action_id,
      ...(style ? { style } : {}),
    });
    blocks.push({
      type: "actions",
      block_id: "inc_dash_controls",
      elements: [
        btn("Post update", CONTROL_UPDATE_ACTION),
        btn("Change status", CONTROL_STATUS_ACTION),
        btn("Escalate", CONTROL_ESCALATE_ACTION),
        btn("Change severity", CONTROL_SEVERITY_ACTION),
        btn("Request resolve", CONTROL_RESOLVE_ACTION, "danger"),
      ],
    });
  }

  if (s.appBaseUrl) {
    const url = `${s.appBaseUrl.replace(/\/$/, "")}/?incident=${s.incidentId}`;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${url}|View this incident in the dashboard ↗>` }],
    });
  }
  return blocks;
}

/** Read the full dashboard state for an incident from D1 + role store. */
async function readState(env: Env, incidentId: string): Promise<DashboardState | undefined> {
  const db = new D1Db(env.DB);
  const inc = await db.get<{
    name: string;
    status: IncidentStatus;
    severity: IncidentSeverity;
    routing_path: RoutingPath;
  }>(
    "SELECT name, status, severity, routing_path FROM incidents WHERE id = ?",
    [incidentId],
  );
  if (!inc) return undefined;

  const rows = await new RoleStore(db).list(incidentId);
  const holders: Partial<Record<IncidentRole, string>> = {};
  for (const r of rows) holders[r.role] = r.slack_user_id;

  return {
    incidentId,
    name: inc.name,
    status: inc.status,
    severity: inc.severity,
    routingPath: inc.routing_path ?? "internal",
    holders,
    appBaseUrl: env.APP_BASE_URL,
  };
}

async function channelAndTs(
  env: Env,
  incidentId: string,
): Promise<{ channel: string; dashboard_ts: string | null } | undefined> {
  const db = new D1Db(env.DB);
  const row = await db.get<{ channel: string; dashboard_ts: string | null }>(
    "SELECT channel, dashboard_ts FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row ?? undefined;
}

/**
 * Post the dashboard card to a freshly-created incident channel, pin it, and
 * store its ts so later changes edit it in place. Best-effort: the caller wraps
 * this so a Slack failure never fails the declare.
 */
export async function ensureDashboard(
  env: Env,
  incidentId: string,
  channelId: string,
): Promise<void> {
  const state = await readState(env, incidentId);
  if (!state) return;
  const slack = buildSlack(env);
  const ts = await slack.postBlocks(channelId, dashboardText(state), dashboardBlocks(state));
  await slack.pin(channelId, ts);
  await new D1Db(env.DB).run(
    "UPDATE incident_channels SET dashboard_ts = ? WHERE incident_id = ?",
    [ts, incidentId],
  );
}

/**
 * Re-render the pinned dashboard in place after a state change. If there is no
 * stored ts yet (older incident, or the initial post failed), fall back to
 * posting + pinning a fresh one. Best-effort — never let a Slack failure abort
 * the state change that triggered it.
 */
export async function refreshDashboard(env: Env, incidentId: string): Promise<void> {
  try {
    const loc = await channelAndTs(env, incidentId);
    if (!loc) return;
    const state = await readState(env, incidentId);
    if (!state) return;
    const slack = buildSlack(env);
    if (loc.dashboard_ts) {
      await slack.updateMessage(
        loc.channel,
        loc.dashboard_ts,
        dashboardText(state),
        dashboardBlocks(state),
      );
    } else {
      await ensureDashboard(env, incidentId, loc.channel);
    }
  } catch {
    /* non-fatal: the card is a mirror; the source of truth already changed */
  }
}
