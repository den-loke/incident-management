/// <reference types="@cloudflare/workers-types" />
// Single-incident read helpers. Backs the per-incident MCP tools (get_incident,
// get_incident_timeline, get_draft_report_data) and is reusable by any surface
// that needs ONE incident's detail without loading the whole status payload.
// Read-only, pure over the Db port.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { Incident, IncidentUpdate } from "../status/types";
import { PostmortemStore } from "../postmortem/store";
import type { PostmortemWithItems } from "../postmortem/types";
import { deriveDurationsSeconds } from "./durations";

export interface IncidentDetail extends Incident {
  updates: IncidentUpdate[];
  channel: string | null;
  /** Derived durations in seconds (null when the endpoint isn't reached yet). */
  durations: {
    total_seconds: number | null;
    time_to_identify_seconds: number | null;
    time_to_resolve_seconds: number | null;
  };
}

/** One incident with its timeline, channel, and derived durations. Null if unknown. */
export async function getIncidentDetail(
  env: Env,
  incidentId: string,
): Promise<IncidentDetail | null> {
  const db = new D1Db(env.DB);
  const incident = await db.get<Incident>("SELECT * FROM incidents WHERE id = ?", [incidentId]);
  if (!incident) return null;
  const updates = await db.all<IncidentUpdate>(
    "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    [incidentId],
  );
  const chan = await db.get<{ channel: string }>(
    "SELECT channel FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return {
    ...incident,
    updates,
    channel: chan?.channel ?? null,
    durations: deriveDurationsSeconds(incident),
  };
}

/** Just the timeline (updates, chronological) for one incident. Null if unknown. */
export async function getIncidentTimeline(
  env: Env,
  incidentId: string,
): Promise<IncidentUpdate[] | null> {
  const db = new D1Db(env.DB);
  const incident = await db.get<{ id: string }>("SELECT id FROM incidents WHERE id = ?", [incidentId]);
  if (!incident) return null;
  return db.all<IncidentUpdate>(
    "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    [incidentId],
  );
}

export interface DraftReportData {
  incident: IncidentDetail;
  postmortem: PostmortemWithItems | null;
}

/** Everything needed to draft/write an incident report: detail + timeline +
 * the (auto-drafted or edited) post-mortem with its action items. Null if the
 * incident is unknown. */
export async function getDraftReportData(
  env: Env,
  incidentId: string,
): Promise<DraftReportData | null> {
  const incident = await getIncidentDetail(env, incidentId);
  if (!incident) return null;
  const postmortem = await new PostmortemStore(new D1Db(env.DB)).get(incidentId);
  return { incident, postmortem };
}
