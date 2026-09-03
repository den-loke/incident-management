/// <reference types="@cloudflare/workers-types" />

// Environment bindings. See docs/ARCHITECTURE.md §10.
export interface Env {
  // Durable Object namespace: one instance per incident.
  INCIDENT: DurableObjectNamespace;
  // D1: incident data + internal status page (source of truth).
  DB: D1Database;
  // Static SPA assets (built from web/ into ./public). Optional so unit tests
  // (which don't bind ASSETS) still type-check; the fetch handler guards on it.
  ASSETS?: Fetcher;

  // --- Secrets / vars (per-deployment) ---
  SLACK_TEAM_ID: string; // the one workspace this install serves
  SLACK_BOT_TOKEN: string; // outbound Web API
  SLACK_SIGNING_SECRET: string; // verify inbound Events API signatures
  SLACK_CLIENT_ID: string; // Sign in with Slack (OIDC)
  SLACK_CLIENT_SECRET: string;
  OPENAI_API_KEY: string;

  STATUSPAGE_API_KEY?: string; // optional: enables the Statuspage mirror sink
  STATUSPAGE_PAGE_ID?: string;
  RECALLAI_API_KEY?: string; // optional: call transcription (later)

  // --- Optional: enables Jira action-item export on post-mortem publish ---
  JIRA_BASE_URL?: string; // e.g. https://acme.atlassian.net
  JIRA_EMAIL?: string; // account email for basic auth
  JIRA_API_TOKEN?: string; // Atlassian API token
  JIRA_PROJECT_KEY?: string; // e.g. INC
  JIRA_ISSUE_TYPE?: string; // defaults to "Task"

  AUTH_MODE?: string; // "bypass" for E2E; unset/"slack" in prod
}
