/// <reference types="@cloudflare/workers-types" />
// Joint sign-off resolve. Resolving is a two-person handshake:
//   requestResolve  — records a pending request, posts a Confirm button to Slack
//   confirmResolve  — a DIFFERENT person confirms; performs the real resolve
// See ROADMAP.md. The actual resolve reuses resolveIncident (final update,
// status=resolved, alarm off, post-mortem auto-draft).

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import { recordSuggestion } from "./suggestions";
import { resolveIncident } from "../incidents/commands";

export interface ResolutionRequest {
  incident_id: string;
  requested_by: string;
  requested_at: string;
  note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

export const CONFIRM_RESOLVE_ACTION = "confirm_resolve";

let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setJointResolveSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

export async function getResolutionRequest(
  env: Env,
  incidentId: string,
): Promise<ResolutionRequest | null> {
  return new D1Db(env.DB).get<ResolutionRequest>(
    "SELECT * FROM incident_resolution_requests WHERE incident_id = ? AND confirmed_at IS NULL",
    [incidentId],
  );
}

/** Build the Slack confirm-resolve button panel. */
export function confirmResolveBlocks(requestedBy: string, note?: string | null): unknown[] {
  const detail = note ? `\n> ${note}` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Resolve requested* by <@${requestedBy}>.${detail}\nA different person (ideally the Customer Support Lead) should confirm.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Confirm resolve" },
          action_id: CONFIRM_RESOLVE_ACTION,
          value: "confirm",
        },
      ],
    },
  ];
}

/**
 * Request resolution. Records the pending request (idempotent per incident) and
 * posts the Confirm button to the channel. Returns the request.
 */
export async function requestResolve(
  env: Env,
  incidentId: string,
  channelId: string,
  requestedBy: string,
  note?: string,
): Promise<ResolutionRequest> {
  const db = new D1Db(env.DB);
  await db.run(
    `INSERT INTO incident_resolution_requests (incident_id, requested_by, note)
       VALUES (?, ?, ?)
     ON CONFLICT(incident_id) DO UPDATE SET
       requested_by = excluded.requested_by,
       requested_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       note = excluded.note,
       confirmed_by = NULL, confirmed_at = NULL`,
    [incidentId, requestedBy, note ?? null],
  );
  try {
    const slack = buildSlack(env);
    const ts = await slack.postBlocks(
      channelId,
      `Resolve requested by <@${requestedBy}>. A different person should confirm — react ✅ to confirm.`,
      confirmResolveBlocks(requestedBy, note),
    );
    // Track the message so a ✅ reaction confirms (emoji path alongside the button).
    await recordSuggestion(env, {
      incidentId,
      channel: channelId,
      ts,
      kind: "confirm_resolve",
      payload: { requestedBy },
    });
    // Seed affordances so responders see the ✅/❌ options without discovering them.
    await slack.addReaction(channelId, ts, "white_check_mark");
    await slack.addReaction(channelId, ts, "x");
  } catch {
    /* non-fatal — the Block Kit button still works if reaction seeding fails */
  }
  return (await getResolutionRequest(env, incidentId))!;
}

export type ConfirmOutcome =
  | { ok: true }
  | { ok: false; reason: "no_request" | "same_person" };

/**
 * Confirm resolution. Must be a DIFFERENT person than the requester (two-person
 * integrity). On success, performs the real resolve and clears the request.
 */
export async function confirmResolve(
  env: Env,
  incidentId: string,
  confirmedBy: string,
): Promise<ConfirmOutcome> {
  const req = await getResolutionRequest(env, incidentId);
  if (!req) return { ok: false, reason: "no_request" };
  if (req.requested_by === confirmedBy) return { ok: false, reason: "same_person" };

  const db = new D1Db(env.DB);
  await db.run(
    "UPDATE incident_resolution_requests SET confirmed_by = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE incident_id = ?",
    [confirmedBy, incidentId],
  );
  // Perform the actual resolve (final update, status resolved, alarm off,
  // post-mortem auto-draft) via the shared path.
  await resolveIncident(env, incidentId, req.note ?? undefined);
  return { ok: true };
}
