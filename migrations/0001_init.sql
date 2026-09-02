-- Incident-management status model. See docs/ARCHITECTURE.md §5.
-- Components model 1:1 with Statuspage so the internal page and the Statuspage
-- mirror never drift.

CREATE TABLE IF NOT EXISTS components (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'operational'
             CHECK (status IN (
               'operational',
               'degraded_performance',
               'partial_outage',
               'major_outage',
               'under_maintenance'
             )),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'investigating'
              CHECK (status IN (
                'investigating',
                'identified',
                'monitoring',
                'resolved'
              )),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resolved_at TEXT
);

-- Append-only timeline, mirroring how Statuspage appends incident_updates.
CREATE TABLE IF NOT EXISTS incident_updates (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL
              CHECK (status IN (
                'investigating',
                'identified',
                'monitoring',
                'resolved'
              )),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_incident_updates_incident
  ON incident_updates (incident_id, created_at);
