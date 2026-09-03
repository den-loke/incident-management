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
import { CONFIRM_RESOLVE_ACTION, confirmResolve } from "../incidents/jointResolve";
import {
  STAKEHOLDER_TOGGLE_ACTION,
  toggleStakeholder,
  DECLARE_ACTION,
  openDeclareModal,
  submitDeclareModal,
} from "../stakeholders/service";

interface BlockActionsPayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  trigger_id?: string;
  actions?: { action_id?: string; value?: string }[];
  // Present on view_submission payloads; read by submitDeclareModal.
  view?: unknown;
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

  if (payload?.type === "view_submission") {
    // Modal submitted (e.g. the declare-incident modal). Do the work in the
    // background and ack with an empty 200 to close the modal.
    ctx.waitUntil(submitDeclareModal(env, payload as Parameters<typeof submitDeclareModal>[1]));
    return new Response(null, { status: 200 });
  }

  if (payload?.type === "block_actions") {
    // The "Declare incident" Home-tab button opens a modal. views.open needs
    // the trigger_id promptly, so open it inline (awaited) before we ack.
    const action = payload.actions?.[0];
    if (action?.action_id === DECLARE_ACTION && payload.trigger_id) {
      try {
        await openDeclareModal(env, payload.trigger_id);
      } catch {
        /* non-fatal: the modal simply won't open */
      }
      return new Response(null, { status: 200 });
    }
    ctx.waitUntil(applyBlockActions(payload, env));
  }

  // Ack immediately (Slack needs a 200 within 3s; work continues async).
  return new Response(null, { status: 200 });
}

async function applyBlockActions(
  payload: BlockActionsPayload,
  env: Env,
): Promise<void> {
  const userId = payload.user?.id;
  const action = payload.actions?.[0];
  if (!userId || !action?.action_id) return;

  // App Home tab: stakeholder opt-in/opt-out. This has no incident channel, so
  // it MUST be handled before the channel-scoped lookup below.
  if (action.action_id === STAKEHOLDER_TOGGLE_ACTION) {
    await toggleStakeholder(env, userId, action.value !== "off");
    return;
  }

  const channelId = payload.channel?.id;
  if (!channelId) return;

  // Resolve the incident that owns this channel (shared by the actions below).
  const row = await new D1Db(env.DB).get<{ incident_id: string }>(
    "SELECT incident_id FROM incident_channels WHERE channel = ?",
    [channelId],
  );
  if (!row) return;

  // Role claim.
  if (action.action_id.startsWith(CLAIM_ACTION_PREFIX)) {
    const role = action.value ?? action.action_id.slice(CLAIM_ACTION_PREFIX.length);
    if (!isIncidentRole(role)) return;
    await claimRole(env, row.incident_id, channelId, role, userId);
    return;
  }

  // Joint sign-off: confirm resolve.
  if (action.action_id === CONFIRM_RESOLVE_ACTION) {
    await confirmResolve(env, row.incident_id, userId);
    return;
  }
}
