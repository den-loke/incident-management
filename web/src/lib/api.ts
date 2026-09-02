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

export function declareIncident(name: string, body?: string): Promise<void> {
  return postJson("/api/incidents", { name, body });
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

export function resolveIncident(incidentId: string, body?: string): Promise<void> {
  return postJson(`/api/incidents/${encodeURIComponent(incidentId)}/resolve`, {
    body,
  });
}
