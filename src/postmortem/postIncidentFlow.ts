/// <reference types="@cloudflare/workers-types" />
// Post-incident flow — a READ-ONLY view of the FIXED post-incident checklist for
// one incident. See ROADMAP → "Post-incident flow (surface the fixed checklist)".
//
// incident.io lets you BUILD a post-incident checklist. Ours is hard-coded
// (single-tenant stance) — so this only *surfaces* the state of that fixed flow,
// derived from existing data (incident status + post-mortem + action items).
// No new table, no builder, no writes.

import type { Db } from "../status/sink";
import { PostmortemStore } from "../postmortem/store";
import type { IncidentStatus } from "../status/types";

export type ChecklistState = "done" | "pending" | "blocked";

export interface ChecklistItem {
  key: string;
  label: string;
  state: ChecklistState;
  detail: string;
}

export interface PostIncidentFlow {
  incident_id: string;
  complete: boolean; // every step done
  items: ChecklistItem[];
}

/**
 * Derive the fixed post-incident checklist for an incident. Steps, in order:
 *   1. Incident resolved
 *   2. Post-mortem drafted
 *   3. Action items captured
 *   4. Action items filed (exported to the tracker) — n/a if none captured
 *   5. Post-mortem published
 * A step is `pending` until its predecessor is `done`; `blocked` is not used yet
 * (reserved) — everything is done/pending. `n/a` steps (no action items) count as
 * done so the flow can complete.
 */
export async function buildPostIncidentFlow(
  db: Db,
  incidentId: string,
  incidentStatus: IncidentStatus,
): Promise<PostIncidentFlow> {
  const pm = await new PostmortemStore(db).get(incidentId);
  const items = pm?.action_items ?? [];

  const resolved = incidentStatus === "resolved";
  const drafted = pm !== null;
  const captured = items.length > 0;
  const anyItems = captured;
  const allFiled = anyItems && items.every((i) => i.jira_key !== null && i.jira_key !== "");
  const published = pm?.status === "published";

  const done = (b: boolean): ChecklistState => (b ? "done" : "pending");

  const checklist: ChecklistItem[] = [
    {
      key: "resolved",
      label: "Incident resolved",
      state: done(resolved),
      detail: resolved ? "Resolved via the two-person sign-off." : "Not yet resolved.",
    },
    {
      key: "drafted",
      label: "Post-mortem drafted",
      state: done(drafted),
      detail: drafted ? "Auto-drafted on resolve; editable in the web UI." : "Drafts on resolve.",
    },
    {
      key: "action_items",
      label: "Action items captured",
      state: done(captured),
      detail: captured ? `${items.length} action item(s).` : "No action items captured.",
    },
    {
      key: "filed",
      label: "Action items filed to the tracker",
      // n/a when there are none → counts as done so the flow can complete.
      state: anyItems ? done(allFiled) : "done",
      detail: !anyItems
        ? "No action items to file."
        : allFiled
          ? "All action items exported to the tracker."
          : `${items.filter((i) => !i.jira_key).length} not yet filed (files on publish).`,
    },
    {
      key: "published",
      label: "Post-mortem published",
      state: done(published),
      detail: published ? "Published." : "Still a draft.",
    },
  ];

  return {
    incident_id: incidentId,
    complete: checklist.every((c) => c.state === "done"),
    items: checklist,
  };
}
