# Roadmap

The source-of-truth roadmap for the incident-management tool (not just tickets).
Ordered roughly by sequence, not priority. Architecture rationale lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Product stance: single-tenant, opinionated, hard-coded

This tool is **single-tenant** (one Slack workspace per deploy) and deliberately
**hard-codes the incident process**. incident.io is a multi-tenant SaaS, so most of
its surface area is *configurability* — builders and settings screens that let
thousands of teams each define their own process. We serve one team, so that entire
configuration layer collapses into opinionated defaults written in code.

**Deliberately hard-coded — we will NOT build a config layer for these:**
- **Custom fields** → fixed schema (`affected_services`, `severity`, `lead`, …).
- **Severities & statuses** → one fixed enum (`investigating → identified → fixing →
  resolved`, and a fixed severity scale).
- **Declare form** → one fixed form.
- **Workflows / automation** → hard-coded rules in the DO, not a trigger→action
  builder. (E.g. "on severity ≥ Major, prompt to update the status page.")
- **Incident roles** → a fixed *set* of two roles (Engineering Lead, Customer
  Support Lead), **claimable and transferable** via Slack buttons — no
  role-definition UI, but not statically assigned either (see Shipped).
- **Post-incident flow** → one fixed checklist, not a builder.
- **Postmortem template** → one fixed template (the one we already ship).
- **Status-page components & branding** → hard-coded to our product + our branding.

Recording this so it's a decision, not an oversight: these show up in a competitor
demo as "features," but for us they are one-line constants, not roadmap items.

**Also out of scope (decided):**
- **Public / branded customer-facing status page.** We keep only the internal
  status page. Statuspage.io remains the external mirror if/when its sink is built.

## Shipped
- ✅ **Incident engine** — declare / update / resolve via Slack; one Durable Object
  per incident; 15-min alarm → OpenAI summary → progress-update loop.
- ✅ **Resolve-from-Slack** wiring.
- ✅ **Web UI (read-only status page)** — Slack OIDC auth (`team_id` allow-list,
  signed-cookie session) + React/ShadCN status page rendering components + incident
  timeline from D1 via `GET /api/status`. Two-env deploy config (`test` /
  `production`).
- ✅ **Web-based incident management** — declare / post update / resolve / edit
  component status from the dashboard via `POST /api/incidents*`, driving the **same
  Incident DO command API** Slack uses, so Slack and web stay in sync (shared
  `src/incidents/commands.ts`).
- ✅ **Post-mortems** — auto-drafted on resolve (OpenAI JSON-mode over the Slack
  channel + D1 timeline), human-editable/regenerate/publish in the web UI, action
  items with toggle. `migrations/0003`, `PostmortemStore`, session-gated API. Never
  auto-published; never overwrites a published doc.
- ✅ **Reporting** — aggregate metrics over a period: opened/resolved/open-now,
  MTTR (open→resolved), MTTA proxy (open→first update after opening; no explicit ack
  event yet), open action-item backlog. `GET /api/reports?period=…&format=csv`
  (JSON + CSV export) + a reporting panel in the web UI. (Per-component counts and a
  scheduled digest deliberately omitted — see notes below.)
- ✅ **Incident roles (claimable + transferable)** — two roles, **Engineering Lead**
  (fix + technical calls + escalation) and **Customer Support Lead** (comms + owns
  severity, informed by ticket volume). Claimed via Slack buttons (a new
  `/slack/interactivity` endpoint), one holder per role, claiming transfers.
  `migrations/0004`, shown on the incident card.
- ✅ **Joint sign-off resolve** — resolving is a two-person handshake: someone
  requests (Eng Lead typically), a **different** person confirms (Support Lead
  typically), and the confirm performs the real resolve + post-mortem draft.
  `migrations/0005`. Confirmer ≠ requester enforced; Support Lead is the intended
  confirmer but not hard-required (avoids deadlock if unclaimed).
- ✅ **Slack interactivity endpoint** — `/slack/interactivity` (signed
  `block_actions`), the surface roles + joint-resolve buttons use and on-call will
  reuse.

## Next (capability gaps — real functionality, not config)

Ordered roughly by value/effort. Each non-trivial item gets its own mini-spec.

- **Jira integration (action-item export).** *Medium.* **Next up.** On postmortem
  save/publish, export action items to **Jira** issues (create + link back; keep
  status in sync where feasible). Behind an abstraction so the tracker is swappable,
  but Jira is the day-one target. Store the external issue key on
  `postmortem_action_items`.

- **Severity model.** *Small, but a real decision — not yet built.* Incidents
  currently have only a lifecycle status (`investigating → identified → monitoring →
  resolved`), no severity. Adding a fixed severity scale unlocks: "Customer Support
  Lead owns severity" as a concrete field, and the severity-gated Statuspage prompt
  below. Do this before/with the Statuspage-prompt work.

- **Status-page prompt (severity-gated, coupled to StatuspageSink).** *Small, but
  DEFERRED until StatuspageSink is real.* Internal AI summaries stay **automatic** —
  a wrong internal note is cheaply corrected, so no gate there (decided). The only
  place a human 👍 is warranted is the **outbound-to-customers** hop: when a
  qualifying (e.g. ≥ Major) update would mirror to Statuspage.io, prompt "post this
  to the status page?" first. This is the "one hard-coded workflow" — it *is* this
  prompt, not a separate concept — and it can't be built until the StatuspageSink
  exists (see Later) and severity is modelled.

