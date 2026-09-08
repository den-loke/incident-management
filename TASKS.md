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
  _(Shipped — PR #66 merged to main.)_
- [x] **#5 Structured post-incident editor** — the editor was already sectioned
  (Summary / Impact / Root cause / Contributing factors + action items). Added
  per-section help text, an embedded read-only incident timeline under Summary, and
  action-item guidance — the incident.io "structured editor with per-section
  guidance" shape, hard-coded (no section builder).
  _(PR: feat/structured-postmortem.)_
  _OPEN DECISION: whether to also RENAME/RESHAPE the DB-backed sections to
  incident.io's exact set (Contributors / Mitigators / Learnings-and-risks). That
  is a larger change — it churns the schema AND the AI drafter's output contract
  AND Jira/Insights plumbing — so it's flagged for Den rather than done here._

## Build-brief items (still open / blocked)

- [x] **Audit log (PCI)** — append-only `audit_log` table (migration `0017`) + a
  best-effort `recordAudit` helper. Instrumented at the web-API boundary (where the
  actor is known) for declare / severity / update / resolve-request / resolve-confirm,
  attributed to `web:<user>`. Session-gated `GET /api/audit` + a nav-integrated Audit
  page (actor names resolved, action labels, target, source badge).
  _(PR: feat/audit-log. Slack-interactivity + system/cron actors can be layered on later
  at those boundaries without schema change.)_
- [x] Stakeholder-waiting reminders — DONE. Migration `0018` adds `last_reminded_at`;
  `sweepStakeholderReminders` (piggybacks the 1-min cron tick) nudges the incident
  lead (Customer Support Lead → Engineering Lead → @channel) in the incident's Slack
  channel when an OPEN incident's `last_updated_at` is stale past its severity
  threshold (SEV1/SEV2 15m, SEV3 60m). Posting any update resets the clock;
  `last_reminded_at` gates re-nudges to one per threshold window. _(PR: feat/stakeholder-reminders.)_
- [~] SSO deprovisioning — OUT OF SCOPE (Den, cycle 7): auth is Sign-in-with-Slack OIDC + team_id allow-list, no separate IdP to deprovision from; Slack-workspace removal is the deprovision path and takes effect at next session check.
- [ ] Status-page email/SMS subscriptions
- [x] Codified decision flow — DONE (criteria from Den, cycle 7). Hard-coded LOKE
  criteria in `src/incidents/decisionFlow.ts` (single source of truth): severity
  SEV1/2/3, internal-vs-external routing, mid-incident escalation triggers, external-
  comms threshold. Surfaced BOTH as a read-only `/decision-guide` web page AND inline
  context guidance in the Slack declare modal. `GET /api/decision-flow` (session-gated).
  _(PR: feat/decision-flow.)_
- [ ] Jira/Zendesk create-from-incident + link-existing
- [x] MCP per-incident tools — `get_incident` / `get_incident_timeline` /
  `get_draft_report_data` added to the MCP connector, backed by a reusable
  `src/incidents/read.ts` (+ numeric `deriveDurationsSeconds`). Lets an agent drill
  into ONE incident (detail + timeline + durations + post-mortem) instead of only
  aggregates. _(PR: feat/mcp-incident-tools.)_
