-- Append-only audit log. PCI DSS L1 (build brief) wants a durable "who did what,
-- when" record of state-changing actions. See ROADMAP.md → "Audit log" and the
-- build brief (SSO + audit log are the two compliance drivers).
--
-- Deliberately append-only: no UPDATE/DELETE path in code. Actor is recorded as
-- captured at the surface boundary — a Slack user id, a "web:<user>" session
-- principal, or "system" for cron/automation — so attribution never depends on
-- threading an actor through every internal service.
--
--   actor       — who: Slack user id, 'web:<user_id>', or 'system'.
--   action      — verb, e.g. 'incident.declare', 'incident.resolve.request',
--                 'incident.severity.set', 'incident.update.post'.
--   target_type — 'incident' | 'postmortem' | 'alert' | 'component' | …
--   target_id   — the affected entity id (nullable for global actions).
--   detail      — optional JSON blob with action-specific context.
--   source      — 'web' | 'slack' | 'system'.

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  source      TEXT NOT NULL DEFAULT 'web'
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_type, target_id);
