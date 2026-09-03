/// <reference types="@cloudflare/workers-types" />
// Slack slash-command endpoint (`POST /slack/commands`). This is a THIRD Slack
// ingress, distinct from the Events API (/slack/events) and interactivity
// (/slack/interactivity):
//   - Slack POSTs application/x-www-form-urlencoded (NOT JSON), signed the same
//     HMAC way as every other Slack request (verifySlackRequest is generic on
//     the basestring).
//   - We MUST reply within 3s. The reply body is the command's ephemeral
//     response (only the invoking user sees it); heavier work runs in waitUntil.
//
// One command `/incident` with subcommands, so Slack only needs a single slash
// command registered:
//   /incident declare [title]   → open the declare modal (bare) OR declare now (title given)
//   /incident update <text>     → post an update to THIS channel's incident
//   /incident status <status> [note]
//                               → advance THIS channel's incident lifecycle status
//   /incident resolve [note]    → request resolution (joint sign-off) for THIS incident
//   /incident help / (unknown)  → usage
//
// The bare-declare path reuses the SAME declare modal the Home-tab "Declare
// incident" button opens (stakeholders/service.ts: openDeclareModal), so both
// entry points share one modal and one view_submission handler on
// /slack/interactivity. See docs/ARCHITECTURE.md §4.

import type { Env } from "../env";
import { verifySlackRequest } from "./verify";
import { D1Db } from "../status/d1";
import { declareIncident, postIncidentUpdate } from "../incidents/commands";
import { requestResolve } from "../incidents/jointResolve";
import { openDeclareModal } from "../stakeholders/service";
import type { SlackClient } from "../clients/slack";
import { WebApiSlackClient } from "../clients/slack";
import { FakeSlackClient } from "../clients/fakeSlack";
import {
  INCIDENT_STATUSES,
  type IncidentStatus,
} from "../status/types";

// --- Test/bypass seam, mirroring the other Slack-touching services. ---
let slackOverride: ((env: Env) => SlackClient) | undefined;
export function __setCommandsSlackClient(f: ((env: Env) => SlackClient) | undefined): void {
  slackOverride = f;
}
function buildSlack(env: Env): SlackClient {
  if (slackOverride) return slackOverride(env);
  if (env.AUTH_MODE === "bypass") return new FakeSlackClient(true);
  return new WebApiSlackClient(env.SLACK_BOT_TOKEN);
}

// Slack requires a status the human types; only the three PRE-resolved
// lifecycle states are settable via `/incident status` (resolve has its own
// joint sign-off command, so "resolved" is intentionally excluded here).
const SETTABLE_STATUSES = INCIDENT_STATUSES.filter(
  (s): s is Exclude<IncidentStatus, "resolved"> => s !== "resolved",
);

interface SlashPayload {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  trigger_id: string;
}

