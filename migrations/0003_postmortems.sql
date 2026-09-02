-- Post-mortems: one structured incident review per incident. See ROADMAP.md.
-- The incident timeline itself lives in incident_updates and is referenced, not
-- duplicated. A post-mortem is auto-drafted on resolve, then human-edited and
-- optionally published.

CREATE TABLE IF NOT EXISTS postmortems (
  id                   TEXT PRIMARY KEY,
  incident_id          TEXT NOT NULL UNIQUE REFERENCES incidents(id),
  status               TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'published')),
  summary              TEXT NOT NULL DEFAULT '',
  impact               TEXT NOT NULL DEFAULT '',
  root_cause           TEXT NOT NULL DEFAULT '',
  contributing_factors TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at         TEXT
);

CREATE TABLE IF NOT EXISTS postmortem_action_items (
  id            TEXT PRIMARY KEY,
  postmortem_id TEXT NOT NULL REFERENCES postmortems(id),
  description   TEXT NOT NULL,
  owner         TEXT,
  done          INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_action_items_pm
  ON postmortem_action_items (postmortem_id);
