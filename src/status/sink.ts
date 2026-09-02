import type {
  Component,
  ComponentStatus,
  Incident,
  IncidentStatus,
  IncidentUpdate,
  OpenIncidentInput,
} from "./types";

/**
 * Minimal DB port. Deliberately NOT the real D1 type, so sinks are unit-testable
 * against an in-memory fake. A thin D1 adapter satisfies this in production.
 */
export interface Db {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null>;
}

/**
 * The incident engine writes status through a StatusSink and is unaware of
 * fan-out. See docs/ARCHITECTURE.md §6.
 */
export interface StatusSink {
  // --- writes ---
  openIncident(input: OpenIncidentInput): Promise<Incident>;
  appendIncidentUpdate(
    incidentId: string,
    body: string,
    status: IncidentStatus,
  ): Promise<IncidentUpdate>;
  setComponentStatus(
    componentId: string,
    status: ComponentStatus,
  ): Promise<void>;

  // --- reads ---
  getIncident(incidentId: string): Promise<Incident | null>;
  listComponents(): Promise<Component[]>;
}
