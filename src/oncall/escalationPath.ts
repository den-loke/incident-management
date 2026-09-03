/// <reference types="@cloudflare/workers-types" />
// Read-only escalation path (the ladder as a diagram) + a cross-alert escalation
// history. See ROADMAP → "Escalations (live list) + read-only escalation-path
// diagram". The ladder itself stays HARD-CODED (single-tenant stance) — this only
// EXPLAINS what happens when an escalation fires, annotated with the real
// ONCALL_* timings so the web can render incident.io's tree view without a builder.

import type { Env } from "../env";
import { D1Db } from "../status/d1";

const DEFAULT_ACK_TIMEOUT_MIN = 10;

export interface EscalationPathStep {
  level: number; // -1 = the initial page-the-channel step; 0/1/2 = ladder levels
  title: string;
  detail: string;
  wait_minutes: number | null; // how long before this step escalates onward (null = terminal)
}

export interface EscalationPath {
  ack_timeout_minutes: number;
  fallback_channel: string | null;
  manager: string | null;
  steps: EscalationPathStep[];
}

function ackTimeoutMin(env: Env): number {
  const n = Number(env.ONCALL_ACK_TIMEOUT_MIN);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACK_TIMEOUT_MIN;
}

/**
 * Derive the fixed escalation ladder as an ordered, annotated set of steps —
 * purely from config, no DB. Mirrors src/oncall/escalation.ts exactly:
 *   page channel → L0 primary → (timeout) L1 next + manager → (timeout) L2 @channel.
 */
export function buildEscalationPath(env: Env): EscalationPath {
  const wait = ackTimeoutMin(env);
  const manager = env.ONCALL_MANAGER ?? null;
  const fallback = env.ONCALL_FALLBACK_CHANNEL ?? null;

  const steps: EscalationPathStep[] = [
    {
      level: -1,
      title: "Alert fires",
      detail: fallback
        ? "Posted to the alerts channel (or the linked incident channel if promoted)."
        : "Posted to the linked incident channel. No fallback channel configured.",
      wait_minutes: 0,
    },
    {
      level: 0,
      title: "L0 — Primary on-call",
      detail: "Page the responder currently on call (Slack, and SMS/voice if Twilio is configured).",
      wait_minutes: wait,
    },
    {
      level: 1,
      title: "L1 — Next responder + manager",
      detail: manager
        ? `Also page the next responder in rotation and mention the manager (<@${manager}>).`
        : "Also page the next responder in rotation. No manager configured.",
      wait_minutes: wait,
    },
    {
      level: 2,
      title: "L2 — Broadcast",
      detail: "Broadcast to @channel in the alerts channel. Terminal — the ladder stops here.",
      wait_minutes: null,
    },
  ];
  return { ack_timeout_minutes: wait, fallback_channel: fallback, manager, steps };
}

export interface EscalationEventView {
  id: string;
  alert_id: string;
  alert_title: string;
  alert_status: "firing" | "ack" | "resolved";
  incident_id: string | null;
  level: number;
  target: string;
  channel: string; // 'slack' | 'sms' | 'voice'
  fired_at: string;
  acked_at: string | null;
  acked_by: string | null;
}

interface EscRow {
  id: string;
  alert_id: string;
  alert_title: string;
  alert_status: "firing" | "ack" | "resolved";
  incident_id: string | null;
  level: number;
  target: string;
  channel: string;
  fired_at: string;
  acked_at: string | null;
  acked_by: string | null;
}

/**
 * Every escalation event across ALL alerts (firing, acked, and resolved),
 * newest first — the standing "what has paged, and did anyone answer" list that
 * the per-alert trail in buildOncallSection doesn't give you.
 */
export async function listEscalationEvents(env: Env, limit = 100): Promise<EscalationEventView[]> {
  const rows = await new D1Db(env.DB).all<EscRow>(
    `SELECT e.id, e.alert_id, a.title AS alert_title, a.status AS alert_status,
            a.incident_id, e.level, e.target, e.channel, e.fired_at, e.acked_at, e.acked_by
       FROM oncall_escalations e
       JOIN oncall_alerts a ON a.id = e.alert_id
      ORDER BY e.fired_at DESC, e.level DESC
      LIMIT ?`,
    [limit],
  );
  return rows;
}
