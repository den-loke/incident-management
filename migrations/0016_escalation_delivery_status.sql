-- Per-notification delivery status on escalation rows. incident.io shows
-- Delivered / Failed per notification in the escalation timeline; our notifier
-- previously fired-and-forgot (a failed Slack post produced no row, a failed
-- Twilio hop was swallowed). Now every attempt records a row with its outcome.
-- See ROADMAP.md → "Notification delivery status" and NORTH_STAR frontier #4.
--
--   delivered — the provider accepted the send (Slack ts returned / Twilio SID).
--   failed    — the send threw (Slack API error, Twilio hop failed).
--   pending   — reserved; not written yet (kept for a future async-status webhook).
--
-- Existing rows predate the column and only ever existed because a send
-- succeeded, so they default to 'delivered'.

ALTER TABLE oncall_escalations
  ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'delivered'
  CHECK (delivery_status IN ('delivered', 'failed', 'pending'));
