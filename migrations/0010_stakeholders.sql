-- Standing stakeholder subscriptions. A single-tenant, opt-in list: any Slack
-- user who opts in from the app Home tab is a "stakeholder" and gets invited to
-- the channel of every FUTURE incident at declare time. See src/stakeholders.
--
-- Deliberately NOT per-incident invite config — the process is hard-coded
-- (opt in once => on every future incident), matching the single-tenant stance.

CREATE TABLE IF NOT EXISTS incident_stakeholders (
  slack_user_id TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
