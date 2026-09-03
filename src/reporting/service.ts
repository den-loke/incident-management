/// <reference types="@cloudflare/workers-types" />
// Reporting: aggregate incident metrics over a time window, computed from the
// data we already record (incidents, incident_updates, components, action items).
// See ROADMAP.md. Pure over the Db port so it is unit-testable.

import type { Db } from "../status/sink";

export interface Report {
  /** ISO window bounds (inclusive from, exclusive to). */
  from: string;
  to: string;
  /** Incidents opened within the window. */
  opened: number;
  /** Incidents resolved within the window. */
  resolved: number;
  /** Currently-open incidents (regardless of window). */
  open_now: number;
  /**
   * Mean time to resolve (seconds), over incidents RESOLVED in the window.
   * null when none resolved.
   */
  mttr_seconds: number | null;
  /**
   * Mean time to acknowledge (seconds): time from open to the first update
   * after the opening one, over incidents opened in the window. A proxy — we
   * have no explicit ack event — documented as such. null when unavailable.
   */
  mtta_seconds: number | null;
  /** Open action items across all post-mortems (backlog). */
  open_action_items: number;
}

interface IncidentRow {
  id: string;
  created_at: string;
  resolved_at: string | null;
}

function secondsBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 1000;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Build a report for [from, to). Bounds are ISO strings; callers derive them
 * from a period (e.g. last 30 days).
 */
export async function buildReport(
  db: Db,
  from: string,
  to: string,
): Promise<Report> {
  const opened = await db.all<IncidentRow>(
    "SELECT id, created_at, resolved_at FROM incidents WHERE created_at >= ? AND created_at < ?",
    [from, to],
  );
  const resolvedInWindow = await db.all<IncidentRow>(
    "SELECT id, created_at, resolved_at FROM incidents WHERE resolved_at >= ? AND resolved_at < ?",
    [from, to],
  );
  const openNowRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM incidents WHERE status != 'resolved'",
  );
  const backlogRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM postmortem_action_items WHERE done = 0",
  );

  // MTTR: created -> resolved, over incidents resolved in the window.
  const mttrs = resolvedInWindow
    .filter((r) => r.resolved_at)
    .map((r) => secondsBetween(r.created_at, r.resolved_at as string))
    .filter((s) => s >= 0);

  // MTTA proxy: open -> first update after the opening one, over opened incidents.
  const mttas: number[] = [];
  for (const inc of opened) {
    const updates = await db.all<{ created_at: string }>(
      "SELECT created_at FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
      [inc.id],
    );
    // updates[0] is the opening update (same instant as created); the next one
    // is the first human/engine acknowledgement.
    if (updates.length >= 2) {
      const s = secondsBetween(inc.created_at, updates[1].created_at);
      if (s >= 0) mttas.push(s);
    }
  }

  return {
    from,
    to,
    opened: opened.length,
    resolved: resolvedInWindow.length,
    open_now: openNowRow?.n ?? 0,
    mttr_seconds: mean(mttrs),
    mtta_seconds: mean(mttas),
    open_action_items: backlogRow?.n ?? 0,
  };
}

/** Map a period token (7d/30d/90d/all) to an ISO [from, to) window ending now. */
export function periodWindow(
  period: string,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now.toISOString();
  const days: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
  if (period === "all") return { from: "1970-01-01T00:00:00.000Z", to };
  const d = days[period] ?? 30;
  const from = new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/** Render a report as a small CSV (metric,value). Seconds shown as-is. */
export function reportToCsv(r: Report): string {
  const rows: [string, string | number][] = [
    ["from", r.from],
    ["to", r.to],
    ["opened", r.opened],
    ["resolved", r.resolved],
    ["open_now", r.open_now],
    ["mttr_seconds", r.mttr_seconds ?? ""],
    ["mtta_seconds", r.mtta_seconds ?? ""],
    ["open_action_items", r.open_action_items],
  ];
  return (
    "metric,value\n" +
    rows.map(([k, v]) => `${k},${String(v).replace(/"/g, '""')}`).join("\n") +
    "\n"
  );
}
