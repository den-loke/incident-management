-- Joint sign-off resolve. See ROADMAP.md.
-- Resolving an incident is a two-person handshake: someone (the Engineering
-- Lead, typically) REQUESTS resolution; a DIFFERENT person (the Customer
-- Support Lead, typically) CONFIRMS it, which performs the actual resolve.
-- One open request per incident; confirming stamps confirmed_at.

CREATE TABLE IF NOT EXISTS incident_resolution_requests (
  incident_id   TEXT PRIMARY KEY REFERENCES incidents(id),
  requested_by  TEXT NOT NULL,          -- Slack user id (or 'web:<user>')
  requested_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  note          TEXT,
  confirmed_by  TEXT,                    -- set when confirmed
  confirmed_at  TEXT
);
