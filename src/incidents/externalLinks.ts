/// <reference types="@cloudflare/workers-types" />
// Incident ↔ external-record links (Jira today; Zendesk/others later). Two entry
// points, both writing incident_external_links (migration 0019):
//   - createJiraForIncident: create a NEW Jira issue for the incident + link it.
//   - linkExistingJira:      attach an ALREADY-EXISTING Jira key to the incident.
// See ROADMAP → "Jira/Zendesk create-from-incident + link-existing".
//
// Distinct from postmortem/jiraExport.ts, which exports ACTION ITEMS on publish.
// This links the INCIDENT itself. Both share the JIRA_* config via buildIssueTracker.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { buildIssueTracker, jiraBrowseUrl } from "../clients/jira";
import type { Incident } from "../status/types";

export type LinkProvider = "jira";

export interface ExternalLink {
  id: string;
  incident_id: string;
  provider: string;
  external_key: string;
  url: string;
  created_by: string | null;
  created_at: string;
}

function uid(): string {
  return `lnk_${crypto.randomUUID()}`;
}
function nowIso(): string {
  return new Date().toISOString();
}

/** Jira issue keys look like ABC-123. Validate before linking. */
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
export function isJiraKey(s: string): boolean {
  return JIRA_KEY_RE.test(s.trim());
}

export type CreateOutcome =
  | { result: "created"; link: ExternalLink }
  | { result: "unconfigured" }
  | { result: "not_found" };

/**
 * Create a NEW Jira issue for the incident and store the link. No-op with
 * 'unconfigured' when Jira env is unset; 'not_found' when the incident is unknown.
 */
export async function createJiraForIncident(
  env: Env,
  incidentId: string,
  actor: string,
): Promise<CreateOutcome> {
  const db = new D1Db(env.DB);
  const incident = await db.get<Incident>("SELECT * FROM incidents WHERE id = ?", [incidentId]);
  if (!incident) return { result: "not_found" };

  const tracker = buildIssueTracker(env);
  if (!tracker) return { result: "unconfigured" };

  const summary = `[${incident.id}] ${incident.name}`;
  const description =
    `Incident ${incident.id} (${incident.severity.toUpperCase()}, ${incident.routing_path}).\n` +
    `Status: ${incident.status}. Declared: ${incident.created_at}.`;
  const issue = await tracker.createIssue(summary, description);

  const link: ExternalLink = {
    id: uid(),
    incident_id: incidentId,
    provider: "jira",
    external_key: issue.key,
    url: issue.url,
    created_by: actor,
    created_at: nowIso(),
  };
  await db.run(
    `INSERT INTO incident_external_links (id, incident_id, provider, external_key, url, created_by, created_at)
     VALUES (?, ?, 'jira', ?, ?, ?, ?)
     ON CONFLICT (incident_id, provider, external_key) DO NOTHING`,
    [link.id, link.incident_id, link.external_key, link.url, link.created_by, link.created_at],
  );
  return { result: "created", link };
}

export type LinkOutcome =
  | { result: "linked"; link: ExternalLink }
  | { result: "invalid_key" }
  | { result: "not_found" };

/**
 * Attach an EXISTING Jira key to the incident (no Jira call — we don't require
 * Jira to be configured to record a link a human already has). Idempotent via the
 * UNIQUE constraint. 'invalid_key' when the key isn't ABC-123 shaped.
 */
export async function linkExistingJira(
  env: Env,
  incidentId: string,
  rawKey: string,
  actor: string,
): Promise<LinkOutcome> {
  const key = rawKey.trim().toUpperCase();
  if (!isJiraKey(key)) return { result: "invalid_key" };
  const db = new D1Db(env.DB);
  const incident = await db.get<{ id: string }>("SELECT id FROM incidents WHERE id = ?", [incidentId]);
  if (!incident) return { result: "not_found" };

  const link: ExternalLink = {
    id: uid(),
    incident_id: incidentId,
    provider: "jira",
    external_key: key,
    url: jiraBrowseUrl(env, key),
    created_by: actor,
    created_at: nowIso(),
  };
  await db.run(
    `INSERT INTO incident_external_links (id, incident_id, provider, external_key, url, created_by, created_at)
     VALUES (?, ?, 'jira', ?, ?, ?, ?)
     ON CONFLICT (incident_id, provider, external_key) DO NOTHING`,
    [link.id, link.incident_id, link.external_key, link.url, link.created_by, link.created_at],
  );
  return { result: "linked", link };
}

/** All external links for an incident, newest first. */
export async function listIncidentLinks(env: Env, incidentId: string): Promise<ExternalLink[]> {
  return new D1Db(env.DB).all<ExternalLink>(
    "SELECT * FROM incident_external_links WHERE incident_id = ? ORDER BY created_at DESC",
    [incidentId],
  );
}
