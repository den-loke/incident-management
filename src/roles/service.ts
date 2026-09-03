/// <reference types="@cloudflare/workers-types" />
// Incident roles service: posts the claim-buttons panel to the incident channel
// and applies a claim from a Slack button press. See ROADMAP.md.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import { RoleStore } from "./store";
import { INCIDENT_ROLES, ROLE_LABEL, type IncidentRole } from "./types";
import type { RoutingPath } from "../status/types";

// Which roles apply per routing path (hard-coded — see ROADMAP routing paths).
// internal = full response (both roles). external (upstream/partner) = we mostly
// communicate, so only the Customer Support Lead applies — no Engineering Lead.
export function rolesForPath(path: RoutingPath): readonly IncidentRole[] {
  return path === "external" ? (["customer_support_lead"] as const) : INCIDENT_ROLES;
}

// Test/bypass seam mirroring the DO's client injection.
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setRolesSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

// action_id encodes the role to claim: "claim_role:<role>".
export const CLAIM_ACTION_PREFIX = "claim_role:";

/** Build the Block Kit panel: a line per role holder + a Take button each.
 * `roles` is the set applicable to the incident's routing path. */
export function rolesBlocks(
  holders: Partial<Record<IncidentRole, string>>,
  roles: readonly IncidentRole[] = INCIDENT_ROLES,
): unknown[] {
  const lines = roles.map((role) => {
    const who = holders[role];
    return `*${ROLE_LABEL[role]}:* ${who ? `<@${who}>` : "_unassigned_"}`;
  }).join("\n");

  return [
    { type: "section", text: { type: "mrkdwn", text: `*Incident roles*\n${lines}` } },
    {
      type: "actions",
      elements: roles.map((role) => ({
        type: "button",
        text: { type: "plain_text", text: `Take ${ROLE_LABEL[role]}` },
        action_id: `${CLAIM_ACTION_PREFIX}${role}`,
        value: role,
      })),
    },
  ];
}

/** Fallback text for the roles panel (shown where blocks aren't rendered). */
function rolesText(
  holders: Partial<Record<IncidentRole, string>>,
  roles: readonly IncidentRole[] = INCIDENT_ROLES,
): string {
  return roles.map(
    (role) => `${ROLE_LABEL[role]}: ${holders[role] ? `<@${holders[role]}>` : "unassigned"}`,
  ).join(" · ");
}

async function holdersMap(
  db: D1Db,
  incidentId: string,
): Promise<Partial<Record<IncidentRole, string>>> {
  const rows = await new RoleStore(db).list(incidentId);
  const m: Partial<Record<IncidentRole, string>> = {};
  for (const r of rows) m[r.role] = r.slack_user_id;
  return m;
}

/** Post the roles panel (with current holders) to an incident's channel. The
 * routing path decides which roles the panel offers (external = Support only). */
export async function postRolesPanel(
  env: Env,
  incidentId: string,
  channelId: string,
  routingPath: RoutingPath = "internal",
): Promise<void> {
  const db = new D1Db(env.DB);
  const roles = rolesForPath(routingPath);
  const holders = await holdersMap(db, incidentId);
  const blocks = rolesBlocks(holders, roles);
  let text = rolesText(holders, roles);
  // Slack → web deep link back to the dashboard incident view, when configured.
  if (env.APP_BASE_URL) {
    const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/?incident=${incidentId}`;
    text += `\nView in dashboard: ${url}`;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `<${url}|View this incident in the dashboard ↗>` }],
    });
  }
  await buildSlack(env).postBlocks(channelId, text, blocks);
}

/**
 * Apply a role claim from a Slack button press: upsert the assignment, then
 * re-post the panel so the channel reflects the new holder.
 */
export async function claimRole(
  env: Env,
  incidentId: string,
  channelId: string,
  role: IncidentRole,
  slackUserId: string,
): Promise<void> {
  const db = new D1Db(env.DB);
  // The claim itself (source of truth) must always persist.
  await new RoleStore(db).claim(incidentId, role, slackUserId);
  // Re-posting the panel is cosmetic — never let a Slack failure lose the claim.
  try {
    const inc = await db.get<{ routing_path: RoutingPath }>(
      "SELECT routing_path FROM incidents WHERE id = ?",
      [incidentId],
    );
    const roles = rolesForPath(inc?.routing_path ?? "internal");
    const holders = await holdersMap(db, incidentId);
    await buildSlack(env).postBlocks(channelId, rolesText(holders, roles), rolesBlocks(holders, roles));
  } catch {
    /* non-fatal */
  }
}
