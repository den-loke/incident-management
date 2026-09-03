/// <reference types="@cloudflare/workers-types" />
// Scheduled maintenance. See ROADMAP.md → "Scheduled maintenance".
//
// A maintenance window is planned, has a start/end, and flips its affected
// components to 'under_maintenance' for the window — distinct from an incident
// (no post-mortem, no Slack incident channel). Activation/completion is
// cron-driven (reconcileMaintenance on the 1-min sweep), so it never needs a
// live timer and survives restarts. Single-tenant, opinionated: one fixed
// window shape, no recurrence builder.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { InternalStatusSink } from "../status/internalSink";

export type MaintenanceStatus = "scheduled" | "active" | "completed" | "cancelled";

export interface MaintenanceWindow {
  id: string;
  title: string;
  body: string | null;
  components: string[]; // component ids
  starts_at: string;
  ends_at: string;
  status: MaintenanceStatus;
  created_at: string;
}

interface MaintenanceRow {
  id: string;
  title: string;
  body: string | null;
  components: string; // JSON
  starts_at: string;
  ends_at: string;
  status: MaintenanceStatus;
  created_at: string;
}

function uid(): string {
  return `mw_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

function hydrate(row: MaintenanceRow): MaintenanceWindow {
  let components: string[] = [];
  try {
    const parsed = JSON.parse(row.components) as unknown;
    if (Array.isArray(parsed)) components = parsed.filter((c): c is string => typeof c === "string");
  } catch {
    /* leave empty */
  }
  return { ...row, components };
}

export interface ScheduleMaintenanceInput {
  title: string;
  body?: string;
  components?: string[];
  starts_at: string; // ISO
  ends_at: string; // ISO
}

/** Schedule a maintenance window. Validates start<end; components optional. */
export async function scheduleMaintenance(
  env: Env,
  input: ScheduleMaintenanceInput,
): Promise<MaintenanceWindow> {
  const id = uid();
  const components = JSON.stringify(input.components ?? []);
  await new D1Db(env.DB).run(
    `INSERT INTO maintenance_windows (id, title, body, components, starts_at, ends_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled')`,
    [id, input.title, input.body ?? null, components, input.starts_at, input.ends_at],
  );
  return {
    id,
    title: input.title,
    body: input.body ?? null,
    components: input.components ?? [],
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    status: "scheduled",
    created_at: nowIso(),
  };
}

/** List windows that are not yet completed/cancelled, plus recently completed. */
export async function listMaintenance(env: Env, limit = 25): Promise<MaintenanceWindow[]> {
  const rows = await new D1Db(env.DB).all<MaintenanceRow>(
    `SELECT * FROM maintenance_windows
      ORDER BY (status IN ('scheduled','active')) DESC, starts_at DESC
      LIMIT ?`,
    [limit],
  );
  return rows.map(hydrate);
}

/** Cancel a scheduled/active window and restore its components. */
export async function cancelMaintenance(env: Env, id: string): Promise<boolean> {
  const db = new D1Db(env.DB);
  const row = await db.get<MaintenanceRow>("SELECT * FROM maintenance_windows WHERE id = ?", [id]);
  if (!row || row.status === "completed" || row.status === "cancelled") return false;
  if (row.status === "active") {
    await restoreComponents(env, hydrate(row));
  }
  await db.run("UPDATE maintenance_windows SET status = 'cancelled' WHERE id = ?", [id]);
  return true;
}

async function setComponents(env: Env, ids: string[], status: "under_maintenance" | "operational"): Promise<void> {
  const sink = new InternalStatusSink(new D1Db(env.DB));
  for (const cid of ids) {
    await sink.setComponentStatus(cid, status);
  }
}
async function activateComponents(env: Env, w: MaintenanceWindow): Promise<void> {
  await setComponents(env, w.components, "under_maintenance");
}
async function restoreComponents(env: Env, w: MaintenanceWindow): Promise<void> {
  // On completion, restore to operational. (Single-tenant: we don't snapshot the
  // prior per-component status; operational is the correct post-maintenance state.)
  await setComponents(env, w.components, "operational");
}

/**
 * Cron reconcile: activate windows whose start has passed, complete windows whose
 * end has passed. Idempotent — flips components only on the transition. Called on
 * the 1-min sweep alongside escalation.
 */
export async function reconcileMaintenance(
  env: Env,
  now: Date = new Date(),
): Promise<{ activated: number; completed: number }> {
  const db = new D1Db(env.DB);
  const iso = now.toISOString();
  let activated = 0;
  let completed = 0;

  // scheduled → active (start reached, end not yet)
  const toActivate = await db.all<MaintenanceRow>(
    "SELECT * FROM maintenance_windows WHERE status = 'scheduled' AND starts_at <= ? AND ends_at > ?",
    [iso, iso],
  );
  for (const row of toActivate) {
    const w = hydrate(row);
    await activateComponents(env, w);
    await db.run("UPDATE maintenance_windows SET status = 'active' WHERE id = ?", [w.id]);
    activated++;
  }

  // scheduled|active → completed (end reached)
  const toComplete = await db.all<MaintenanceRow>(
    "SELECT * FROM maintenance_windows WHERE status IN ('scheduled','active') AND ends_at <= ?",
    [iso],
  );
  for (const row of toComplete) {
    const w = hydrate(row);
    // If it activated components (or would have), restore them now.
    await restoreComponents(env, w);
    await db.run("UPDATE maintenance_windows SET status = 'completed' WHERE id = ?", [w.id]);
    completed++;
  }

  return { activated, completed };
}
