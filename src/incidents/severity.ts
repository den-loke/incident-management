/// <reference types="@cloudflare/workers-types" />
// Incident severity: set/change the fixed-scale severity on an incident and
// record the change as a timeline update. Kept as a small direct-D1 service
// rather than a StatusSink method — severity isn't mirrored to Statuspage, so it
// doesn't belong in the sink fan-out. See ROADMAP.md.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import {
  SEVERITY_LABEL,
  type IncidentSeverity,
  type IncidentStatus,
} from "../status/types";

function nowIso(): string {
  return new Date().toISOString();
}
function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Set an incident's severity and append a timeline update noting the change.
 * Returns false if the incident does not exist.
 */
export async function setSeverity(
  env: Env,
  incidentId: string,
  severity: IncidentSeverity,
): Promise<boolean> {
  const db = new D1Db(env.DB);
  const inc = await db.get<{ status: IncidentStatus }>(
    "SELECT status FROM incidents WHERE id = ?",
    [incidentId],
  );
  if (!inc) return false;

  await db.run("UPDATE incidents SET severity = ? WHERE id = ?", [severity, incidentId]);

  // Record the change on the timeline at the incident's current status.
  await db.run(
    "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)",
    [uid("iu"), incidentId, `Severity set to ${SEVERITY_LABEL[severity]}.`, inc.status, nowIso()],
  );
  return true;
}
