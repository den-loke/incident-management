/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";
import { D1Db } from "./status/d1";
import {
  commandRequest,
  declareIncident,
  resolveIncident,
} from "./incidents/commands";

/**
 * Routes verified Slack events to the right Incident Durable Object.
 *
 *  - A DECLARE trigger (an app_mention or message whose text starts with
 *    `declare` / `/incident declare`) mints a NEW incident: a fresh DO named by
 *    a generated id, which creates its own Slack channel and arms its alarm.
 *    The channel->DO mapping is then recorded in D1 so later events in that
 *    channel find the same DO.
 *  - A RESOLVE trigger (a message whose text starts with `resolve` /
 *    `/incident resolve`) IN a mapped incident channel resolves that channel's
 *    incident: the DO posts a final update, marks status `resolved`, and stops
 *    its alarm loop. Any trailing text becomes the resolution note.
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
const RESOLVE_RE = /^(?:\/incident\s+)?resolve\b\s*/i;

export interface RouteResult {
  action: "declared" | "routed" | "resolved" | "ignored";
  incidentId?: string;
  channelId?: string;
}

/** Parse a declare trigger's text into an incident name. */
function parseDeclare(text: string): string {
  const name = text.replace(DECLARE_RE, "").trim();
  return name || "Unnamed incident";
}

/** Parse a resolve trigger's text into an optional resolution note. */
function parseResolve(text: string): string | undefined {
  const note = text.replace(RESOLVE_RE, "").trim();
  return note || undefined;
}

/** True for a message we should treat as a declare trigger. */
function isDeclareTrigger(event: SlackEvent): boolean {
  if (event.bot_id) return false; // never react to our own posts
  const t = (event.text ?? "").trimStart();
  return DECLARE_RE.test(t);
}

/** True for a message we should treat as a resolve trigger. */
function isResolveTrigger(event: SlackEvent): boolean {
  if (event.bot_id) return false; // never react to our own posts
  const t = (event.text ?? "").trimStart();
  return RESOLVE_RE.test(t);
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
    const { incidentId, channelId } = await declareIncident(env, name);
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

  // A resolve trigger in the incident's own channel closes it out: the DO
  // posts a final update, marks status resolved, and stops its alarm loop.
  if (isResolveTrigger(event)) {
    await resolveIncident(env, row.incident_id, parseResolve(event.text ?? ""));
    return {
      action: "resolved",
      incidentId: row.incident_id,
      channelId: event.channel,
    };
  }

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
