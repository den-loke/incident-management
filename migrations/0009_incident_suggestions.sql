-- Emoji accept/reject on app suggestions. See ROADMAP.md.
-- When the bot posts a suggestion (confirm-resolve, publish-postmortem, ...) it
-- records the message here; a reaction_added ✅/❌ on that exact (channel, ts)
-- resolves to the pending suggestion and dispatches accept/reject. Reactions on
-- anything NOT tracked here are ignored — this is not "pin any message".

CREATE TABLE IF NOT EXISTS incident_suggestions (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,              -- Slack channel id
  ts           TEXT NOT NULL,              -- Slack ts of the bot's suggestion message
  kind         TEXT NOT NULL,              -- 'confirm_resolve' | 'publish_postmortem' | ...
  payload      TEXT,                       -- JSON blob the dispatcher needs (e.g. requested_by)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'rejected')),
  decided_by   TEXT,                       -- Slack user id who reacted first
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  decided_at   TEXT
);
-- One suggestion per (channel, ts); the reaction handler looks up by this pair.
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_suggestions_msg
  ON incident_suggestions (channel, ts);
CREATE INDEX IF NOT EXISTS idx_incident_suggestions_incident
  ON incident_suggestions (incident_id, status);
