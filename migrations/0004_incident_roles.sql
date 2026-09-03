-- Claimable, transferable incident roles. See ROADMAP.md.
-- Two roles per the team's model:
--   engineering_lead      — drives diagnosis + fix, technical calls, escalation
--   customer_support_lead — comms + (later) severity, informed by ticket volume
-- A role is claimed via a Slack button; claiming transfers it (one holder per
-- role per incident), so this is an upsert keyed on (incident_id, role).

CREATE TABLE IF NOT EXISTS incident_roles (
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  role          TEXT NOT NULL
                CHECK (role IN ('engineering_lead', 'customer_support_lead')),
  slack_user_id TEXT NOT NULL,
  assigned_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (incident_id, role)
);
