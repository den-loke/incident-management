/// <reference types="@cloudflare/workers-types" />
// Follow-ups + incident history. See ROADMAP.md → "Follow-ups (first-class) +
// historical incidents". A standing, cross-incident view of follow-up action
// items (open/done, owner, linked Jira, which incident) and a browsable history
// of past incidents. Read-only aggregation over existing tables (postmortems +
// postmortem_action_items + incidents); pure over the Db port.

import type { Db } from "../status/sink";
import type { IncidentSeverity, IncidentStatus, RoutingPath } from "../status/types";

export interface FollowUp {
  id: string;
  description: string;
  owner: string | null;
  done: boolean;
  jira_key: string | null;
  incident_id: string;
  incident_name: string;
  postmortem_status: "draft" | "published";
  created_at: string;
}

export interface HistoryIncident {
  id: string;
  name: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  routing_path: RoutingPath;
  created_at: string;
  resolved_at: string | null;
  has_postmortem: boolean;
  open_action_items: number;
}

interface FollowUpRow {
  id: string;
  description: string;
  owner: string | null;
  done: number;
  jira_key: string | null;
  incident_id: string;
  incident_name: string;
  postmortem_status: "draft" | "published";
  created_at: string;
}

/**
 * All follow-up action items across every incident, joined to their incident +
 * post-mortem. `onlyOpen` (default true) hides completed ones — the "what's
 * outstanding" view; pass false for the full audit.
 */
export async function listFollowUps(db: Db, onlyOpen = true): Promise<FollowUp[]> {
  const rows = await db.all<FollowUpRow>(
    `SELECT ai.id, ai.description, ai.owner, ai.done, ai.jira_key,
            i.id AS incident_id, i.name AS incident_name,
            pm.status AS postmortem_status, ai.created_at
       FROM postmortem_action_items ai
       JOIN postmortems pm ON pm.id = ai.postmortem_id
       JOIN incidents i    ON i.id = pm.incident_id
      ${onlyOpen ? "WHERE ai.done = 0" : ""}
      ORDER BY ai.done ASC, i.created_at DESC, ai.created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    owner: r.owner,
    done: r.done === 1,
    jira_key: r.jira_key,
    incident_id: r.incident_id,
    incident_name: r.incident_name,
    postmortem_status: r.postmortem_status,
    created_at: r.created_at,
  }));
}

interface HistoryRow {
  id: string;
  name: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  routing_path: RoutingPath;
  created_at: string;
  resolved_at: string | null;
  has_postmortem: number;
  open_action_items: number;
}

/**
 * Browsable incident history, newest first. Each row carries whether it has a
 * post-mortem and how many of its action items are still open. Optional filters:
 * severity, routing_path (both exact-match when provided).
 */
export async function listIncidentHistory(
  db: Db,
  opts: { severity?: IncidentSeverity; routing_path?: RoutingPath; limit?: number } = {},
): Promise<HistoryIncident[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.severity) {
    where.push("i.severity = ?");
    params.push(opts.severity);
  }
  if (opts.routing_path) {
    where.push("i.routing_path = ?");
    params.push(opts.routing_path);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  params.push(opts.limit ?? 100);

  const rows = await db.all<HistoryRow>(
    `SELECT i.id, i.name, i.status, i.severity, i.routing_path, i.created_at, i.resolved_at,
            (SELECT COUNT(*) FROM postmortems pm WHERE pm.incident_id = i.id) AS has_postmortem,
            (SELECT COUNT(*) FROM postmortem_action_items ai
               JOIN postmortems pm2 ON pm2.id = ai.postmortem_id
              WHERE pm2.incident_id = i.id AND ai.done = 0) AS open_action_items
       FROM incidents i
       ${whereSql}
      ORDER BY COALESCE(i.resolved_at, i.created_at) DESC
      LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    severity: r.severity,
    routing_path: r.routing_path,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    has_postmortem: r.has_postmortem > 0,
    open_action_items: r.open_action_items,
  }));
}
