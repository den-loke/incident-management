/// <reference types="@cloudflare/workers-types" />
// Stakeholder-waiting reminders — build brief pain point #1 (stakeholders left
// waiting for updates). A cron sweep compares each OPEN incident's last_updated_at
// against a per-severity threshold and nudges the incident lead in the incident's
// Slack channel to post an update. See ROADMAP → "Stakeholder-waiting reminders".
//
// Hard-coded thresholds (single-tenant stance — no config surface, no AI):
//   SEV1 / SEV2 → 15 min,  SEV3 → 60 min.
// Posting ANY update bumps last_updated_at (migration 0015 write path), which
// resets the clock — the reminder is a PROMPT to post, not a hard nag. To avoid
// re-nudging every minute once overdue, we stamp last_reminded_at (migration 0018)
// and require a full threshold window since the last nudge too.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import type { IncidentSeverity, IncidentStatus } from "../status/types";

// Test seam (same pattern as the notifier / postmortem service).
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setReminderSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

/** Per-severity staleness threshold in minutes. Hard-coded (Den, 2026-09-08). */
export const REMINDER_THRESHOLD_MIN: Record<IncidentSeverity, number> = {
  sev1: 15,
  sev2: 15,
  sev3: 60,
};

function thresholdMs(severity: IncidentSeverity): number {
  return (REMINDER_THRESHOLD_MIN[severity] ?? 60) * 60_000;
}

interface OpenIncidentRow {
  id: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  last_updated_at: string | null;
  created_at: string;
  last_reminded_at: string | null;
  channel: string | null;
  lead: string | null; // Customer Support Lead if assigned, else Engineering Lead
}

/**
 * Nudge the lead of each OPEN incident that has gone quiet past its severity
 * threshold. Returns how many reminders were posted. Best-effort per incident —
 * a Slack failure on one incident never blocks the others or the rest of the
 * cron tick. Skips incidents with no Slack channel (nowhere to post).
 */
export async function sweepStakeholderReminders(
  env: Env,
  now: Date = new Date(),
): Promise<{ reminded: number }> {
  const db = new D1Db(env.DB);
  // Prefer the Customer Support Lead (owns comms); fall back to Engineering Lead.
  const rows = await db.all<OpenIncidentRow>(
    `SELECT i.id, i.severity, i.status,
            i.last_updated_at, i.created_at, i.last_reminded_at,
            ic.channel AS channel,
            COALESCE(csl.slack_user_id, el.slack_user_id) AS lead
       FROM incidents i
       LEFT JOIN incident_channels ic ON ic.incident_id = i.id
       LEFT JOIN incident_roles csl ON csl.incident_id = i.id AND csl.role = 'customer_support_lead'
       LEFT JOIN incident_roles el  ON el.incident_id = i.id AND el.role = 'engineering_lead'
      WHERE i.status != 'resolved'`,
  );

  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  let reminded = 0;

  for (const inc of rows) {
    if (!inc.channel) continue; // nowhere to post (web-declared, no Slack channel)
    const threshold = thresholdMs(inc.severity);
    // Clock since last activity: last update, else creation.
    const sinceUpdate = nowMs - new Date(inc.last_updated_at ?? inc.created_at).getTime();
    if (sinceUpdate < threshold) continue; // still fresh
    // Don't re-nudge within a threshold window of the previous reminder.
    if (inc.last_reminded_at && nowMs - new Date(inc.last_reminded_at).getTime() < threshold) {
      continue;
    }

    const mins = Math.round(sinceUpdate / 60_000);
    const who = inc.lead ? `<@${inc.lead}>` : "<!channel>";
    const text =
      `:hourglass_flowing_sand: ${who} — no update on this incident for ~${mins} min ` +
      `(${inc.severity.toUpperCase()} threshold ${REMINDER_THRESHOLD_MIN[inc.severity]} min). ` +
      `Post an update for stakeholders — even "no change, still investigating" resets the clock.`;

    try {
      await buildSlack(env).postMessage(inc.channel, text);
      await db.run("UPDATE incidents SET last_reminded_at = ? WHERE id = ?", [nowIso, inc.id]);
      reminded++;
    } catch {
      /* best-effort: a Slack failure on one incident must not block the others */
    }
  }
  return { reminded };
}
