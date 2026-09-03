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
