/// <reference types="@cloudflare/workers-types" />
// Slack interactivity endpoint (button clicks). Slack POSTs
// application/x-www-form-urlencoded with a `payload=<json>` field, signed the
// same way as Events API requests. We handle `block_actions` for role claims.
// See ROADMAP.md and docs/ARCHITECTURE.md §4.

import type { Env } from "../env";
import { verifySlackRequest } from "./verify";
import { D1Db } from "../status/d1";
import { CLAIM_ACTION_PREFIX, claimRole } from "../roles/service";
import { isIncidentRole } from "../roles/types";

interface BlockActionsPayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  actions?: { action_id?: string; value?: string }[];
}

/**
 * Handle a Slack interactivity POST. Verifies the signature, acks fast, and
 * applies any role-claim action. Returns 200 on success, 401 on bad signature.
 */
export async function handleSlackInteractivity(
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

  // Body is urlencoded: payload=<json>.
  const params = new URLSearchParams(rawBody);
  const raw = params.get("payload");
  let payload: BlockActionsPayload | null = null;
  if (raw) {
    try {
      payload = JSON.parse(raw) as BlockActionsPayload;
    } catch {
      payload = null;
    }
  }

  if (payload?.type === "block_actions") {
    ctx.waitUntil(applyBlockActions(payload, env));
  }

  // Ack immediately (Slack needs a 200 within 3s; work continues async).
  return new Response(null, { status: 200 });
}

async function applyBlockActions(
  payload: BlockActionsPayload,
  env: Env,
): Promise<void> {
  const channelId = payload.channel?.id;
  const userId = payload.user?.id;
  const action = payload.actions?.[0];
  if (!channelId || !userId || !action?.action_id) return;
  if (!action.action_id.startsWith(CLAIM_ACTION_PREFIX)) return;

  const role = action.value ?? action.action_id.slice(CLAIM_ACTION_PREFIX.length);
  if (!isIncidentRole(role)) return;

  // Resolve the incident that owns this channel.
  const row = await new D1Db(env.DB).get<{ incident_id: string }>(
    "SELECT incident_id FROM incident_channels WHERE channel = ?",
    [channelId],
  );
  if (!row) return;

  await claimRole(env, row.incident_id, channelId, role, userId);
}
