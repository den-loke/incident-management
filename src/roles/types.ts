// Incident role model. Two claimable, transferable roles. See ROADMAP.md.

export const INCIDENT_ROLES = [
  "engineering_lead",
  "customer_support_lead",
] as const;
export type IncidentRole = (typeof INCIDENT_ROLES)[number];

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

export function isIncidentRole(v: unknown): v is IncidentRole {
  return typeof v === "string" && (INCIDENT_ROLES as readonly string[]).includes(v);
}
