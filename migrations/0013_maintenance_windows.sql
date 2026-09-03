-- Scheduled maintenance. See ROADMAP.md → "Scheduled maintenance".
-- A planned window is a first-class thing, distinct from an incident: it has a
-- start/end, flips affected components to 'under_maintenance' for the window, and
-- has NO post-mortem. Reconciliation is cron-driven (like escalation sweeps), so
-- windows activate/complete on schedule without a live timer.

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT,
  components TEXT NOT NULL DEFAULT '[]',        -- JSON array of component ids
  starts_at  TEXT NOT NULL,
  ends_at    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'scheduled'
             CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_window ON maintenance_windows (status, starts_at, ends_at);
