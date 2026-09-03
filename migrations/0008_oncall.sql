-- On-call: rotation, alerts, escalation. See docs/SPEC_ONCALL.md.
-- Single-tenant, opinionated: one weekly rotation shape, one 3-level escalation
-- ladder, one HMAC HTTP alert source, optional Twilio SMS/voice notifier.
-- Four tables; Twilio adds columns (phone / channel / provider_sid), not tables.

-- The pool of people who can be on call. Seeded from the Slack allow-list.
CREATE TABLE IF NOT EXISTS oncall_responders (
  id         TEXT PRIMARY KEY,               -- Slack user id (U...)
  name       TEXT NOT NULL,
  phone      TEXT,                            -- E.164 (+61...) for Twilio; NULL = Slack-only
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0       -- rotation order
);

-- Materialised rotation: one row per shift window. Generated ahead by cron so
-- "who is on call now/next" is a single indexed read; overrides are is_override rows.
CREATE TABLE IF NOT EXISTS oncall_shifts (
  id          TEXT PRIMARY KEY,
  responder   TEXT NOT NULL REFERENCES oncall_responders(id),
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  is_override INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_oncall_shifts_window ON oncall_shifts (starts_at, ends_at);

-- Every inbound alert, append-only (mirrors incident_updates).
CREATE TABLE IF NOT EXISTS oncall_alerts (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                  -- 'http' for now
  dedup_key   TEXT,                           -- caller-supplied; groups flaps
  title       TEXT NOT NULL,
  body        TEXT,
  severity    TEXT,                           -- optional hint, maps to incident severity
  status      TEXT NOT NULL DEFAULT 'firing'
              CHECK (status IN ('firing', 'ack', 'resolved')),
  incident_id TEXT REFERENCES incidents(id),  -- set if promoted
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_oncall_alerts_dedup  ON oncall_alerts (dedup_key, status);
CREATE INDEX IF NOT EXISTS idx_oncall_alerts_open   ON oncall_alerts (status, received_at);

-- Append-only audit of each escalation hop; also the source of truth for acks.
CREATE TABLE IF NOT EXISTS oncall_escalations (
  id           TEXT PRIMARY KEY,
  alert_id     TEXT NOT NULL REFERENCES oncall_alerts(id),
  level        INTEGER NOT NULL,              -- 0 primary, 1 next-responder+manager, 2 channel broadcast (terminal)
  target       TEXT NOT NULL,                 -- Slack user id paged; channel id at level 2
  channel      TEXT NOT NULL DEFAULT 'slack', -- 'slack' | 'sms' | 'voice' — which notifier fired
  provider_sid TEXT,                          -- Twilio Message/Call SID, for correlating a phone ack
  fired_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acked_at     TEXT,
  acked_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_oncall_escalations_alert ON oncall_escalations (alert_id, fired_at);
