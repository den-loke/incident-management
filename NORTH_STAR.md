# North Star

The single source of intent for this project. Read this first, then
[`ROADMAP.md`](ROADMAP.md) for the ordered feature list and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for *how* it's built. This file is
for **goal-driven development**: a session (human or agent loop) should be able to
read it and know what to build next and what must never be broken.

## The goal

A **reliable, serverless, single-tenant incident-management tool** — an
opinionated, hard-coded alternative to incident.io for one team / one Slack
workspace. Slack-first, with a web mirror. It should "just work when we depend on
it": incidents are long-lived, timer-driven, stateful processes, so correctness and
durability beat features.

## Invariants (do NOT violate — these are decisions, not preferences)

1. **Single-tenant, hard-coded process.** No config surfaces / builders / settings
   screens. Fields, severities, roles, workflows, templates, checklists are
   hard-coded. Configurability is incident.io SaaS thinking that does not apply.
2. **Serverless Cloudflare stack.** Workers + Durable Objects (one per incident,
   owns the 15-min alarm) + D1 (source of truth) + cron triggers. No always-on
   process; time-driven work is cron-driven, never a live timer.
3. **Internal status page only.** Statuspage.io is the external *mirror*, never
   replaced. A public/branded customer status page is OUT of scope.
4. **Two claimable roles**: Engineering Lead (fix + technical calls) and Customer
   Support Lead (comms + owns severity). No separate Incident Lead.
5. **Resolve is joint sign-off**: Eng requests → a *different* person confirms.
   Two-person flows enforce only confirmer≠requester — never hard-require an
   unclaimed role (deadlock).
6. **Internal AI summaries stay automatic.** The only human 👍 gate is the
   outbound-to-customers (Statuspage) hop.
7. **UI is vanilla black/white ShadCN, borderless — no side borders, ever.**
8. **Named wrangler envs don't inherit** top-level config — repeat
   durable_objects/assets/migrations/triggers/vars per env. Non-secret config is a
   `var`; only real credentials are secrets.

## Current state (update as you ship)

- **Deployed test env** live on LOKE Cloudflare:
  `https://incident-management-test.lokeglobal.workers.dev` — real D1, cron
  registered, Slack app wired, Events URL verified, channel creation confirmed.
- **Shipped to main**: Slack incident engine, OIDC + React/ShadCN web UI, web
  incident management, post-mortems, reporting, claimable roles, joint-resolve,
  Jira export, severity (SEV1/2/3), Slack↔web deep links, reaction accept/reject,
  sequential INC-<n> ids, Slack App Home tab + stakeholder subscriptions,
  `/incident` slash commands, and an **incident-controls panel** (all actions —
  update / status / escalate / severity / request-resolve — as Slack buttons +
  modals; slash commands optional).
- **On-call** (epic, see [`docs/SPEC_ONCALL.md`](docs/SPEC_ONCALL.md)): slices
  1 (rotation + shift-gen cron), 2 (HTTP alert ingestion), 3 (escalation ladder +
  sweep cron + Slack notifier + ack), 4 (Twilio SMS/voice paging behind the
  `Notifier` interface + phone-ack webhooks, config-gated on `ONCALL_TWILIO_*`),
  5 (alert→incident bridge — Create-incident button posts a back-link into the
  alert channel + `/incident escalate` out-of-band paging), 6 (web On-call
  section — `GET /api/oncall` + who's-on/rotation/open-alerts UI with
  ack/create-incident/override buttons reusing the Slack action functions),
  7 (docs — ARCHITECTURE §13 overview + env table, on-call moved to Shipped in
  `ROADMAP.md`) **done — the on-call epic is COMPLETE.**

## Next goal (the frontier)

The on-call epic and the **incident action buttons in Slack** are both **done**.
On 2026-09-03 Den reviewed the incident.io sidebar and set a fresh batch of
directions (full detail in `ROADMAP.md` → "Next (from incident.io sidebar review)").
Through-line unchanged: single-tenant, hard-coded, Slack-native — several of these
collapse incident.io config screens into "point at a Slack group" or "one fixed
shape". Rough value order:

- **Conversational control — @-mention the bot** — **✅ DONE** (`src/incidents/intent.ts`:
  intent classifier + `applyIntent`; `@bot update please`/`set status …`/`this is sev1`/
  `escalate to @x`/`summary?`/`resolve` dispatched through the shared command functions;
  new on-demand DO `summarize` command; unknown → help reply).
- **Routing paths: internal vs external incidents** — **✅ DONE** (`routing_path` on
  incidents, migration 0011; external = Support-Lead-only roles). **On-call is now
  gated by route too** — see alert routing.
