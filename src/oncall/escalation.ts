/// <reference types="@cloudflare/workers-types" />
// On-call escalation ladder. See docs/SPEC_ONCALL.md §3.
//
// Three levels, each firing only if the previous went unacked for
// ONCALL_ACK_TIMEOUT_MIN:
//   L0 primary on-call → L1 next responder + @ONCALL_MANAGER → L2 @channel broadcast.
// Timeout firing is cron-driven (sweepEscalations), not a live timer, so it
// survives restarts. L2 is terminal. Any allow-listed user may ack (stops the ladder).

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { AlertRow } from "./alerts";
import { getAlert } from "./alerts";
import { whoIsOnCall, nextResponder, type Responder } from "./rotation";
import { pageViaSlack } from "./notifier";

const DEFAULT_ACK_TIMEOUT_MIN = 10;
const MAX_LEVEL = 2;

function uid(): string {
  return `esc_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}
function ackTimeoutMs(env: Env): number {
  const n = Number(env.ONCALL_ACK_TIMEOUT_MIN);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_ACK_TIMEOUT_MIN) * 60_000;
}

/**
 * Which Slack channel to page in for an alert: the linked incident's channel if
 * the alert was promoted, else ONCALL_FALLBACK_CHANNEL. Returns null if neither
 * exists (nowhere to page — caller skips rather than erroring).
 */
async function alertsChannel(env: Env, alert: AlertRow): Promise<string | null> {
  if (alert.incident_id) {
    const row = await new D1Db(env.DB).get<{ channel: string }>(
      "SELECT channel FROM incident_channels WHERE incident_id = ?",
      [alert.incident_id],
    );
    if (row?.channel) return row.channel;
  }
  return env.ONCALL_FALLBACK_CHANNEL ?? null;
}

/** Who to page at a given level. L2 has no specific target (broadcast). */
async function targetFor(env: Env, level: number): Promise<Responder | null> {
  if (level >= MAX_LEVEL) return null;
  const primary = await whoIsOnCall(env);
  if (level === 0) return primary;
  // Level 1: the next responder after the primary in rotation order.
  if (!primary) return null;
  return nextResponder(env, primary.id);
}

async function fireLevel(env: Env, alert: AlertRow, level: number): Promise<void> {
  const channel = await alertsChannel(env, alert);
  if (!channel) return; // nowhere to page; empty-rotation-safe, no error.
  const target = await targetFor(env, level);
  const page = await pageViaSlack(env, channel, alert, level, target);
  const db = new D1Db(env.DB);
  await db.run(
    `INSERT INTO oncall_escalations (id, alert_id, level, target, channel, provider_sid, fired_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uid(),
      alert.id,
      level,
      level >= MAX_LEVEL ? channel : target?.id ?? channel,
      page.channel,
      page.provider_sid ?? null,
      nowIso(),
    ],
  );
}

/**
 * Fire level 0 for a genuinely-new firing alert. Called from POST /api/alerts
 * when ingestAlert returns result:'created'.
 */
export async function escalateNew(env: Env, alert: AlertRow): Promise<void> {
  await fireLevel(env, alert, 0);
}

interface LatestEsc {
  alert_id: string;
  level: number;
  fired_at: string;
  acked_at: string | null;
}

/**
 * Cron sweep: for each firing alert, if its newest escalation row is unacked and
 * older than the ack timeout, fire the next level (up to L2, which is terminal).
 * Drives the ladder without live timers.
 */
export async function sweepEscalations(
  env: Env,
  now: Date = new Date(),
): Promise<{ escalated: number }> {
  const db = new D1Db(env.DB);
  // Newest escalation per still-firing alert.
  const rows = await db.all<LatestEsc>(
    `SELECT e.alert_id, e.level, e.fired_at, e.acked_at
       FROM oncall_escalations e
       JOIN oncall_alerts a ON a.id = e.alert_id
      WHERE a.status = 'firing'
        AND e.fired_at = (
          SELECT MAX(e2.fired_at) FROM oncall_escalations e2 WHERE e2.alert_id = e.alert_id
        )`,
  );
  const cutoff = now.getTime() - ackTimeoutMs(env);
  let escalated = 0;
  for (const r of rows) {
    if (r.acked_at) continue; // acked → ladder stopped
    if (r.level >= MAX_LEVEL) continue; // L2 is terminal
    if (new Date(r.fired_at).getTime() > cutoff) continue; // not timed out yet
    const alert = await getAlert(env, r.alert_id);
    if (!alert || alert.status !== "firing") continue;
    await fireLevel(env, alert, r.level + 1);
    escalated++;
  }
  return { escalated };
}

/**
 * Promote an alert to a full incident (button-only, never automatic). Declares
 * an incident from the alert and links it back, so subsequent pages for this
 * alert route to the incident's channel. Idempotent: if already linked, no-op.
 */
export async function promoteAlertToIncident(
  env: Env,
  alertId: string,
): Promise<{ incidentId: string } | null> {
  const alert = await getAlert(env, alertId);
  if (!alert) return null;
  if (alert.incident_id) return { incidentId: alert.incident_id };

  const { declareIncident } = await import("../incidents/commands");
  const { incidentId } = await declareIncident(
    env,
    alert.title,
    alert.body ?? undefined,
    (alert.severity as never) ?? undefined,
  );
  await new D1Db(env.DB).run("UPDATE oncall_alerts SET incident_id = ? WHERE id = ?", [
    incidentId,
    alertId,
  ]);
  return { incidentId };
}

export type AckOutcome =
  | { result: "acked"; alertId: string }
  | { result: "ignored"; reason: "no_open_escalation" | "already_acked" };

/**
 * Acknowledge an alert: stamp the newest escalation row, set the alert to 'ack',
 * stop the ladder. Any allow-listed user may ack. Idempotent.
 */
export async function ackAlert(
  env: Env,
  alertId: string,
  userId: string,
): Promise<AckOutcome> {
  const db = new D1Db(env.DB);
  const latest = await db.get<{ id: string; acked_at: string | null }>(
    "SELECT id, acked_at FROM oncall_escalations WHERE alert_id = ? ORDER BY fired_at DESC LIMIT 1",
    [alertId],
  );
  if (!latest) return { result: "ignored", reason: "no_open_escalation" };
  if (latest.acked_at) return { result: "ignored", reason: "already_acked" };

  await db.run(
    "UPDATE oncall_escalations SET acked_at = ?, acked_by = ? WHERE id = ?",
    [nowIso(), userId, latest.id],
  );
  await db.run("UPDATE oncall_alerts SET status = 'ack' WHERE id = ? AND status = 'firing'", [alertId]);
  return { result: "acked", alertId };
}
