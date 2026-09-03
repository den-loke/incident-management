/// <reference types="@cloudflare/workers-types" />
// Emoji accept/reject on app suggestions. See ROADMAP.md.
//
// When the bot posts a suggestion (confirm-resolve, publish-postmortem, ...) it
// records the message via recordSuggestion(). A reaction_added ✅/❌ on that exact
// (channel, ts) is resolved here and dispatched to the matching action. Reactions
// on any message NOT tracked in incident_suggestions are ignored — this is
// deliberately not "pin/act on any message".

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { confirmResolve } from "./jointResolve";
import { PostmortemStore } from "../postmortem/store";

// The emoji names Slack sends in reaction_added (no colons).
export const ACCEPT_EMOJI = new Set(["white_check_mark", "heavy_check_mark", "+1"]);
export const REJECT_EMOJI = new Set(["x", "negative_squared_cross_mark", "-1"]);

export type SuggestionKind = "confirm_resolve" | "publish_postmortem";

export interface Suggestion {
  id: string;
  incident_id: string;
  channel: string;
  ts: string;
  kind: SuggestionKind;
  payload: string | null;
  status: "pending" | "accepted" | "rejected";
  decided_by: string | null;
}

function uid(): string {
  return `sug_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Persist a suggestion the bot just posted, so a later reaction on (channel, ts)
 * can be dispatched. Idempotent on (channel, ts) via the unique index.
 */
export async function recordSuggestion(
  env: Env,
  args: {
    incidentId: string;
    channel: string;
    ts: string;
    kind: SuggestionKind;
    payload?: unknown;
  },
): Promise<void> {
  const db = new D1Db(env.DB);
  await db.run(
    `INSERT OR IGNORE INTO incident_suggestions
       (id, incident_id, channel, ts, kind, payload, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [
      uid(),
      args.incidentId,
      args.channel,
      args.ts,
      args.kind,
      args.payload != null ? JSON.stringify(args.payload) : null,
    ],
  );
}

async function findPending(
  db: D1Db,
  channel: string,
  ts: string,
): Promise<Suggestion | null> {
  return db.get<Suggestion>(
    "SELECT * FROM incident_suggestions WHERE channel = ? AND ts = ? AND status = 'pending'",
    [channel, ts],
  );
}

export type ReactionOutcome =
  | { result: "accepted"; kind: SuggestionKind }
  | { result: "rejected"; kind: SuggestionKind }
  | { result: "ignored"; reason: "not_a_suggestion" | "already_decided" | "unknown_emoji" | "self_reaction" };

/**
 * Handle a reaction_added on a message. Only acts when (channel, ts) is a pending
 * tracked suggestion AND the emoji is a known accept/reject. First reaction wins.
 */
export async function applyReaction(
  env: Env,
  channel: string,
  ts: string,
  emoji: string,
  userId: string,
): Promise<ReactionOutcome> {
  const accept = ACCEPT_EMOJI.has(emoji);
  const reject = REJECT_EMOJI.has(emoji);
  if (!accept && !reject) return { result: "ignored", reason: "unknown_emoji" };

  const db = new D1Db(env.DB);
  const sug = await findPending(db, channel, ts);
  if (!sug) return { result: "ignored", reason: "not_a_suggestion" };

  // Atomically claim the decision: first accept/reject wins. The WHERE status =
  // 'pending' guard means a racing second reaction updates zero rows.
  const decision = accept ? "accepted" : "rejected";
  await db.run(
    "UPDATE incident_suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    [decision, userId, nowIso(), sug.id],
  );
  const claimed = await db.get<{ status: string; decided_by: string }>(
    "SELECT status, decided_by FROM incident_suggestions WHERE id = ?",
    [sug.id],
  );
  // Someone else won the race between our read and update.
  if (!claimed || claimed.decided_by !== userId) {
    return { result: "ignored", reason: "already_decided" };
  }

  if (accept) {
    await dispatchAccept(env, sug, userId);
    return { result: "accepted", kind: sug.kind };
  }
  await dispatchReject(env, sug, userId);
  return { result: "rejected", kind: sug.kind };
}

async function dispatchAccept(env: Env, sug: Suggestion, userId: string): Promise<void> {
  switch (sug.kind) {
    case "confirm_resolve": {
      // Reactor confirms the joint sign-off. confirmResolve enforces
      // confirmer != requester itself, so a self-confirm is rejected there.
      await confirmResolve(env, sug.incident_id, userId);
      break;
    }
    case "publish_postmortem": {
      await new PostmortemStore(new D1Db(env.DB)).publish(sug.incident_id);
      break;
    }
  }
}

async function dispatchReject(env: Env, sug: Suggestion, _userId: string): Promise<void> {
  // Rejection is recorded on the suggestion row (status='rejected'); the
  // producing feature's default state stands (draft stays a draft, resolve stays
  // unconfirmed). No further action needed for the two v1 producers.
  void env;
  void sug;
}
