import type { StatusSink } from "./sink";
import type {
  Component,
  ComponentStatus,
  Incident,
  IncidentStatus,
  IncidentUpdate,
  OpenIncidentInput,
} from "./types";

/**
 * Fans writes out to an ordered list of sinks; reads come from the FIRST
 * (primary) sink — the internal D1 source of truth. See docs/ARCHITECTURE.md §6.
 *
 * The primary write happens first and its result is authoritative (e.g. the
 * generated incident id); secondary sinks (Statuspage mirror) receive the same
 * ids so both stores stay aligned.
 */
export class MultiSink implements StatusSink {
  private readonly primary: StatusSink;
  private readonly secondaries: StatusSink[];

  constructor(sinks: StatusSink[]) {
    if (sinks.length === 0) {
      throw new Error("MultiSink requires at least one sink");
    }
    [this.primary, ...this.secondaries] = sinks;
  }

  async openIncident(input: OpenIncidentInput): Promise<Incident> {
    const incident = await this.primary.openIncident(input);
    // Reuse the primary's id + fields so secondaries mirror exactly.
    for (const sink of this.secondaries) {
      await sink.openIncident({
        id: incident.id,
        name: incident.name,
        status: incident.status,
        body: input.body,
      });
    }
    return incident;
  }

  async appendIncidentUpdate(
    incidentId: string,
    body: string,
    status: IncidentStatus,
  ): Promise<IncidentUpdate> {
    const update = await this.primary.appendIncidentUpdate(
      incidentId,
      body,
      status,
    );
    for (const sink of this.secondaries) {
      await sink.appendIncidentUpdate(incidentId, body, status);
    }
    return update;
  }

  async setComponentStatus(
    componentId: string,
    status: ComponentStatus,
  ): Promise<void> {
    await this.primary.setComponentStatus(componentId, status);
    for (const sink of this.secondaries) {
      await sink.setComponentStatus(componentId, status);
    }
  }

  getIncident(incidentId: string): Promise<Incident | null> {
    return this.primary.getIncident(incidentId);
  }

  listComponents(): Promise<Component[]> {
    return this.primary.listComponents();
  }
}
