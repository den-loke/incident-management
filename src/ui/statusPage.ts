// Status payload for the SPA. Reads the InternalStatusSink D1 tables (source of
// truth) and returns a JSON-serializable snapshot. See docs/ARCHITECTURE.md §5–6.
// The React SPA (web/) renders this; the Worker no longer renders HTML.

import { D1Db } from "../status/d1";
import { InternalStatusSink } from "../status/internalSink";
import type { Component, Incident, IncidentUpdate } from "../status/types";
import type { Env } from "../env";
import type { Session } from "../auth/session";

export interface IncidentView extends Incident {
  updates: IncidentUpdate[];
}

export interface StatusPayload {
  viewer: { user_id: string; name: string };
  components: Component[];
  incidents: IncidentView[];
}

/** Fetch components + recent incidents (with their update timelines) from D1. */
export async function loadStatus(
  env: Env,
  session: Session,
): Promise<StatusPayload> {
  const db = new D1Db(env.DB);
  const sink = new InternalStatusSink(db);
  const components = await sink.listComponents();

  // Recent incidents: unresolved first, then most-recent resolved.
  const incidents = await db.all<Incident>(
    `SELECT * FROM incidents
       ORDER BY (status != 'resolved') DESC, COALESCE(resolved_at, created_at) DESC
       LIMIT 25`,
  );
  const views: IncidentView[] = [];
  for (const inc of incidents) {
    const updates = await db.all<IncidentUpdate>(
      "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC",
      [inc.id],
    );
    views.push({ ...inc, updates });
  }

  return {
    viewer: { user_id: session.user_id, name: session.name },
    components,
    incidents: views,
  };
}