- **Incident action buttons in Slack (slash commands optional).** *Medium.*
  **Requested 2026-09-03.** Every incident action should be doable from **buttons on
  the incident message/panel** — not only via `/incident …` slash commands. Today the
  bot posts an "Incident roles" Block Kit message with **Take Engineering Lead** /
  **Take Customer Support Lead** buttons + a dashboard link; extend that panel (or add
  a pinned "incident controls" message) with the full action set: **Post update**,
  **Change status** (investigating/identified/monitoring), **Escalate** (page more
  hands / on-call), **Request resolve**, **Change severity**. Text-entry actions
  (update, escalate message) open a **modal** (`views.open`) — the same
  `view_submission` pattern the declare modal already uses — so no typing in-channel
  is required. Slash commands stay as an equivalent power-user path but become
  **optional**, not the primary interface. Reuses the existing `/slack/interactivity`
  `block_actions` handler + the shared `declareIncident`/`postIncidentUpdate`/
  `setSeverity`/`requestResolve`/escalate service functions, so Slack, web, and
  buttons all drive the same command path. No new hard-coded process — just more
  affordances on the existing one. (Keep the panel monochrome/opinionated; one fixed
  button set, not a configurable action builder.)

- **Emoji accept/reject on app suggestions.** *Small–medium.* Let responders act on
  a suggestion the **app itself** posts (an AI-drafted status update, "post this to
  the status page?", "publish this post-mortem draft?") by reacting **✅ / ❌** on the
  bot's message — no button, no typing. Generic substrate: when the bot posts a
  suggestion it records `(channel, ts, kind, payload, status=pending)` in a new
  `incident_suggestions` table and seeds the ✅/❌ affordances; a `reaction_added`
  handler resolves `(channel, ts)` to a pending suggestion and dispatches
  accept/reject (first reaction wins, reactor recorded). Reactions on anything NOT a
  tracked suggestion are ignored — this is deliberately not "pin any message".
  Needs the `reaction_added` event (already subscribed) + the `reactions:read` bot
  scope. First real producers to wire: **joint-resolve confirm** (✅ confirms) and
  **post-mortem publish** (✅ publish / ❌ discard) — both exist today — with the
  deferred Statuspage prompt plugging into the same layer once StatuspageSink lands.
  (Requested 2026-09-03; parked to keep the first real end-to-end declare unblocked.)

  **Candidate suggestion producers** (the substrate is generic; each is a `kind` +
  payload the ✅/❌ dispatcher knows how to apply):
  - **Joint-resolve confirm** — Eng requests resolve → ✅ confirms (reactor ≠
    requester still enforced). *Exists today.*
  - **Post-mortem publish** — auto-draft ready → ✅ publish, ❌ keep as draft. *Exists today.*
  - **Status-page mirror (≥ severity)** — "post this update to the status page?" →
    ✅ mirror, ❌ internal-only. *Deferred (StatuspageSink).*
  - **Severity-change suggestion** — AI/ticket-volume signal suggests a bump
    ("looks like SEV1?") → ✅ applies `setSeverity`, ❌ dismiss.
  - **Auto-drafted status update** — the 15-min AI summary posted as a *suggested*
    update for qualifying incidents → ✅ accept as official, ❌ discard/regenerate
    (internal notes stay automatic by default).
  - **On-call escalation ack** — paged responder reacts ✅ to acknowledge and stop
    the ladder (emoji path alongside the Block-Kit Ack button). *Ties to on-call slice 3.*
  - **Role claim** — ✅ on the "Take Engineering/Support Lead" prompt claims the role
    (emoji alternative to the Block-Kit button).
  Start with the two that exist today; the rest attach to the same table + dispatcher
  as their producers land.

## On-call *(the one large epic — needs its own spec)*

The only pillar hard-coding does **not** shrink much: even a single team needs a real
rotation, escalation, and alert ingestion. Keep it **minimal and opinionated**, not
configurable:
- **Schedule** — one rotation shape (responders, rotation length, change-over);
  overrides by click. Holiday feed optional.
- **Escalation path** — one opinionated shape (e.g. Slack during hours → on-call
  after hours → manager as second line; round-robin over available on-callers).
- **Alert source** — HTTP source only to start (Datadog/Grafana/Prometheus post to
  it). Optional AI attribute extraction from the payload later.
- **Alert routes** — filter → escalate / create incident / forward to Slack; alert→
  incident button in Slack; simple time+team grouping.
- **Escalate from Slack** — `/inc escalate <team|user>` with a paging message.

## Later (deferred)
- **StatuspageSink** real implementation (currently a stub) + Statuspage
  outbound-webhook subscription (consume component/incident events back).
- **Recall.ai** call transcription (Zoom / Meet / Teams / Webex) behind the
  abstraction.
- **Custom domains** per environment (code already origin-relative; DNS only).
- **Status-page fixtures:** dev-only `?fixture=<name>` preview route rendering
  hardcoded states (all-operational, degraded, partial/major outage, each incident
  lifecycle phase, maintenance) + `scripts/shoot-states.ts` driving `wrangler dev`
  with Playwright to save `screenshots/<state>.png`. Lightweight — not Storybook.
