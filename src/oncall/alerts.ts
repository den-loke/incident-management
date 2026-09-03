/// <reference types="@cloudflare/workers-types" />
// On-call alert ingestion. See docs/SPEC_ONCALL.md §4.
//
// One generic HTTP source: monitoring tools (Datadog/Grafana/Alertmanager) POST
// a signed JSON body. This slice persists, dedups by key, and auto-resolves on
// recovery. Escalation (paging the on-call) is wired in slice 3 — ingestAlert
// returns the outcome so the caller/sweep can act on a genuinely new firing.

import type { Env } from "../env";
import { D1Db } from "../status/d1";

export interface AlertInput {
  title: string;
  body?: string;
  severity?: string;
  dedup_key?: string;
  status?: "firing" | "resolved";
  source?: string;
}

export interface AlertRow {
  id: string;
  source: string;
  dedup_key: string | null;
  title: string;
  body: string | null;
  severity: string | null;
  status: "firing" | "ack" | "resolved";
  incident_id: string | null;
  received_at: string;
}

export type IngestOutcome =
  | { result: "created"; alert: AlertRow } // genuinely new firing → slice 3 pages
  | { result: "deduped"; alert: AlertRow } // folded into an existing open alert
  | { result: "resolved"; count: number } // recovery closed matching open alerts
  | { result: "noop" }; // resolved with nothing open to close

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

async function openByDedup(
  db: D1Db,
  dedupKey: string,
): Promise<AlertRow[]> {
  return db.all<AlertRow>(
    "SELECT * FROM oncall_alerts WHERE dedup_key = ? AND status IN ('firing','ack') ORDER BY received_at",
    [dedupKey],
  );
}

/**
 * Ingest one alert.
 * - status:"resolved" → close every matching open alert by dedup_key (recovery).
 * - status:"firing" (default):
 *     - if an open alert with the same dedup_key exists → dedup (append a note),
 *     - else create a new firing alert (the caller/sweep escalates it in slice 3).
 * A firing alert with no dedup_key is always treated as new.
 */
export async function ingestAlert(
  env: Env,
  input: AlertInput,
): Promise<IngestOutcome> {
  const db = new D1Db(env.DB);
  const status = input.status ?? "firing";
  const dedupKey = input.dedup_key ?? null;

  if (status === "resolved") {
    if (!dedupKey) return { result: "noop" };
    const open = await openByDedup(db, dedupKey);
    if (open.length === 0) return { result: "noop" };
    for (const a of open) {
      await db.run("UPDATE oncall_alerts SET status = 'resolved' WHERE id = ?", [a.id]);
    }
    return { result: "resolved", count: open.length };
  }

  // firing
  if (dedupKey) {
    const open = await openByDedup(db, dedupKey);
    if (open.length > 0) {
      const primary = open[0];
      // Fold into the existing open alert rather than re-paging. Record the flap
      // in the body so responders see it recurred.
      const appended =
        (primary.body ? primary.body + "\n" : "") + `↻ re-fired at ${nowIso()}`;
      await db.run("UPDATE oncall_alerts SET body = ? WHERE id = ?", [appended, primary.id]);
      const refreshed = await db.get<AlertRow>(
        "SELECT * FROM oncall_alerts WHERE id = ?",
        [primary.id],
      );
      return { result: "deduped", alert: refreshed! };
    }
  }

  const id = uid("alert");
  await db.run(
    `INSERT INTO oncall_alerts (id, source, dedup_key, title, body, severity, status, received_at)
     VALUES (?, ?, ?, ?, ?, ?, 'firing', ?)`,
    [
      id,
      input.source ?? "http",
      dedupKey,
      input.title,
      input.body ?? null,
      input.severity ?? null,
      nowIso(),
    ],
  );
  const alert = await db.get<AlertRow>("SELECT * FROM oncall_alerts WHERE id = ?", [id]);
  return { result: "created", alert: alert! };
}

/** All open (firing/ack) alerts, newest first — for the web On-call section. */
export async function listOpenAlerts(env: Env): Promise<AlertRow[]> {
  return new D1Db(env.DB).all<AlertRow>(
    "SELECT * FROM oncall_alerts WHERE status IN ('firing','ack') ORDER BY received_at DESC",
  );
}

export async function getAlert(env: Env, id: string): Promise<AlertRow | null> {
  return new D1Db(env.DB).get<AlertRow>("SELECT * FROM oncall_alerts WHERE id = ?", [id]);
}
