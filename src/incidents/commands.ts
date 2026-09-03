/// <reference types="@cloudflare/workers-types" />
// Shared incident operations. The single path from ANY caller (Slack router or
// web API) to the Incident Durable Object, so declare/update/resolve behave
// identically regardless of surface. See docs/ARCHITECTURE.md §2.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { nextIncidentNumber, formatIncidentId } from "../counter";
import type { IncidentStatus } from "../status/types";
import type { IncidentSeverity } from "../status/types";

/** Build an internal command request for a DO stub. */
export function commandRequest(command: unknown): Request {
  return new Request("https://do/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
  });
}

// One DO per incident, named by the incident id (see router.ts: doId = incidentId).
function stubForIncident(env: Env, incidentId: string): DurableObjectStub {
  return env.INCIDENT.get(env.INCIDENT.idFromName(incidentId));
}

export interface DeclareResult {
  incidentId: string;
  channelId: string;
}

/**
 * Declare a new incident: mint an id, drive the DO to open it + create its Slack
 * channel + arm the alarm, then record the channel->DO mapping so later Slack
 * messages in that channel route back to the same DO.
 */
export async function declareIncident(
  env: Env,
  name: string,
  body?: string,
  severity?: IncidentSeverity,
): Promise<DeclareResult> {
  // Sequential, human-meaningful id: "INC-1", "INC-2", … The counter DO is the
  // single serialization point so concurrent declares get distinct numbers.
  const incidentId = formatIncidentId(
    await nextIncidentNumber(env.INCIDENT_COUNTER),
  );
  const stub = stubForIncident(env, incidentId);

  const res = await stub.fetch(
    commandRequest({ cmd: "declare", name, body, id: incidentId, severity }),
  );
  const { channelId } = (await res.json()) as { channelId: string };

  await new D1Db(env.DB).run(
    "INSERT INTO incident_channels (channel, incident_id, do_id) VALUES (?, ?, ?)",
    [channelId, incidentId, incidentId],
  );

  // Post the claimable-roles panel to the new channel. Best-effort: a failure
  // here must not fail the declare. Lazy import avoids a module cycle.
  try {
    const { postRolesPanel } = await import("../roles/service");
    await postRolesPanel(env, incidentId, channelId);
  } catch {
    /* non-fatal: the panel can be re-posted later */
  }

  return { incidentId, channelId };
}

/** Append an explicit update to an incident (optionally advancing its status). */
export async function postIncidentUpdate(
  env: Env,
  incidentId: string,
  body: string,
  status?: IncidentStatus,
): Promise<void> {
  const stub = stubForIncident(env, incidentId);
  await stub.fetch(commandRequest({ cmd: "postUpdate", body, status }));
}

/** Resolve an incident with an optional closing note, then auto-draft its post-mortem. */
export async function resolveIncident(
  env: Env,
  incidentId: string,
  body?: string,
): Promise<void> {
  const stub = stubForIncident(env, incidentId);
  await stub.fetch(commandRequest({ cmd: "resolve", body }));

  // Auto-draft a post-mortem from the (now complete) timeline. Best-effort: a
  // draft failure must never fail the resolve itself. Imported lazily to avoid
  // a module cycle (service -> store -> sink types).
  try {
    const { generatePostmortemDraft } = await import("../postmortem/service");
    await generatePostmortemDraft(env, incidentId);
  } catch {
    /* non-fatal: the post-mortem can be generated later from the UI */
  }
}
