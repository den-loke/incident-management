import type { Db, StatusSink } from "./sink";
import { STATUS_RANK } from "./types";
import type {
  Component,
  ComponentStatus,
  Incident,
  IncidentStatus,
  IncidentUpdate,
  OpenIncidentInput,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Internal status sink backed by D1 (via the Db port). ALWAYS active and the
 * source of truth for the web UI. See docs/ARCHITECTURE.md §6.
 */
export class InternalStatusSink implements StatusSink {
  constructor(private readonly db: Db) {}

  async openIncident(input: OpenIncidentInput): Promise<Incident> {
    const now = nowIso();
    const status = input.status ?? "investigating";
    // Stamp identified_at/closed_at up front if the incident is DECLARED already
    // at that lifecycle point (rare, but /incident declare can set a status).
    const identifiedAt = STATUS_RANK[status] >= STATUS_RANK.identified ? now : null;
    const closedAt = status === "resolved" ? now : null;
    const incident: Incident = {
      id: input.id ?? uid("inc"),
      name: input.name,
      status,
      severity: input.severity ?? "sev2",
      routing_path: input.routingPath ?? "internal",
      created_at: now,
      resolved_at: status === "resolved" ? now : null,
      identified_at: identifiedAt,
      closed_at: closedAt,
      last_updated_at: now,
    };
    await this.db.run(
      "INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at, identified_at, closed_at, last_updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        incident.id,
        incident.name,
        incident.status,
        incident.severity,
        incident.routing_path,
        incident.created_at,
        incident.resolved_at,
        incident.identified_at,
        incident.closed_at,
        incident.last_updated_at,
      ],
    );
    if (input.body) {
      await this.appendIncidentUpdate(incident.id, input.body, incident.status);
    }
    return incident;
  }

  async appendIncidentUpdate(
    incidentId: string,
    body: string,
    status: IncidentStatus,
  ): Promise<IncidentUpdate> {
    const update: IncidentUpdate = {
      id: uid("iu"),
      incident_id: incidentId,
      body,
      status,
      created_at: nowIso(),
    };
    await this.db.run(
      "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [update.id, update.incident_id, update.body, update.status, update.created_at],
    );
    // Keep the parent incident's lifecycle timestamps in step with its latest update.
    //  - last_updated_at: always bumped to this update.
    //  - identified_at: stamped the FIRST time status reaches 'identified'+ (COALESCE
    //    preserves an earlier stamp; only writes when currently null).
    //  - resolved_at / closed_at: set on resolve, cleared if a resolved incident
    //    is re-opened to an earlier status.
    const isResolved = status === "resolved";
    const resolvedAt = isResolved ? update.created_at : null;
    const identifiedNow =
      STATUS_RANK[status] >= STATUS_RANK.identified ? update.created_at : null;
    await this.db.run(
      `UPDATE incidents
          SET status = ?,
              resolved_at = ?,
              closed_at = ?,
              last_updated_at = ?,
              identified_at = COALESCE(identified_at, ?)
        WHERE id = ?`,
      [status, resolvedAt, resolvedAt, update.created_at, identifiedNow, incidentId],
    );
    return update;
  }

  async setComponentStatus(
    componentId: string,
    status: ComponentStatus,
  ): Promise<void> {
    await this.db.run(
      "UPDATE components SET status = ?, updated_at = ? WHERE id = ?",
      [status, nowIso(), componentId],
    );
  }

  async getIncident(incidentId: string): Promise<Incident | null> {
    return this.db.get<Incident>("SELECT * FROM incidents WHERE id = ?", [
      incidentId,
    ]);
  }

  async listComponents(): Promise<Component[]> {
    return this.db.all<Component>("SELECT * FROM components ORDER BY name");
  }
}
