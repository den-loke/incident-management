/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";
import { D1Db } from "./status/d1";

/**
 * Routes verified Slack events to the right Incident Durable Object.
 *
 *  - A DECLARE trigger (an app_mention or message whose text starts with
 *    `declare` / `/incident declare`) mints a NEW incident: a fresh DO named by
 *    a generated id, which creates its own Slack channel and arms its alarm.
 *    The channel->DO mapping is then recorded in D1 so later events in that
 *    channel find the same DO.
 *  - Any other message event is routed to the DO that owns its channel (looked
 *    up in `incident_channels`); unmapped channels are ignored.
 *
 * Kept separate from index.ts so the classify + dispatch logic is unit-testable
 * and the HTTP handler stays thin. See docs/ARCHITECTURE.md §2 & §4.
 */

interface SlackEventEnvelope {
  type?: string;
  event?: SlackEvent;
}
interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
}

const DECLARE_RE = /^(?:\/incident\s+)?declare\b\s*/i;

export interface RouteResult {
  action: "declared" | "routed" | "ignored";
  incidentId?: string;
  channelId?: string;
}

/** Parse a declare trigger's text into an incident name. */
function parseDeclare(text: string): string {
  const name = text.replace(DECLARE_RE, "").trim();
  return name || "Unnamed incident";
}

/** True for a message we should treat as a declare trigger. */
function isDeclareTrigger(event: SlackEvent): boolean {
  if (event.bot_id) return false; // never react to our own posts
  const t = (event.text ?? "").trimStart();
  return DECLARE_RE.test(t);
}

export async function routeSlackEvent(
  envelope: SlackEventEnvelope,
  env: Env,
): Promise<RouteResult> {
  if (envelope.type !== "event_callback" || !envelope.event) {
    return { action: "ignored" };
  }
  const event = envelope.event;
  if (event.type !== "message" && event.type !== "app_mention") {
    return { action: "ignored" };
  }
  if (event.bot_id || event.subtype) {
    // Skip bot echoes and edited/joined/left system subtypes.
    return { action: "ignored" };
  }

  const db = new D1Db(env.DB);

  if (isDeclareTrigger(event)) {
    const name = parseDeclare(event.text ?? "");
    const incidentId = `inc_${crypto.randomUUID()}`;
    const doId = incidentId; // one DO per incident; name it by the incident id
    const stub = env.INCIDENT.get(env.INCIDENT.idFromName(doId));

    const res = await stub.fetch(commandRequest({ cmd: "declare", name, id: incidentId }));
    const { channelId } = (await res.json()) as { channelId: string };

    await db.run(
      "INSERT INTO incident_channels (channel, incident_id, do_id) VALUES (?, ?, ?)",
      [channelId, incidentId, doId],
    );

    return { action: "declared", incidentId, channelId };
  }

  // Ongoing message: route to the DO that owns this channel, if any.
  if (!event.channel) return { action: "ignored" };
  const row = await db.get<{ do_id: string; incident_id: string }>(
    "SELECT do_id, incident_id FROM incident_channels WHERE channel = ?",
    [event.channel],
  );
  if (!row) return { action: "ignored" };

  const stub = env.INCIDENT.get(env.INCIDENT.idFromName(row.do_id));
  await stub.fetch(
    commandRequest({
      cmd: "message",
      user: event.user ?? "unknown",
      text: event.text ?? "",
    }),
  );

  return {
    action: "routed",
    incidentId: row.incident_id,
    channelId: event.channel,
  };
}

/** Build an internal command request for a DO stub. */
export function commandRequest(command: unknown): Request {
  return new Request("https://do/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}
