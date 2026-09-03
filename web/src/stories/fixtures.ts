import type { Component, Incident, StatusResponse } from "@/types";

const viewer = { user_id: "U_DEMO", name: "Den" };

export const componentsAllGreen: Component[] = [
  { id: "c_api", name: "API", status: "operational", updated_at: "" },
  { id: "c_dash", name: "Dashboard", status: "operational", updated_at: "" },
  { id: "c_hook", name: "Webhooks", status: "operational", updated_at: "" },
];

export const componentsMixed: Component[] = [
  { id: "c_api", name: "API", status: "major_outage", updated_at: "" },
  { id: "c_dash", name: "Dashboard", status: "operational", updated_at: "" },
  { id: "c_hook", name: "Webhooks", status: "degraded_performance", updated_at: "" },
  { id: "c_db", name: "Database", status: "partial_outage", updated_at: "" },
  { id: "c_cdn", name: "CDN", status: "under_maintenance", updated_at: "" },
];

export const activeIncident: Incident = {
  id: "inc_active",
  name: "Checkout returning 500s",
  status: "investigating",
  severity: "sev1",  created_at: "2026-09-02T04:30:00Z",
  resolved_at: null,
  roles: [
    {
      incident_id: "inc_active",
      role: "engineering_lead",
      slack_user_id: "U_ALICE",
      assigned_at: "2026-09-02T04:32:00Z",
    },
  ],
  pending_resolution: null,
  channel: "C0DEMO123",
  updates: [
    {
      id: "u2",
      incident_id: "inc_active",
      body: "Root cause identified: a bad deploy. Rolling back now.",
      status: "identified",
      created_at: "2026-09-02T04:40:00Z",
    },
    {
      id: "u1",
      incident_id: "inc_active",
      body: "We are investigating a spike in 500s on /checkout (~20% of requests).",
      status: "investigating",
      created_at: "2026-09-02T04:31:00Z",
    },
  ],
};

export const resolvedIncident: Incident = {
  id: "inc_resolved",
  name: "Elevated webhook latency",
  status: "resolved",
  severity: "sev3",
  created_at: "2026-09-01T22:00:00Z",
  resolved_at: "2026-09-01T22:45:00Z",
  roles: [],
  pending_resolution: null,
  channel: "C0DEMO123",
  updates: [
    {
      id: "r2",
      incident_id: "inc_resolved",
      body: "Backlog cleared, latency normal. Resolved.",
      status: "resolved",
      created_at: "2026-09-01T22:45:00Z",
    },
    {
      id: "r1",
      incident_id: "inc_resolved",
      body: "Webhook processing latency elevated; investigating.",
      status: "investigating",
      created_at: "2026-09-01T22:00:00Z",
    },
  ],
};

export function response(
  components: Component[],
  incidents: Incident[],
): StatusResponse {
  return { viewer, components, incidents };
}

export const allOperational = response(componentsAllGreen, []);
export const activeIncidentState = response(componentsMixed, [activeIncident, resolvedIncident]);
export const emptyState = response([], []);
