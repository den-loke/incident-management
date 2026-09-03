import type { StatusResponse, IncidentStatus } from "@/types";

export class UnauthorizedError extends Error {}

/** Fetch the status payload. Throws UnauthorizedError on 401 so the app can show login. */
export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (res.status === 401) throw new UnauthorizedError("not signed in");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}

async function postJson(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
}

export function declareIncident(
  name: string,
  body?: string,
  severity?: string,
  routingPath?: string,
): Promise<void> {
  return postJson("/api/incidents", { name, body, severity, routing_path: routingPath });
}

export function setSeverity(incidentId: string, severity: string): Promise<void> {
  return fetch(`/api/incidents/${encodeURIComponent(incidentId)}/severity`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ severity }),
  }).then((r) => {
    if (!r.ok) throw new Error(`request failed (${r.status})`);
  });
}

export function postUpdate(
  incidentId: string,
  body: string,
  status?: IncidentStatus,
): Promise<void> {
  return postJson(`/api/incidents/${encodeURIComponent(incidentId)}/updates`, {
    body,
    status,
  });
}

export function requestResolve(incidentId: string, body?: string): Promise<void> {
  return postJson(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    body,
  });
}

export function confirmResolve(incidentId: string): Promise<void> {
  return postJson(`/api/incidents/${encodeURIComponent(incidentId)}/resolve/confirm`, {});
}

// --- Post-mortems ---

export interface ActionItem {
  id: string;
  description: string;
  owner: string | null;
  done: boolean;
  jira_key: string | null;
}
export interface Postmortem {
  id: string;
  incident_id: string;
  status: "draft" | "published";
  summary: string;
  impact: string;
  root_cause: string;
  contributing_factors: string;
  published_at: string | null;
  action_items: ActionItem[];
}
export interface PostmortemEdit {
  summary: string;
  impact: string;
  root_cause: string;
  contributing_factors: string;
  action_items: string[];
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (res.status === 401) throw new UnauthorizedError("not signed in");
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()) as T;
}

export function getPostmortem(incidentId: string): Promise<Postmortem | null> {
  return getJson(`/api/incidents/${encodeURIComponent(incidentId)}/postmortem`);
}

export type ChecklistState = "done" | "pending" | "blocked";
export interface ChecklistItem {
  key: string;
  label: string;
  state: ChecklistState;
  detail: string;
}
export interface PostIncidentFlow {
  incident_id: string;
  complete: boolean;
  items: ChecklistItem[];
}
export function getPostIncidentFlow(incidentId: string): Promise<PostIncidentFlow | null> {
  return getJson(`/api/incidents/${encodeURIComponent(incidentId)}/post-incident-flow`);
}
export function generatePostmortem(incidentId: string): Promise<Postmortem> {
  return fetch(`/api/incidents/${encodeURIComponent(incidentId)}/postmortem`, {
    method: "POST",
    credentials: "same-origin",
  }).then((r) => {
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json() as Promise<Postmortem>;
  });
}
export function savePostmortem(incidentId: string, edit: PostmortemEdit): Promise<Postmortem> {
  return putJson(`/api/incidents/${encodeURIComponent(incidentId)}/postmortem`, edit);
}
export function publishPostmortem(incidentId: string): Promise<void> {
  return postJson(`/api/incidents/${encodeURIComponent(incidentId)}/postmortem/publish`, {});
}
export function toggleActionItem(itemId: string, done: boolean): Promise<void> {
  return postJson(`/api/postmortem-action-items/${encodeURIComponent(itemId)}`, { done });
}

// --- Reporting ---

export interface Report {
  from: string;
  to: string;
  opened: number;
  resolved: number;
  open_now: number;
  mttr_seconds: number | null;
  mtta_seconds: number | null;
  open_action_items: number;
}

export function getReport(period: string): Promise<Report> {
  return fetch(`/api/reports?period=${encodeURIComponent(period)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).then((r) => {
    if (r.status === 401) throw new UnauthorizedError("not signed in");
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json() as Promise<Report>;
  });
}

export function reportCsvUrl(period: string): string {
  return `/api/reports?period=${encodeURIComponent(period)}&format=csv`;
}

// --- On-call ---

export function fetchOncall(): Promise<import("@/types").OncallSection> {
  return fetch("/api/oncall", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).then((r) => {
    if (r.status === 401) throw new UnauthorizedError("not signed in");
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json() as Promise<import("@/types").OncallSection>;
  });
}

export function ackAlert(alertId: string): Promise<void> {
  return postJson(`/api/oncall/alerts/${encodeURIComponent(alertId)}/ack`, {});
}

export function promoteAlert(alertId: string): Promise<void> {
  return postJson(`/api/oncall/alerts/${encodeURIComponent(alertId)}/promote`, {});
}

export function setOncallOverride(
  responder: string,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  return postJson("/api/oncall/overrides", {
    responder,
    starts_at: startsAt,
    ends_at: endsAt,
  });
}

// --- Scheduled maintenance ---

export function scheduleMaintenance(input: {
  title: string;
  body?: string;
  components?: string[];
  starts_at: string;
  ends_at: string;
}): Promise<void> {
  return postJson("/api/maintenance", input);
}

export function cancelMaintenance(id: string): Promise<void> {
  return postJson(`/api/maintenance/${encodeURIComponent(id)}/cancel`, {});
}

// --- Insights ---

export function fetchInsights(period: string): Promise<import("@/types").Insights> {
  return fetch(`/api/insights?period=${encodeURIComponent(period)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  }).then((r) => {
    if (r.status === 401) throw new UnauthorizedError("not signed in");
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json() as Promise<import("@/types").Insights>;
  });
}

// --- Follow-ups + history ---

function getList<T>(path: string, key: string): Promise<T[]> {
  return fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }).then((r) => {
    if (r.status === 401) throw new UnauthorizedError("not signed in");
    if (!r.ok) throw new Error(`request failed (${r.status})`);
    return r.json().then((j) => (j as Record<string, T[]>)[key] ?? []);
  });
}

export function fetchFollowUps(onlyOpen: boolean): Promise<import("@/types").FollowUp[]> {
  return getList(`/api/followups?open=${onlyOpen ? "1" : "0"}`, "followups");
}
export function fetchHistory(filters: { severity?: string; routing_path?: string } = {}): Promise<import("@/types").HistoryIncident[]> {
  const q = new URLSearchParams();
  if (filters.severity) q.set("severity", filters.severity);
  if (filters.routing_path) q.set("routing_path", filters.routing_path);
  const qs = q.toString();
  return getList(`/api/history${qs ? `?${qs}` : ""}`, "incidents");
}

export function fetchTeams(): Promise<import("@/types").Team[]> {
  return getList(`/api/teams`, "teams");
}
