/// <reference types="@cloudflare/workers-types" />
// Incident conversation transcript store (migration 0020). One unified,
// chronological log of everything said in an incident channel — human messages
// and the bot's own posts. Backs the post-mortem draft + the incident-detail
// Conversation block. Pure over the Db port; best-effort recording never throws
// (a capture failure must not break the message routing or a bot post).

import type { Db } from "../status/sink";

export type MessageKind = "human" | "bot";

export interface IncidentMessage {
  id: string;
  incident_id: string;
  kind: MessageKind;
  slack_user_id: string | null;
  text: string;
  ts: string;
  created_at: string;
}

function uid(): string {
  return `msg_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Record one channel message (human or bot). Best-effort — swallows errors so a
 * transcript-write failure never breaks message routing or a bot post. Blank
 * text is skipped (nothing to capture).
 */
export async function recordIncidentMessage(
  db: Db,
  incidentId: string,
  msg: { kind: MessageKind; text: string; slackUserId?: string | null; ts?: string },
): Promise<void> {
  if (!msg.text || !msg.text.trim()) return;
  try {
    await db.run(
      `INSERT INTO incident_messages (id, incident_id, kind, slack_user_id, text, ts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uid(), incidentId, msg.kind, msg.slackUserId ?? null, msg.text, msg.ts ?? nowIso(), nowIso()],
    );
  } catch {
    /* best-effort: never fail the caller on a transcript write */
  }
}

/** The full transcript for an incident, chronological (oldest first). */
export async function listIncidentMessages(db: Db, incidentId: string): Promise<IncidentMessage[]> {
  return db.all<IncidentMessage>(
    "SELECT * FROM incident_messages WHERE incident_id = ? ORDER BY ts, created_at",
    [incidentId],
  );
}
