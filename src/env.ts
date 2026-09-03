/// <reference types="@cloudflare/workers-types" />

// Environment bindings. See docs/ARCHITECTURE.md §10.
export interface Env {
  // Durable Object namespace: one instance per incident.
  INCIDENT: DurableObjectNamespace;
  // Durable Object namespace: single-instance monotonic incident-number counter.
  INCIDENT_COUNTER: DurableObjectNamespace;
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
  // Non-secret var: which OpenAI model to use for summaries + post-mortem drafts.
  // Optional — falls back to a known-good default in the client when unset.
  OPENAI_MODEL?: string;

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

  // Public base URL of the deployed dashboard (e.g. https://incident-management-test.<sub>.workers.dev).
  // When set, Slack messages include a "View in dashboard" deep link back to the web UI.
  APP_BASE_URL?: string;

  // --- On-call (see docs/SPEC_ONCALL.md §7). All optional with sensible defaults. ---
  ONCALL_TZ?: string; // IANA tz for rotation changeover; default Australia/Melbourne
  ONCALL_ROTATION_DAYS?: string; // shift length in days; default 7 (weekly)
  ONCALL_ACK_TIMEOUT_MIN?: string; // minutes before escalating a level; default 10
  ONCALL_MANAGER?: string; // Slack user id — level-1 backstop mention
  ONCALL_FALLBACK_CHANNEL?: string; // Slack channel id if nobody is on call
  ONCALL_ALERT_SECRET?: string; // HMAC secret for POST /api/alerts
  ZENDESK_WEBHOOK_SECRET?: string; // HMAC secret for POST /api/alerts/zendesk (Zendesk trigger webhook). Unset = receiver disabled.
  ONCALL_TWILIO_ACCOUNT_SID?: string; // unset = Twilio notifier disabled
  ONCALL_TWILIO_AUTH_TOKEN?: string; // also validates inbound Twilio webhooks
  ONCALL_TWILIO_FROM?: string; // Twilio sending number (E.164)
  ONCALL_CHANNEL_POLICY?: string; // optional override of the L0/L1/L2 channel policy

  // --- Response teams = linked Slack user groups (see ROADMAP "Teams"). ---
  // Slack usergroup ids (the "S…" ids from usergroups.list). Membership is
  // managed IN SLACK; we only store which group is which team. Unset = that team
  // is unconfigured (resolves to an empty roster, never an error).
  TEAM_ENGINEERING_USERGROUP?: string;
  TEAM_SUPPORT_USERGROUP?: string;

  // --- MCP connector (see ROADMAP "MCP connector"). Read-only analytics over
  // MCP-over-HTTP at POST /mcp. Bearer token; unset = connector disabled. ---
  MCP_TOKEN?: string;

  // --- Partner status-page monitor (see ROADMAP "Alert routing" killer case). ---
  // JSON array of watched partners: [{"id","name","url"}] where url is a
  // Statuspage.io-style summary endpoint (…/api/v2/status.json). Unset = disabled.
  PARTNER_STATUS_FEEDS?: string;
}
