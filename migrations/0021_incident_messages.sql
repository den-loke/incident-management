-- Unified incident conversation transcript. Captures EVERYTHING said in an
-- incident channel — human messages AND the bot's own posts (declares, updates,
-- summaries, page notices) — as one ordered log, so the post-incident report and
-- the incident-detail page have the full conversation, not just the 15-min AI
-- summaries. See ROADMAP → "Capture full incident-channel conversation" (pain #2).
--
--   kind          — 'human' (a person's message) | 'bot' (the app's own post).
--   slack_user_id — the author for human messages; NULL for bot posts.
--   text          — the message body (verbatim).
--   ts            — Slack message ts when known (human messages); else the
--                   capture instant. Used for chronological ordering.
--
-- Slack remains the system of record; this is our durable mirror for reporting.

CREATE TABLE IF NOT EXISTS incident_messages (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
  slack_user_id TEXT,
  text          TEXT NOT NULL,
  ts            TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_incident_messages_incident
  ON incident_messages (incident_id, ts);
