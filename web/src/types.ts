// Shapes returned by GET /api/status. Kept in step with the Worker's D1 model.
export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance";

export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export type IncidentSeverity = "sev1" | "sev2" | "sev3";

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  sev1: "SEV1",
  sev2: "SEV2",
  sev3: "SEV3",
};

export type RoutingPath = "internal" | "external";
export const ROUTING_PATH_LABEL: Record<RoutingPath, string> = {
  internal: "Internal",
  external: "External",
};

// --- Response teams (GET /api/teams) — linked Slack user groups, read-only ---
export interface Team {
  key: "engineering" | "support" | "stakeholders";
  label: string;
  usergroup_id: string | null;
  members: string[];
  configured: boolean;
}

export interface Component {
  id: string;
  name: string;
  status: ComponentStatus;
  updated_at: string;
}

export interface IncidentUpdate {
  id: string;
  incident_id: string;
  body: string;
  status: IncidentStatus;
  created_at: string;
}

export interface Incident {
  id: string;
  name: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  routing_path: RoutingPath;
  created_at: string;
  resolved_at: string | null;
  updates: IncidentUpdate[];
  roles: RoleAssignment[];
  pending_resolution: PendingResolution | null;
  channel: string | null;
}

export type IncidentRole = "engineering_lead" | "customer_support_lead";

export const ROLE_LABEL: Record<IncidentRole, string> = {
  engineering_lead: "Engineering Lead",
  customer_support_lead: "Customer Support Lead",
};

export interface RoleAssignment {
  incident_id: string;
  role: IncidentRole;
  slack_user_id: string;
  assigned_at: string;
}

export interface PendingResolution {
  requested_by: string;
  requested_at: string;
  note: string | null;
}

export interface Viewer {
  user_id: string;
  name: string;
}

export interface StatusResponse {
  viewer: Viewer;
  components: Component[];
  incidents: Incident[];
  maintenance: MaintenanceWindow[];
  /** Slack user id → display name, for rendering @mentions as names. */
  user_names?: Record<string, string>;
}

export type MaintenanceStatus = "scheduled" | "active" | "completed" | "cancelled";
export interface MaintenanceWindow {
  id: string;
  title: string;
  body: string | null;
  components: string[];
  starts_at: string;
  ends_at: string;
  status: MaintenanceStatus;
  created_at: string;
}
export const MAINTENANCE_LABEL: Record<MaintenanceStatus, string> = {
  scheduled: "Scheduled",
  active: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

// --- Insights (GET /api/insights) ---
export interface InsightsBucket {
  key: string;
  count: number;
  mttr_seconds: number | null;
}
export interface InsightsMonthPoint {
  month: string;
  opened: number;
  resolved: number;
}
export interface Insights {
  from: string;
  to: string;
  total_opened: number;
  by_severity: InsightsBucket[];
  by_routing_path: InsightsBucket[];
  by_month: InsightsMonthPoint[];
  open_action_items: number;
  overall_mttr_seconds: number | null;
}

// --- Follow-ups + history (GET /api/followups, /api/history) ---
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

export const COMPONENT_LABEL: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded_performance: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Maintenance",
};

export const INCIDENT_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

// --- On-call section (GET /api/oncall) ---
export interface OncallResponder {
  id: string;
  name: string;
  phone: string | null;
  active: number;
  sort_order: number;
}

export interface OncallEscalationTrailRow {
  level: number;
  target: string;
  channel: string; // 'slack' | 'sms' | 'voice'
  fired_at: string;
  acked_at: string | null;
  acked_by: string | null;
}

export interface OncallOpenAlert {
  id: string;
  title: string;
  body: string | null;
  severity: string | null;
  status: "firing" | "ack" | "resolved";
  incident_id: string | null;
  received_at: string;
  trail: OncallEscalationTrailRow[];
}

export interface OncallRotationShift {
  responder: string;
  responder_name: string | null;
  starts_at: string;
  ends_at: string;
  is_override: number;
}

export interface OncallEscalationPathStep {
  level: number;
  title: string;
  detail: string;
  wait_minutes: number | null;
}
export interface OncallEscalationPath {
  ack_timeout_minutes: number;
  fallback_channel: string | null;
  manager: string | null;
  steps: OncallEscalationPathStep[];
}
export interface OncallEscalationEvent {
  id: string;
  alert_id: string;
  alert_title: string;
  alert_status: "firing" | "ack" | "resolved";
  incident_id: string | null;
  level: number;
  target: string;
  channel: string;
  fired_at: string;
  acked_at: string | null;
  acked_by: string | null;
}

export interface OncallSection {
  now: OncallResponder | null;
  next: OncallResponder | null;
  responders: OncallResponder[];
  upcoming: OncallRotationShift[];
  open_alerts: OncallOpenAlert[];
  path: OncallEscalationPath;
  escalation_events: OncallEscalationEvent[];
  user_names?: Record<string, string>;
}