/** Slack expects a JSON body; `ephemeral` (default) is visible only to the caller. */
function ephemeral(text: string): Response {
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const NOT_INCIDENT_CHANNEL =
  "This isn't an incident channel — run this inside the channel of an active incident.";

const USAGE = [  "*/incident* — incident commands:",
  "• `/incident declare [title]` — open the declare form, or declare immediately when you pass a title",
  "• `/incident update <text>` — post an update to this incident channel",
  "• `/incident status <investigating|identified|monitoring> [note]` — advance this incident's status",
  "• `/incident resolve [note]` — request resolution (a different person confirms)",
].join("\n");

/** Look up the incident that owns a Slack channel (null if the channel is unmapped). */
async function incidentForChannel(
  env: Env,
  channelId: string,
): Promise<string | null> {
  const row = await new D1Db(env.DB).get<{ incident_id: string }>(
    "SELECT incident_id FROM incident_channels WHERE channel = ?",
    [channelId],
  );
  return row?.incident_id ?? null;
}

/**
 * Handle a slash-command POST. Verifies the signature, then dispatches the
 * subcommand. Returns the ephemeral response Slack shows the caller.
 */
export async function handleSlackCommand(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();
  const verified = await verifySlackRequest(
    request.headers,
    rawBody,
    env.SLACK_SIGNING_SECRET,
  );
  if (!verified.ok) {
    return new Response(JSON.stringify({ error: verified.reason }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const params = new URLSearchParams(rawBody);
  const payload: SlashPayload = {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    user_id: params.get("user_id") ?? "unknown",
    channel_id: params.get("channel_id") ?? "",
    trigger_id: params.get("trigger_id") ?? "",
  };

  const trimmed = payload.text.trim();
  const [subRaw, ...rest] = trimmed.split(/\s+/);
  const sub = (subRaw ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  switch (sub) {
    case "":
    case "declare":
      return handleDeclare(payload, arg, env, ctx);
    case "update":
      return handleUpdate(payload, arg, env, ctx);
    case "status":
      return handleStatus(payload, arg, env, ctx);
    case "resolve":
      return handleResolve(payload, arg, env, ctx);
    case "help":
      return ephemeral(USAGE);
    default:
      return ephemeral(`Unknown subcommand \`${sub}\`.\n\n${USAGE}`);
  }
}

/**
 * `/incident declare` — bare opens the modal; with a title declares immediately
 * (default SEV2, changeable in-channel afterwards). Both paths converge on the
 * shared declareIncident() so behaviour matches the web + message-trigger paths.
 */
function handleDeclare(
  payload: SlashPayload,
  title: string,
  env: Env,
  ctx: ExecutionContext,
): Response {
  if (!title) {
    // Open the SHARED declare modal (same one the Home-tab button opens).
    // views.open needs the trigger_id promptly; do it in waitUntil and ack with
    // an empty 200 so Slack shows no message.
    ctx.waitUntil(openDeclareModal(env, payload.trigger_id).catch(() => {}));
    return new Response(null, { status: 200 });
  }
  ctx.waitUntil(
    (async () => {
      const { channelId } = await declareIncident(env, title);
      await buildSlack(env)
        .postMessage(channelId, `Incident declared by <@${payload.user_id}>.`)
        .catch(() => {});
    })(),
  );
  return ephemeral(`Declaring *${title}*… I'll spin up its channel now.`);
}

/** `/incident update <text>` — post an update to THIS channel's incident. */
async function handleUpdate(
  payload: SlashPayload,
  text: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!text) return ephemeral("Usage: `/incident update <what changed>`");
  const incidentId = await incidentForChannel(env, payload.channel_id);
  if (!incidentId) return ephemeral(NOT_INCIDENT_CHANNEL);
  ctx.waitUntil(
    postIncidentUpdate(env, incidentId, `<@${payload.user_id}>: ${text}`),
  );
  return ephemeral(`Update posted: “${text}”`);
}

/**
 * `/incident status <status> [note]` — advance THIS channel's incident to a
 * pre-resolved lifecycle state, with an optional note as the update body.
 */
async function handleStatus(
  payload: SlashPayload,
  arg: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const [statusRaw, ...noteParts] = arg.split(/\s+/);
  const status = (statusRaw ?? "").toLowerCase();
  const note = noteParts.join(" ").trim();
  const allowed = SETTABLE_STATUSES as readonly string[];
  if (!allowed.includes(status)) {
    return ephemeral(
      `Usage: \`/incident status <${SETTABLE_STATUSES.join("|")}> [note]\`` +
        (statusRaw ? `\n\`${statusRaw}\` is not a settable status.` : ""),
    );
  }
  const incidentId = await incidentForChannel(env, payload.channel_id);
  if (!incidentId) return ephemeral(NOT_INCIDENT_CHANNEL);
  const body = note || `Status set to *${status}* by <@${payload.user_id}>.`;
  ctx.waitUntil(
    postIncidentUpdate(env, incidentId, body, status as IncidentStatus),
  );
  return ephemeral(`Status → *${status}*.`);
}

/** `/incident resolve [note]` — request resolution (joint sign-off). */
async function handleResolve(
  payload: SlashPayload,
  note: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const incidentId = await incidentForChannel(env, payload.channel_id);
  if (!incidentId) return ephemeral(NOT_INCIDENT_CHANNEL);
  ctx.waitUntil(
    requestResolve(
      env,
      incidentId,
      payload.channel_id,
      payload.user_id,
      note || undefined,
    ),
  );
  return ephemeral(
    "Resolution requested — a different person needs to confirm in-channel.",
  );
}

