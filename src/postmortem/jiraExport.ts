/// <reference types="@cloudflare/workers-types" />
// Jira action-item export. Runs on post-mortem publish (best-effort). For each
// action item without a Jira key, creates a Jira issue and stores the key so
// re-publish doesn't duplicate. No-op when Jira env vars are unconfigured.
// See ROADMAP.md.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { PostmortemStore } from "./store";
import type { IssueTracker } from "../clients/jira";
import { JiraClient } from "../clients/jira";

// Test seam.
let trackerOverride: ((env: Env) => IssueTracker | null) | undefined;
export function __setIssueTracker(f: ((env: Env) => IssueTracker | null) | undefined): void {
  trackerOverride = f;
}

/** Build the tracker from env, or null when Jira is not configured. */
function buildTracker(env: Env): IssueTracker | null {
  if (trackerOverride) return trackerOverride(env);
  if (env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_API_TOKEN && env.JIRA_PROJECT_KEY) {
    return new JiraClient({
      baseUrl: env.JIRA_BASE_URL,
      email: env.JIRA_EMAIL,
      apiToken: env.JIRA_API_TOKEN,
      projectKey: env.JIRA_PROJECT_KEY,
      issueType: env.JIRA_ISSUE_TYPE,
    });
  }
  return null;
}

export interface ExportResult {
  configured: boolean;
  exported: number;
}

/**
 * Export un-exported action items of an incident's post-mortem to Jira.
 * Idempotent: items that already have a jira_key are skipped. No-op (but not an
 * error) when Jira is unconfigured.
 */
export async function exportActionItemsToJira(
  env: Env,
  incidentId: string,
): Promise<ExportResult> {
  const tracker = buildTracker(env);
  if (!tracker) return { configured: false, exported: 0 };

  const db = new D1Db(env.DB);
  const store = new PostmortemStore(db);
  const pm = await store.get(incidentId);
  if (!pm) return { configured: true, exported: 0 };

  const incidentName =
    (await db.get<{ name: string }>("SELECT name FROM incidents WHERE id = ?", [incidentId]))
      ?.name ?? incidentId;

  let exported = 0;
  for (const item of pm.action_items) {
    if (item.jira_key) continue; // already exported
    const description = `Incident action item from "${incidentName}" (incident ${incidentId}).\n\n${item.description}`;
    try {
      const issue = await tracker.createIssue(item.description, description);
      await store.setActionItemJiraKey(item.id, issue.key);
      exported += 1;
    } catch {
      // Best-effort per item: one failure doesn't block the rest or the publish.
    }
  }
  return { configured: true, exported };
}
