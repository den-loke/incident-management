/// <reference types="@cloudflare/workers-types" />
// Insights — aggregate analytics dashboards over the data we already record
// (incidents: severity, routing_path, created_at, resolved_at; post-mortem action
// items). Builds on the reporting metrics; this adds the breakdowns + trend a
// dashboard shows. See ROADMAP.md → "Insights = dashboards". Pure over the Db port.

import type { Db } from "../status/sink";
import type { IncidentSeverity, RoutingPath } from "../status/types";

export interface Bucket {
  key: string;
  count: number;
  /** Mean time to resolve (seconds) for resolved incidents in this bucket; null if none. */
  mttr_seconds: number | null;
}

export interface MonthPoint {
  month: string; // "YYYY-MM"
  opened: number;
  resolved: number;
}

export interface Insights {
  from: string;
  to: string;
  total_opened: number;
  by_severity: Bucket[]; // sev1, sev2, sev3 (fixed order)
  by_routing_path: Bucket[]; // internal, external
  by_month: MonthPoint[]; // chronological, opened+resolved per month in window
  open_action_items: number;
  overall_mttr_seconds: number | null;
}

interface IncidentRow {
  severity: IncidentSeverity;
  routing_path: RoutingPath;
  created_at: string;
  resolved_at: string | null;
}

const SEVERITIES: IncidentSeverity[] = ["sev1", "sev2", "sev3"];
const PATHS: RoutingPath[] = ["internal", "external"];

function secondsBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 1000;
}
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}
function monthKey(iso: string): string {
  return iso.slice(0, 7); // "YYYY-MM"
}

/** Bucket incidents by a key extractor, computing count + MTTR per bucket. */
function bucketBy(
  rows: IncidentRow[],
  keys: string[],
  keyOf: (r: IncidentRow) => string,
): Bucket[] {
  return keys.map((key) => {
    const inBucket = rows.filter((r) => keyOf(r) === key);
    const mttrs = inBucket
      .filter((r) => r.resolved_at)
      .map((r) => secondsBetween(r.created_at, r.resolved_at as string))
      .filter((s) => s >= 0);
    return { key, count: inBucket.length, mttr_seconds: mean(mttrs) };
  });
}

/** Build insights for [from, to). */
export async function buildInsights(db: Db, from: string, to: string): Promise<Insights> {
  const opened = await db.all<IncidentRow>(
    "SELECT severity, routing_path, created_at, resolved_at FROM incidents WHERE created_at >= ? AND created_at < ?",
    [from, to],
  );
  const resolvedInWindow = await db.all<IncidentRow>(
    "SELECT severity, routing_path, created_at, resolved_at FROM incidents WHERE resolved_at >= ? AND resolved_at < ?",
    [from, to],
  );
  const backlogRow = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM postmortem_action_items WHERE done = 0",
  );

  // Monthly trend: opened per month (from `opened`) + resolved per month.
  const months = new Map<string, { opened: number; resolved: number }>();
  const touch = (m: string) => months.get(m) ?? { opened: 0, resolved: 0 };
  for (const r of opened) {
    const m = monthKey(r.created_at);
    const e = touch(m);
    e.opened++;
    months.set(m, e);
  }
  for (const r of resolvedInWindow) {
    if (!r.resolved_at) continue;
    const m = monthKey(r.resolved_at);
    const e = touch(m);
    e.resolved++;
    months.set(m, e);
  }
  const by_month: MonthPoint[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({ month, opened: v.opened, resolved: v.resolved }));

  const overallMttr = mean(
    resolvedInWindow
      .filter((r) => r.resolved_at)
      .map((r) => secondsBetween(r.created_at, r.resolved_at as string))
      .filter((s) => s >= 0),
  );

  return {
    from,
    to,
    total_opened: opened.length,
    by_severity: bucketBy(opened, SEVERITIES, (r) => r.severity),
    by_routing_path: bucketBy(opened, PATHS, (r) => r.routing_path),
    by_month,
    open_action_items: backlogRow?.n ?? 0,
    overall_mttr_seconds: overallMttr,
  };
}
