/// <reference types="@cloudflare/workers-types" />
// Alert routing. See ROADMAP.md → "Alert routing" and docs/SPEC_ONCALL.md §5.
//
// The routing DECISION: given an inbound alert's `route`, decide what happens —
// hard-coded (single-tenant), not a rule builder:
//   internal (default) → engage on-call escalation (page the primary).
//   external           → do NOT page; post a notice to the alerts/comms channel,
//                        ready for a human to promote to an incident on the
//                        external routing path (Support-Lead-only).
//
// This is where "external = no on-call page" actually bites: on-call is engaged
// by a firing ALERT (escalateNew), never by declaring an incident, so the gate
// belongs here at ingest — not at incident declare.

import type { Env } from "../env";
import type { AlertRow, AlertRoute } from "./alerts";
import { escalateNew } from "./escalation";
import { notifyAlertRouted } from "./notifier";

export interface RouteAction {
  /** Engage the on-call escalation ladder for this alert. */
  page: boolean;
  /** Post an informational notice to the alerts/comms channel instead of paging. */
  notifyChannel: boolean;
  /** The incident routing path to use IF this alert is later promoted. */
  incidentPath: "internal" | "external";
}

/** Fixed route → action table. No builder — one line per route. */
export function decideAlertRoute(route: AlertRoute): RouteAction {
  switch (route) {
    case "external":
      // Upstream/partner: communicate, don't page. Human promotes if warranted.
      return { page: false, notifyChannel: true, incidentPath: "external" };
    case "internal":
    default:
      return { page: true, notifyChannel: false, incidentPath: "internal" };
  }
}

/**
 * Apply the routing decision to a genuinely-new firing alert. Called from
 * POST /api/alerts when ingestAlert returns result:'created'. Internal → page;
 * external → post a comms notice (best-effort) and skip the ladder.
 */
export async function routeNewAlert(env: Env, alert: AlertRow): Promise<RouteAction> {
  const action = decideAlertRoute(alert.route);
  if (action.page) {
    await escalateNew(env, alert);
  } else if (action.notifyChannel) {
    await notifyAlertRouted(env, alert);
  }
  return action;
}
