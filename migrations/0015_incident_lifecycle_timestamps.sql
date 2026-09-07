-- Lifecycle timestamps on incidents. Enables incident.io-style detail durations
-- (time-to-identify, time-to-resolve) and fixes the Insights MTTA proxy.
-- See ROADMAP.md → "Next (from incident.io screenshots)" #2 and NORTH_STAR frontier.
--
-- All nullable — an incident may never reach `identified`, and older rows predate
-- these columns. For us these are HARD-CODED lifecycle stamps written on the status
-- write path (internalSink), NOT a configurable workflow ("set X when Y").
--
--   identified_at   — first time status reached 'identified' (or beyond).
--   closed_at       — when the incident was closed. We close on resolve, so this
--                     tracks resolved_at today, but is kept distinct so a later
--                     post-incident "closed" step can diverge without a migration.
--   last_updated_at — bumped on every status change / appended update. Backfilled
--                     to created_at; kept current so the detail page can show
--                     "last updated N ago" without scanning the timeline.

ALTER TABLE incidents ADD COLUMN identified_at   TEXT;
ALTER TABLE incidents ADD COLUMN closed_at       TEXT;
ALTER TABLE incidents ADD COLUMN last_updated_at TEXT;

-- Backfill existing rows so durations render for historical incidents.
-- last_updated_at: latest update if any, else resolved_at, else created_at.
UPDATE incidents
   SET last_updated_at = COALESCE(
     (SELECT MAX(created_at) FROM incident_updates WHERE incident_id = incidents.id),
     resolved_at,
     created_at
   )
 WHERE last_updated_at IS NULL;

-- closed_at: mirror resolved_at for already-resolved incidents.
UPDATE incidents
   SET closed_at = resolved_at
 WHERE closed_at IS NULL AND resolved_at IS NOT NULL;

-- identified_at: first update whose status was 'identified' or later
-- ('identified','monitoring','resolved'). Order lifecycle by rank via CASE.
UPDATE incidents
   SET identified_at = (
     SELECT MIN(created_at) FROM incident_updates
      WHERE incident_id = incidents.id
        AND status IN ('identified', 'monitoring', 'resolved')
   )
 WHERE identified_at IS NULL;
