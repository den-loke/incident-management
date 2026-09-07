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
  _(PR: feat/rich-incident-detail — next up.)_
- [ ] **#3 Escalation timeline view** — vertical timeline over the escalation events
  we already store (presentation over `oncall_escalations`). _Next up._
- [ ] **#4 Notification delivery status** — persist Delivered/Failed per notification
  (only new data gap; notifier currently fires-and-forgets).
- [ ] **#5 Structured post-incident editor** — fixed sections.

## Build-brief items (still open / blocked)

- [ ] Stakeholder-waiting reminders (cron vs `last_updated_at` — now that column exists)
- [ ] Audit log (PCI)
- [ ] SSO deprovisioning — BLOCKED on which IdP
- [ ] Status-page email/SMS subscriptions
- [ ] Codified decision flow — BLOCKED on criteria
- [ ] Jira/Zendesk create-from-incident + link-existing
- [ ] MCP per-incident tools (get_incident / get_incident_timeline / get_draft_report_data)
