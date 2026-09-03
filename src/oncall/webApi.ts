/// <reference types="@cloudflare/workers-types" />
// On-call web section — read model + session-gated actions. See docs/SPEC_ONCALL.md §6.
//
// The web mirror of on-call state: who's on now/next, this week's rotation, and
// the open alerts with their escalation trail. Actions (ack / create-incident /
// override) reuse the SAME service functions the Slack buttons drive
// (ackAlert / promoteAlertToIncident / setOverride), so Slack and web never
// diverge — the exact parity principle the incident command API already follows.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { whoIsOnCall, nextResponder, type Responder, type Shift } from "./rotation";
import { listOpenAlerts, type AlertRow } from "./alerts";

export interface EscalationTrailRow {
  level: number;
  target: string;
  channel: string; // 'slack' | 'sms' | 'voice'
  fired_at: string;
  acked_at: string | null;
  acked_by: string | null;
}

export interface OpenAlertView extends AlertRow {
  trail: EscalationTrailRow[];
}

export interface RotationShiftView {
  responder: string;
  responder_name: string | null;
  starts_at: string;
  ends_at: string;
  is_override: number;
}

export interface OncallSection {
  now: Responder | null;
  next: Responder | null;
  responders: Responder[];
  upcoming: RotationShiftView[];
  open_alerts: OpenAlertView[];
}

/** All responders (for the override picker), active first then by sort order. */
async function listResponders(env: Env): Promise<Responder[]> {
  return new D1Db(env.DB).all<Responder>(
    "SELECT id, name, phone, active, sort_order FROM oncall_responders ORDER BY active DESC, sort_order, id",
  );
}

/** Upcoming shifts (now → forward), soonest first, joined to responder names. */
async function listUpcomingShifts(env: Env, limit = 8): Promise<RotationShiftView[]> {
  const nowIso = new Date().toISOString();
  return new D1Db(env.DB).all<RotationShiftView>(
    `SELECT s.responder,
            r.name AS responder_name,
            s.starts_at,
            s.ends_at,
            s.is_override
       FROM oncall_shifts s
       LEFT JOIN oncall_responders r ON r.id = s.responder
      WHERE s.ends_at > ?
      ORDER BY s.starts_at ASC
      LIMIT ?`,
    [nowIso, limit],
  );
}

async function trailFor(db: D1Db, alertId: string): Promise<EscalationTrailRow[]> {
  return db.all<EscalationTrailRow>(
    `SELECT level, target, channel, fired_at, acked_at, acked_by
       FROM oncall_escalations WHERE alert_id = ? ORDER BY fired_at, level`,
    [alertId],
  );
}

/** Assemble the full on-call section payload for GET /api/oncall. */
export async function buildOncallSection(env: Env): Promise<OncallSection> {
  const db = new D1Db(env.DB);
  const now = await whoIsOnCall(env);
  const next = now ? await nextResponder(env, now.id) : null;
  const responders = await listResponders(env);
  const upcoming = await listUpcomingShifts(env);
  const alerts = await listOpenAlerts(env);
  const open_alerts: OpenAlertView[] = [];
  for (const a of alerts) {
    open_alerts.push({ ...a, trail: await trailFor(db, a.id) });
  }
  return { now, next, responders, upcoming, open_alerts };
}

export type { Responder, Shift };
