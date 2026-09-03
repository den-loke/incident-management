// Status payload for the SPA. Reads the InternalStatusSink D1 tables (source of
// truth) and returns a JSON-serializable snapshot. See docs/ARCHITECTURE.md §5–6.
// The React SPA (web/) renders this; the Worker no longer renders HTML.

import { D1Db } from "../status/d1";
import { InternalStatusSink } from "../status/internalSink";
import type { Component, Incident, IncidentUpdate } from "../status/types";
import type { Env } from "../env";
import type { Session } from "../auth/session";
import { RoleStore } from "../roles/store";
import type { RoleAssignment } from "../roles/types";

export interface PendingResolution {
  requested_by: string;
  requested_at: string;
  note: string | null;
}

export interface IncidentView extends Incident {
  updates: IncidentUpdate[];
  roles: RoleAssignment[];
  pending_resolution: PendingResolution | null;
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
  const roleStore = new RoleStore(db);
  for (const inc of incidents) {
    const updates = await db.all<IncidentUpdate>(
      "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC",
      [inc.id],
    );
    const roles = await roleStore.list(inc.id);
    const pending = await db.get<PendingResolution>(
      "SELECT requested_by, requested_at, note FROM incident_resolution_requests WHERE incident_id = ? AND confirmed_at IS NULL",
      [inc.id],
    );
    views.push({ ...inc, updates, roles, pending_resolution: pending ?? null });
  }

  return {
    viewer: { user_id: session.user_id, name: session.name },
    components,
    incidents: views,
  };
}
