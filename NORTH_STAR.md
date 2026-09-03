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

- **Routing paths: internal vs external incidents** — the most substantive new idea.
  A fixed small set of incident shapes chosen at declare (e.g. external/upstream-POS =
  Customer-Support-Lead only, no Eng Lead, no on-call page; internal = full shape).
  Each path fixes which roles apply, whether on-call engages, and the comms surface.
- **Response teams = linked Slack user groups** — link an "Engineering response" and a
  "Customer support response" Slack usergroup; membership managed in Slack, not our
  app. One config constant per team. Replaces incident.io "Teams".
- **Scheduled maintenance** — first-class planned windows; flip components to
  `under_maintenance` for the window; no post-mortem.
- **Insights dashboards** — aggregate MTTR/MTTA/volume/action-item analytics on the
  existing `/api/reports` metrics ("definitely useful").
- **Historical incidents + follow-up action status** — browsable past-incident history
  + standing "outstanding action items" view.
- **Alerts: inbound email via Zendesk** — a mailbox/trigger forwards to `/api/alerts`,
  behind the alert-source abstraction (one adapter).
- **On-call roster mgmt (engineering only)** — surface the eng roster + overrides;
  support is always-on so has no rotation.
- **Escalations list** — standalone view over the `oncall_escalations` trail; not every
  incident has one.
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
