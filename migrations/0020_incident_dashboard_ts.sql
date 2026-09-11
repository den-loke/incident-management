-- Sticky in-Slack incident "dashboard" post. On declare we post ONE Block Kit
-- message (status · severity · roles · action buttons), pin it to the channel,
-- and store its ts here. Every later state change (status, severity, role claim,
-- resolve) chat.update()s that same message in place instead of posting a new
-- one — so the channel keeps a single, always-current control surface at the top.
-- See src/incidents/dashboard.ts.

ALTER TABLE incident_channels ADD COLUMN dashboard_ts TEXT;
