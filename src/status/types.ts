// Status model types. Mirror the SQL CHECK constraints 1:1 (see migrations/0001_init.sql)
// and Statuspage's own component/incident vocabularies. See docs/ARCHITECTURE.md §5.

export const COMPONENT_STATUSES = [
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
  "under_maintenance",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export const INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export interface Component {
  id: string;
  name: string;
  status: ComponentStatus;
  updated_at: string;
}

export interface Incident {
  id: string;
  name: string;
  status: IncidentStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  body: string;
  status: IncidentStatus;
  created_at: string;
}

export interface OpenIncidentInput {
  id?: string; // generated if omitted
  name: string;
  status?: IncidentStatus; // defaults to "investigating"
  body?: string; // optional first update
}
