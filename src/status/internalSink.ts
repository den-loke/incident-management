import type { Db, StatusSink } from "./sink";
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
    const incident: Incident = {
      id: input.id ?? uid("inc"),
      name: input.name,
      status: input.status ?? "investigating",
      severity: input.severity ?? "sev2",
      routing_path: input.routingPath ?? "internal",
      created_at: nowIso(),
      resolved_at: null,
    };
    await this.db.run(
      "INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [incident.id, incident.name, incident.status, incident.severity, incident.routing_path, incident.created_at, null],
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
    // Keep the parent incident's status in step with its latest update.
    const resolvedAt = status === "resolved" ? update.created_at : null;
    await this.db.run(
      "UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ?",
      [status, resolvedAt, incidentId],
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
