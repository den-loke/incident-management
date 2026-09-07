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

// Fixed severity scale (single-tenant — not configurable). Orthogonal to status.
export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  sev1: "SEV1 · Major",
  sev2: "SEV2 · Partial",
  sev3: "SEV3 · Minor",
};
/** Rank for comparisons (higher = worse). */
export const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  sev1: 3,
  sev2: 2,
  sev3: 1,
};

/** Type guard: is this an incident severity string? */
export function isIncidentSeverity(v: unknown): v is IncidentSeverity {
  return typeof v === "string" && (INCIDENT_SEVERITIES as readonly string[]).includes(v);
}

// Fixed set of incident ROUTING PATHS (single-tenant — not a routing-rule builder).
// The path is the incident's SHAPE, chosen at declare:
//   internal = our own systems, full response (both roles, on-call engaged).
//   external = an upstream/partner issue we mostly COMMUNICATE (Support Lead only,
//              no Engineering Lead, no on-call page).
export const ROUTING_PATHS = ["internal", "external"] as const;
export type RoutingPath = (typeof ROUTING_PATHS)[number];
export const ROUTING_PATH_LABEL: Record<RoutingPath, string> = {
  internal: "Internal (our systems)",
  external: "External (upstream / partner)",
};
export function isRoutingPath(v: unknown): v is RoutingPath {
  return typeof v === "string" && (ROUTING_PATHS as readonly string[]).includes(v);
}

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
  severity: IncidentSeverity;
  routing_path: RoutingPath;
  created_at: string;
  resolved_at: string | null;
  /** First time status reached 'identified' (or beyond); null if never. */
  identified_at: string | null;
  /** When the incident was closed. Mirrors resolved_at today; kept distinct. */
  closed_at: string | null;
  /** Bumped on every status change / appended update. Never null after 0015. */
  last_updated_at: string | null;
}

/** Status rank for lifecycle comparisons (monotonic forward progression). */
export const STATUS_RANK: Record<IncidentStatus, number> = {
  investigating: 0,
  identified: 1,
  monitoring: 2,
  resolved: 3,
};

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
  severity?: IncidentSeverity; // defaults to "sev2"
  routingPath?: RoutingPath; // defaults to "internal"
  body?: string; // optional first update
}
