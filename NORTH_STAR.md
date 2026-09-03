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
  sequential INC-<n> ids, Slack App Home tab + stakeholder subscriptions.
- **On-call** (epic, see [`docs/SPEC_ONCALL.md`](docs/SPEC_ONCALL.md)): slices
  1 (rotation + shift-gen cron), 2 (HTTP alert ingestion), 3 (escalation ladder +
  sweep cron + Slack notifier + ack), 4 (Twilio SMS/voice paging behind the
  `Notifier` interface + phone-ack webhooks, config-gated on `ONCALL_TWILIO_*`)
  **done**.

## Next goal (the frontier)

Finish the on-call epic, in order:
- **Slice 5** — alert→incident bridge (core `promoteAlertToIncident` already
  landed in slice 3; finish the surface — `/inc escalate` sub-command + post the
  incident channel link back into the alert thread).
- **Slice 6** — web On-call section (rotation, open alerts, override/ack/create).
- **Slice 7** — docs; move on-call to Shipped.

(Slice 4 — Twilio SMS/voice paging + phone-ack webhooks — is **done**; it is
config-gated on `ONCALL_TWILIO_*` and hard to test end-to-end without a real
Twilio account, so it ships functionally complete with a fake-Twilio test suite.)

Then the deferred items: real StatuspageSink + the ≥severity Statuspage prompt,
Recall.ai call transcription, per-env custom domains, the emoji accept/reject
producers not yet wired (severity-bump suggestion, auto-drafted status update),
and a dedicated push/notification app (its own spec).

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
