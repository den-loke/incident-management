-- Alert routing. See ROADMAP.md → "Alert routing".
-- A fixed, hard-coded routing decision (NOT a rule builder): an inbound alert
-- carries an optional `route` that decides what happens to it —
--   internal (default) = our own systems: engage on-call escalation (page).
--   external           = an upstream/partner signal we mostly COMMUNICATE:
--                        do NOT page on-call; post to the alerts/comms channel and
--                        leave it for a human to promote to an incident on the
--                        external routing path.
-- Mirrors incidents.routing_path (migration 0011); the route sets the incident's
-- path when promoted. Existing rows backfill to 'internal'.

ALTER TABLE oncall_alerts ADD COLUMN route TEXT NOT NULL DEFAULT 'internal'
  CHECK (route IN ('internal', 'external'));
