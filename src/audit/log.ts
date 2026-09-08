/// <reference types="@cloudflare/workers-types" />
// Append-only audit log. See migrations/0017_audit_log.sql and ROADMAP → "Audit log".
//
// recordAudit is BEST-EFFORT and never throws: an audit failure must not fail the
// action being audited. Records are written at the surface boundary (web route /
// Slack interactivity), where the actor is known, so no internal service needs an
// actor parameter threaded through it.

import type { Env } from "../env";
import { D1Db } from "../status/d1";

export type AuditSource = "web" | "slack" | "system";

export interface AuditEntry {
  actor: string;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  detail?: Record<string, unknown> | null;
  source?: AuditSource;
}

export interface AuditRow {
  id: string;
  at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null; // JSON string as stored
  source: string;
}

function uid(): string {
  return `aud_${crypto.randomUUID()}`;
}

/**
 * Append one audit record. Never throws — on any DB error it swallows and
 * returns, because losing an audit line must never break the audited action.
 */
export async function recordAudit(env: Env, entry: AuditEntry): Promise<void> {
  try {
    await new D1Db(env.DB).run(
      `INSERT INTO audit_log (id, actor, action, target_type, target_id, detail, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uid(),
        entry.actor,
        entry.action,
        entry.target_type ?? null,
        entry.target_id ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.source ?? "web",
      ],
    );
  } catch {
    /* best-effort: never fail the audited action on an audit write error */
  }
}

export interface AuditView {
  id: string;
  at: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  source: string;
}

/** Newest-first audit entries, optionally scoped to one target. */
export async function listAudit(
  env: Env,
  opts: { limit?: number; targetId?: string } = {},
): Promise<AuditView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const db = new D1Db(env.DB);
  const rows = opts.targetId
    ? await db.all<AuditRow>(
        "SELECT * FROM audit_log WHERE target_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
        [opts.targetId, limit],
      )
    : await db.all<AuditRow>("SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?", [limit]);
  return rows.map((r) => ({
    ...r,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}
