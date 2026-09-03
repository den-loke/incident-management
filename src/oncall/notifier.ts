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

export const ACK_ACTION_PREFIX = "oncall_ack:";
export const CREATE_INCIDENT_ACTION_PREFIX = "oncall_create_incident:";

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
