-- Links between an incident and an external record (a Jira issue today; Zendesk
-- and others later). Create-from-incident and link-existing both write here.
-- See ROADMAP → "Jira/Zendesk create-from-incident + link-existing".
--
--   provider     — 'jira' (extensible: 'zendesk', …).
--   external_key — the provider's id (Jira issue key e.g. INC-42; Zendesk ticket id).
--   url          — browse/permalink URL.
--   created_by   — actor principal ('web:<user>' / slack id / 'system').
--
-- UNIQUE(incident_id, provider, external_key) makes link-existing idempotent:
-- re-linking the same key is a no-op rather than a duplicate row.

CREATE TABLE IF NOT EXISTS incident_external_links (
  id           TEXT PRIMARY KEY,
  incident_id  TEXT NOT NULL REFERENCES incidents(id),
  provider     TEXT NOT NULL,
  external_key TEXT NOT NULL,
  url          TEXT NOT NULL,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (incident_id, provider, external_key)
);

CREATE INDEX IF NOT EXISTS idx_incident_external_links_incident
  ON incident_external_links (incident_id);
