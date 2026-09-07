# TASKS

Working tracker for the goal-driven build loop. Ordered by the NORTH_STAR frontier.
See `NORTH_STAR.md` (frontier) and `ROADMAP.md` (detail) for the why.

## Screenshot-derived gaps (presentation)

- [x] **#2 Lifecycle timestamps + derived durations** — migration `0015` adds
  `identified_at` / `closed_at` / `last_updated_at`; stamped on the status write
  path (`internalSink`); Insights + reporting now compute real MTTA
  (created→identified) instead of the "first update after opening" proxy.
  _(Shipped — PR #63 merged to main.)_
- [x] **#1 Rich incident-detail page** — Properties rail (Timestamps & durations,
  Roles with initials chips, Slack link) + Activity timeline with "N later…" gap
  markers, in a two-column layout. Built on #2's timestamps.
  _(Shipped — PR #64 merged to main.)_
- [x] **#3 Escalation timeline view** — the flat one-line escalation log is now a
  grouped vertical timeline per alert: "Paged L1" → "Escalated to L2 — no ack in
  time", with "N later…" gap markers (minutes-scale) and per-level ack attribution
  + time-to-ack. Presentation over `oncall_escalations`.
  _(Shipped — PR #65 merged to main.)_
- [x] **#4 Notification delivery status** — migration `0016` adds `delivery_status`
  to `oncall_escalations`; the notifier now REPORTS failures (Slack/Twilio) instead
  of swallowing them, so a failed send persists a `failed` row. Surfaced in the
  escalation timeline (Delivered / Failed badge) + the open-alert trail.
  _(PR: feat/notification-delivery-status — closes the only new-data gap.)_
- [ ] **#5 Structured post-incident editor** — fixed sections. _Next up — likely
  the last screenshot-derived slice._

## Build-brief items (still open / blocked)

- [ ] Stakeholder-waiting reminders (cron vs `last_updated_at` — now that column exists)
- [ ] Audit log (PCI)
- [ ] SSO deprovisioning — BLOCKED on which IdP
- [ ] Status-page email/SMS subscriptions
- [ ] Codified decision flow — BLOCKED on criteria
- [ ] Jira/Zendesk create-from-incident + link-existing
- [ ] MCP per-incident tools (get_incident / get_incident_timeline / get_draft_report_data)
