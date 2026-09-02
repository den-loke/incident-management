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
 * Mirror sink to statuspage.io. STUB — not implemented yet.
 *
 * Implementation notes (see docs/ARCHITECTURE.md §6):
 *  - Auth header is literally `Authorization: OAuth <STATUSPAGE_API_KEY>`
 *    (it is an API key despite the "OAuth" keyword).
 *  - Rate limit is 1 request/second (60/min rolling); breach returns 420/429.
 *    Writes MUST be serialized + backed off INSIDE this sink so no other
 *    component has to know about the limit.
 *  - Create incident: POST /pages/{page_id}/incidents
 *    Append update:   PATCH /pages/{page_id}/incidents/{id} with new body+status
 *    Component status: PATCH /pages/{page_id}/components/{id}
 */
export class StatuspageSink implements StatusSink {
  constructor(
    private readonly apiKey: string,
    private readonly pageId: string,
  ) {}

  private notImplemented(): never {
    throw new Error(
      `StatuspageSink: NotImplemented (page ${this.pageId}, key set: ${Boolean(
        this.apiKey,
      )})`,
    );
  }

  openIncident(_input: OpenIncidentInput): Promise<Incident> {
    return this.notImplemented();
  }
  appendIncidentUpdate(
    _incidentId: string,
    _body: string,
    _status: IncidentStatus,
  ): Promise<IncidentUpdate> {
    return this.notImplemented();
  }
  setComponentStatus(
    _componentId: string,
    _status: ComponentStatus,
  ): Promise<void> {
    return this.notImplemented();
  }
  getIncident(_incidentId: string): Promise<Incident | null> {
    return this.notImplemented();
  }
  listComponents(): Promise<Component[]> {
    return this.notImplemented();
  }
}