- **Alert routing** — **✅ DONE**, incl. the **partner status-page monitor** (poll
  `PARTNER_STATUS_FEEDS` on the 1-min cron / every 5th min → non-operational partner
  emits a `route:"external"` alert → comms notice + Create-incident button, no page;
  auto-resolves on recovery; `src/oncall/partnerMonitor.ts`). The whole alert-routing +
  upstream/partner story is now shipped.
- **Response teams = linked Slack user groups** — **✅ DONE** (`src/teams/service.ts`:
  Engineering + Support each link a Slack usergroup via `TEAM_*_USERGROUP` config,
  resolved via `usergroups.users.list`; `GET /api/teams` + web Teams section;
  read-only, membership managed in Slack — no CRUD. Replaces incident.io "Teams").
- **Scheduled maintenance** — **✅ DONE** (`maintenance_windows`, migration 0013;
  cron reconcile flips components to `under_maintenance` for the window then restores;
  web "Scheduled maintenance" section + `POST /api/maintenance`; no post-mortem).
- **Insights dashboards** — **✅ DONE** (`GET /api/insights` + `InsightsSection`:
  volume by severity/path, monthly opened/resolved trend, MTTR per bucket + overall,
  action-item backlog; monochrome bar charts, period selector).
- **Historical incidents + follow-up action status** — **✅ DONE** (`GET /api/followups`
  cross-incident action items + `GET /api/history` browsable past incidents with filters;
  web "Follow-ups & history" section; `src/reporting/followups.ts`).
- **Alerts: Zendesk webhook receiver** — **✅ DONE** (`POST /api/alerts/zendesk`,
  `src/oncall/zendesk.ts`: shared-secret `X-Signature` verify + Zendesk-payload→AlertInput
  adapter over the existing `ingestAlert`/`routeNewAlert` pipeline; setup docs in
  `docs/DEPLOY.md`. Webhook, not mail ingestion — one adapter, alert model unchanged).
- **On-call roster mgmt (engineering only)** — **✅ DONE** (web On-call section reframed
  as the Engineering roster: "(Engineering roster)" header, "Rotation & overrides"
  subheading, "Support is always-on — no rotation" note; label/clarity change, no logic —
  no support-rotation concept existed to remove).
- **MCP connector (analytics-first)** — **✅ DONE** (`src/mcp/server.ts`: MCP-over-HTTP
  at `POST /mcp`, bearer-token via `MCP_TOKEN`; read-only tools `get_report`,
  `get_insights`, `list_follow_ups`, `list_incidents` wrapping the reporting layer;
  no SDK dep. Live-response tools remain a later, secondary addition).
- **Post-incident flow (surface the fixed checklist)** — **✅ DONE**
  (`src/postmortem/postIncidentFlow.ts`: `buildPostIncidentFlow` derives the fixed
  checklist per incident — resolved → drafted → items captured → items filed → published;
  `GET /api/incidents/:id/post-incident-flow`; web Post-incident flow checklist. Read-only,
  no builder).
- **Escalations list + read-only escalation-path diagram** — **✅ DONE**
  (`src/oncall/escalationPath.ts`: `listEscalationEvents` cross-alert log +
  `buildEscalationPath` config-derived ladder; both folded into `GET /api/oncall` as
  `escalation_events` + `path`; web On-call **Escalations** list + read-only
  **Escalation path** diagram).
- Parked / likely out of scope: **Catalog** (multi-tenant tooling; our fixed component
  list covers it). Still deferred, own effort: real StatuspageSink + ≥severity Statuspage
  prompt, the not-yet-wired emoji ✅/❌ producers, status-page fixture/preview route,
  Recall.ai, per-env custom domains, dedicated push app.

## How to work (the loop)

1. Pick the next unstarted item from **Next goal** above (or the top of
   `ROADMAP.md`).
2. Build it on a feature branch — **never commit straight to `main`'s working
   tree** (that caused a multi-session tangle once; a nested worktree's tests also
   double-collect against the shared D1, so keep worktrees out of the repo root or
   excluded in `vitest.config.ts`).
3. Match existing conventions: unique per-file test ids + `INSERT OR IGNORE` +
   scoped cleanup (shared D1, `isolatedStorage:false`); injected-override fakes for
   Slack/OpenAI; migrations are idempotent + version-tracked.
4. Green gate before PR: `npm --prefix web run build` + `npx tsc --noEmit` +
   `npx vitest run`.
5. Open a PR with `gh pr create --body-file`; keep the human's standing
   "keep merging and building" autonomy but flag anything that touches real
   accounts / is destructive.
6. Update **Current state** and **Next goal** here when a slice lands.
