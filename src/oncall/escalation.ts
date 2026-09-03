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
import { pageAlert, notifyPromotion } from "./notifier";

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
  const results = await pageAlert(env, channel, alert, level, target);
  const db = new D1Db(env.DB);
  // One row per channel that fired, all stamped with the SAME level and instant
  // so the ladder position is the row's `level` (not row count) and the sweep
  // keys on MAX(level). provider_sid lets a phone ack correlate back to a row.
  const firedAt = nowIso();
  const ladderTarget = level >= MAX_LEVEL ? channel : target?.id ?? channel;
  for (const page of results) {
    await db.run(
      `INSERT INTO oncall_escalations (id, alert_id, level, target, channel, provider_sid, fired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uid(),
        alert.id,
        level,
        ladderTarget,
        page.channel,
        page.provider_sid ?? null,
        firedAt,
      ],
    );
  }
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
  acked_any: number;
}

/**
 * Cron sweep: for each firing alert, look at its CURRENT ladder level (the max
 * level any escalation row reached). If no row at that level is acked and the
 * level's most recent page is older than the ack timeout, fire the next level
 * (up to L2, which is terminal). Keying on level (not row count) keeps this
 * correct now that one level can have several rows — Slack + SMS + voice.
 */
export async function sweepEscalations(
  env: Env,
  now: Date = new Date(),
): Promise<{ escalated: number }> {
  const db = new D1Db(env.DB);
  // Per still-firing alert: its max level, the newest fired_at AT that level,
  // and whether ANY row at that level has been acked.
  const rows = await db.all<LatestEsc>(
    `SELECT e.alert_id,
            e.level,
            MAX(e.fired_at) AS fired_at,
            MAX(CASE WHEN e.acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acked_any
       FROM oncall_escalations e
       JOIN oncall_alerts a ON a.id = e.alert_id
      WHERE a.status = 'firing'
        AND e.level = (
          SELECT MAX(e2.level) FROM oncall_escalations e2 WHERE e2.alert_id = e.alert_id
        )
      GROUP BY e.alert_id, e.level`,
  );
  const cutoff = now.getTime() - ackTimeoutMs(env);
  let escalated = 0;
  for (const r of rows) {
    if (r.acked_any) continue; // acked → ladder stopped
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

  // Capture the channel the alert was PAGING in before we link it (once linked,
  // alertsChannel() would resolve to the new incident channel instead).
  const pagingChannel = await alertsChannel(env, alert);

  const { declareIncident } = await import("../incidents/commands");
  const { incidentId, channelId } = await declareIncident(
    env,
    alert.title,
    alert.body ?? undefined,
    (alert.severity as never) ?? undefined,
  );
  await new D1Db(env.DB).run("UPDATE oncall_alerts SET incident_id = ? WHERE id = ?", [
    incidentId,
    alertId,
  ]);

  // Post the incident channel link back into the paging channel so responders
  // watching the alert can jump straight into the incident. (§5)
  if (pagingChannel && pagingChannel !== channelId) {
    await notifyPromotion(env, pagingChannel, channelId, incidentId);
  }
  return { incidentId };
}

export type AckOutcome =
  | { result: "acked"; alertId: string }
  | { result: "ignored"; reason: "no_open_escalation" | "already_acked" };

/**
 * Acknowledge an alert: stamp every unacked escalation row at the CURRENT ladder
 * level, set the alert to 'ack', stop the ladder. Any allow-listed user may ack.
 * Idempotent — a second ack (once already acked at the top level) no-ops.
 */
export async function ackAlert(
  env: Env,
  alertId: string,
  userId: string,
): Promise<AckOutcome> {
  const db = new D1Db(env.DB);
  const top = await db.get<{ level: number }>(
    "SELECT MAX(level) AS level FROM oncall_escalations WHERE alert_id = ?",
    [alertId],
  );
  if (top?.level === null || top?.level === undefined) {
    return { result: "ignored", reason: "no_open_escalation" };
  }
  const already = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM oncall_escalations WHERE alert_id = ? AND level = ? AND acked_at IS NOT NULL",
    [alertId, top.level],
  );
  if ((already?.n ?? 0) > 0) return { result: "ignored", reason: "already_acked" };

  await db.run(
    "UPDATE oncall_escalations SET acked_at = ?, acked_by = ? WHERE alert_id = ? AND level = ? AND acked_at IS NULL",
    [nowIso(), userId, alertId, top.level],
  );
  await db.run("UPDATE oncall_alerts SET status = 'ack' WHERE id = ? AND status = 'firing'", [alertId]);
  return { result: "acked", alertId };
}

/**
 * Phone ack via Twilio voice (press 1): correlate a Call SID back to its
 * escalation row, then ack the owning alert. Same terminal effect as the Slack
 * button — only the entry point differs (§3a).
 */
export async function ackAlertByProviderSid(
  env: Env,
  providerSid: string,
): Promise<AckOutcome> {
  const row = await new D1Db(env.DB).get<{ alert_id: string }>(
    "SELECT alert_id FROM oncall_escalations WHERE provider_sid = ? LIMIT 1",
    [providerSid],
  );
  if (!row) return { result: "ignored", reason: "no_open_escalation" };
  return ackAlert(env, row.alert_id, `twilio:${providerSid}`);
}

/**
 * Phone ack via Twilio SMS (reply Y/ACK): match the sender's E.164 number to a
 * responder, find their most recent firing alert paged to them, and ack it.
 */
export async function ackAlertByPhone(
  env: Env,
  fromPhone: string,
): Promise<AckOutcome> {
  const db = new D1Db(env.DB);
  const responder = await db.get<{ id: string }>(
    "SELECT id FROM oncall_responders WHERE phone = ? LIMIT 1",
    [fromPhone],
  );
  if (!responder) return { result: "ignored", reason: "no_open_escalation" };
  // Newest firing alert whose ladder targeted this responder.
  const esc = await db.get<{ alert_id: string }>(
    `SELECT e.alert_id
       FROM oncall_escalations e
       JOIN oncall_alerts a ON a.id = e.alert_id
      WHERE e.target = ? AND a.status = 'firing'
      ORDER BY e.fired_at DESC LIMIT 1`,
    [responder.id],
  );
  if (!esc) return { result: "ignored", reason: "no_open_escalation" };
  return ackAlert(env, esc.alert_id, responder.id);
}
