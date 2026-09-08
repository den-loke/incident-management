// Numeric incident durations derived from lifecycle timestamps (migration 0015).
// Server-side counterpart to the web's deriveDurations (which formats strings);
// the MCP surface returns raw seconds so agents can compute/compare freely.

import type { Incident } from "../status/types";

function secondsBetween(from: string, to: string): number | null {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

export interface DurationsSeconds {
  /** created_at → (resolved_at | now). */
  total_seconds: number | null;
  /** created_at → identified_at (time to detect/acknowledge). */
  time_to_identify_seconds: number | null;
  /** created_at → resolved_at (time to fix). */
  time_to_resolve_seconds: number | null;
}

export function deriveDurationsSeconds(incident: Incident): DurationsSeconds {
  const end = incident.resolved_at ?? new Date().toISOString();
  return {
    total_seconds: secondsBetween(incident.created_at, end),
    time_to_identify_seconds: incident.identified_at
      ? secondsBetween(incident.created_at, incident.identified_at)
      : null,
    time_to_resolve_seconds: incident.resolved_at
      ? secondsBetween(incident.created_at, incident.resolved_at)
      : null,
  };
}
