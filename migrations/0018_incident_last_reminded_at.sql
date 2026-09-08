-- Stakeholder-waiting reminders: track when we last nudged, so the 1-min sweep
-- re-nudges at the per-severity cadence rather than every single minute once an
-- incident is overdue. See ROADMAP → "Stakeholder-waiting reminders" (pain #1).
--
-- The reminder fires when now - last_updated_at >= threshold AND we haven't
-- nudged within the last threshold window (now - last_reminded_at >= threshold).
-- Posting ANY incident update bumps last_updated_at (migration 0015 write path),
-- which resets the reminder clock — a reminder is a prompt to post, not a nag.
--
-- Nullable: an incident that has never been reminded has NULL here.

ALTER TABLE incidents ADD COLUMN last_reminded_at TEXT;
