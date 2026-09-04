-- Slack user directory: a durable pull-through cache of user id → display name.
-- See src/slack/directory.ts.
--
-- Why persist (not just an in-isolate cache): incidents reference user ids
-- (roles, acked_by, escalation targets) forever. If that person later leaves the
-- workspace, Slack's users.list no longer returns them — but we still want to
-- render their NAME on the historical incident. So every id→name we ever resolve
-- is upserted here and survives the user leaving.

CREATE TABLE IF NOT EXISTS slack_users (
  slack_user_id TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
