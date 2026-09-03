/// <reference types="@cloudflare/workers-types" />
// On-call notifiers. See docs/SPEC_ONCALL.md §3a.
//
// The escalation ladder decides WHO to page at what level; a Notifier decides
// HOW they're reached. Slack is always on; Twilio (SMS/voice) is added in slice 4
// behind this same interface, config-gated so it never breaks the Slack path.

import type { Env } from "../env";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import type { TwilioClient } from "../clients/twilio";
import { RestTwilioClient } from "../clients/twilio";
import type { AlertRow } from "./alerts";
import type { Responder } from "./rotation";

// Test seam (same pattern as the other on-call/Slack modules).
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setNotifierSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

// Twilio test seam. Distinct from the "is Twilio configured" check below: an
// override forces the Twilio path on in tests even without real env credentials.
let twilioOverride: ((env: Env) => TwilioClient) | undefined;
export function __setNotifierTwilioClient(f: ((env: Env) => TwilioClient) | undefined): void {
  twilioOverride = f;
}
/**
 * Build a Twilio client, or null when Twilio is not configured. Mirrors the
 * StatuspageSink gating: unset ONCALL_TWILIO_* → null → Slack-only, no error.
 * A test override always wins (so tests exercise the path without real creds).
 */
function buildTwilio(env: Env): TwilioClient | null {
  if (twilioOverride) return twilioOverride(env);
  if (env.ONCALL_TWILIO_ACCOUNT_SID && env.ONCALL_TWILIO_AUTH_TOKEN && env.ONCALL_TWILIO_FROM) {
    return new RestTwilioClient(env.ONCALL_TWILIO_ACCOUNT_SID, env.ONCALL_TWILIO_AUTH_TOKEN);
  }
  return null;
}

export const ACK_ACTION_PREFIX = "oncall_ack:";
export const CREATE_INCIDENT_ACTION_PREFIX = "oncall_create_incident:";

/**
 * Per-level channel policy (§3a). Hard-coded default, env-overridable via
 * ONCALL_CHANNEL_POLICY — NOT a config builder, just a comma-separated escape
 * hatch per level, e.g. "slack+sms|slack+sms+voice|slack". Slack is always
 * forced on for every level regardless of policy so paging never goes dark.
 */
export type PolicyChannel = "sms" | "voice";

const DEFAULT_POLICY: PolicyChannel[][] = [
  ["sms"], // L0 — Slack (implicit) + SMS
  ["sms", "voice"], // L1 — Slack + SMS + a ringing phone (the "wake up")
  [], // L2 — Slack @channel only; never phone-blast the whole team
];

function policyForLevel(env: Env, level: number): PolicyChannel[] {
  const raw = env.ONCALL_CHANNEL_POLICY;
  if (!raw) return DEFAULT_POLICY[Math.min(level, DEFAULT_POLICY.length - 1)] ?? [];
  const levels = raw.split("|");
  const spec = levels[Math.min(level, levels.length - 1)] ?? "";
  const out: PolicyChannel[] = [];
  for (const tok of spec.split("+").map((t) => t.trim().toLowerCase())) {
    if (tok === "sms" || tok === "voice") out.push(tok);
  }
  return out;
}

/** What channel a page went out on, recorded in oncall_escalations. */
export type PageChannel = "slack" | "sms" | "voice";

export interface PageResult {
  channel: PageChannel;
  provider_sid?: string; // Twilio SID (slice 4); undefined for Slack.
}

/** Ack / Create-incident buttons for a level 0/1 page. */
function pageBlocks(alert: AlertRow, level: number, mention: string): unknown[] {
  const sev = alert.severity ? ` (${alert.severity.toUpperCase()})` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${mention} :rotating_light: *Alert${sev}* — ${alert.title}\n${alert.body ?? ""}\n_Escalation level ${level}. React ✅ or click Ack to acknowledge._`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Ack" },
          style: "primary",
          action_id: `${ACK_ACTION_PREFIX}${alert.id}`,
          value: alert.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Create incident" },
          action_id: `${CREATE_INCIDENT_ACTION_PREFIX}${alert.id}`,
          value: alert.id,
        },
      ],
    },
  ];
}

/**
 * Slack notifier — always on. Posts to the on-call alerts channel (the incident
 * channel if the alert is already linked to one, else ONCALL_FALLBACK_CHANNEL).
 * At level 2 there is no specific target; `mention` is @channel.
 */
export async function pageViaSlack(
  env: Env,
  channel: string,
  alert: AlertRow,
  level: number,
  target: Responder | null,
): Promise<PageResult> {
  const slack = buildSlack(env);
  const mention =
    level >= 2 ? "<!channel>" : target ? `<@${target.id}>` : "";
  const managerPing =
    level === 1 && env.ONCALL_MANAGER ? ` (cc <@${env.ONCALL_MANAGER}>)` : "";
  const ts = await slack.postBlocks(
    channel,
    `Alert: ${alert.title} (level ${level})`,
    pageBlocks(alert, level, `${mention}${managerPing}`),
  );
  // Seed a ✅ affordance so an emoji ack works alongside the button.
  try {
    await slack.addReaction(channel, ts, "white_check_mark");
  } catch {
    /* non-fatal */
  }
  return { channel: "slack" };
}

/** SMS body for a page — short, with the ack instruction. */
function smsBody(alert: AlertRow, level: number): string {
  const sev = alert.severity ? ` [${alert.severity.toUpperCase()}]` : "";
  return `ALERT${sev} (L${level}): ${alert.title}. Reply Y or ACK to acknowledge.`;
}

/**
 * TwiML for a voice page: read the alert, then gather a single digit. Pressing 1
 * posts to /api/twilio/voice which acks by provider_sid. Kept inline (no config
 * surface); the ack correlation is the Call SID recorded in oncall_escalations.
 */
function voiceTwiml(env: Env, alert: AlertRow, level: number): string {
  const base = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const action = `${base}/api/twilio/voice`;
  const sev = alert.severity ? ` severity ${alert.severity.toUpperCase()}` : "";
  const say = `On call alert level ${level}.${sev}. ${alert.title}. Press 1 to acknowledge.`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Gather numDigits="1" action="${esc(action)}" method="POST">` +
    `<Say>${esc(say)}</Say></Gather>` +
    `<Say>No input received. Goodbye.</Say></Response>`
  );
}

/**
 * Page a target over Twilio per the level policy. Returns one PageResult per
 * channel that actually fired (SMS and/or voice). No-ops (returns []) when:
 * Twilio is unconfigured, there is no specific target (level 2 broadcast), the
 * target has no phone, or the policy asks for nothing at this level. Never
 * throws out — a Twilio failure is swallowed so the Slack page always stands.
 */
export async function pageViaTwilio(
  env: Env,
  alert: AlertRow,
  level: number,
  target: Responder | null,
): Promise<PageResult[]> {
  const twilio = buildTwilio(env);
  if (!twilio) return []; // unconfigured → Slack-only
  if (!target || !target.phone) return []; // no specific person / no number
  const from = env.ONCALL_TWILIO_FROM;
  if (!from) return [];

  const wanted = policyForLevel(env, level);
  const results: PageResult[] = [];
  for (const ch of wanted) {
    try {
      if (ch === "sms") {
        const sid = await twilio.sendSms({ to: target.phone, from, body: smsBody(alert, level) });
        results.push({ channel: "sms", provider_sid: sid });
      } else if (ch === "voice") {
        const sid = await twilio.placeCall({ to: target.phone, from, twiml: voiceTwiml(env, alert, level) });
        results.push({ channel: "voice", provider_sid: sid });
      }
    } catch {
      /* non-fatal: a failed Twilio hop must not block the Slack page or the sweep */
    }
  }
  return results;
}

/**
 * Page every notifier for a level and return one PageResult per channel that
 * fired (Slack always first, then Twilio SMS/voice per policy). The escalation
 * ladder records one oncall_escalations row per result, so a phone ack can be
 * correlated back to its provider_sid.
 */
export async function pageAlert(
  env: Env,
  channel: string,
  alert: AlertRow,
  level: number,
  target: Responder | null,
): Promise<PageResult[]> {
  const slack = await pageViaSlack(env, channel, alert, level, target);
  const twilio = await pageViaTwilio(env, alert, level, target);
  return [slack, ...twilio];
}

/**
 * Post an external-routed alert as a comms notice to the alerts/comms channel
 * (ONCALL_FALLBACK_CHANNEL) with a Create-incident button — instead of paging
 * on-call. For upstream/partner signals we communicate; a human promotes to an
 * incident on the external routing path if warranted. Best-effort. See
 * oncall/routing.ts + ROADMAP "Alert routing".
 */
export async function notifyAlertRouted(env: Env, alert: AlertRow): Promise<void> {
  const channel = env.ONCALL_FALLBACK_CHANNEL;
  if (!channel) return; // nowhere to post; no-op (never errors).
  const slack = buildSlack(env);
  const sev = alert.severity ? ` (${alert.severity.toUpperCase()})` : "";
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:satellite_antenna: *Upstream/partner alert${sev}* — ${alert.title}\n${alert.body ?? ""}\n_Routed external: not paging on-call. Create an incident if we need to communicate._`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Create incident" },
          action_id: `${CREATE_INCIDENT_ACTION_PREFIX}${alert.id}`,
          value: alert.id,
        },
      ],
    },
  ];
  try {
    await slack.postBlocks(channel, `Upstream alert: ${alert.title}`, blocks);
  } catch {
    /* non-fatal */
  }
}

/**
 * Post an "alert promoted to incident" notice into the alert's paging channel,
 * linking the new incident channel (and the dashboard, if APP_BASE_URL is set).
 * Best-effort — a Slack failure never blocks the promotion. Uses the same seam
 * as the pager so tests observe it via FakeSlackClient. See docs/SPEC_ONCALL.md §5.
 */
export async function notifyPromotion(
  env: Env,
  pagingChannel: string,
  incidentChannel: string,
  incidentId: string,
): Promise<void> {
  const slack = buildSlack(env);
  const base = (env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const dash = base ? ` (<${base}/?incident=${incidentId}|dashboard>)` : "";
  try {
    await slack.postMessage(
      pagingChannel,
      `:fire: Alert promoted to incident <#${incidentChannel}>${dash}.`,
    );
  } catch {
    /* non-fatal */
  }
}
