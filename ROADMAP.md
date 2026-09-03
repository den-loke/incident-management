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
- ✅ **Jira integration (action-item export)** — on post-mortem publish, action items
  export to Jira issues behind a swappable `IssueTracker` (no-op when unconfigured).
- ✅ **Severity model** — fixed SEV1/2/3 scale, set at declare, changeable during the
  incident (timeline event), owned by the Customer Support Lead.
- ✅ **On-call** *(the one large epic — see [`docs/SPEC_ONCALL.md`](docs/SPEC_ONCALL.md)
  and ARCHITECTURE §13)* — minimal, opinionated, single-team on-call:
  - **Rotation** — one weekly shape (Mon 10:00 `ONCALL_TZ` changeover, round-robin),
    shifts materialised ahead by a daily cron; click **overrides**.
  - **Alert ingestion** — `POST /api/alerts` (HMAC), dedup-by-key + auto-resolve on recovery.
  - **Escalation ladder** — L0 primary → L1 next responder + `@manager` → L2 `@channel`,
    cron-driven timeout (`sweepEscalations`), any user acks to stop it.
  - **Notifiers** — Slack always on; **Twilio SMS/voice** optional behind a `Notifier`
    abstraction (config-gated), with SMS `Y`/voice press-1 phone ack.
  - **Alert → incident bridge** — Create-incident button (Slack + web) + `/incident escalate`.
  - **Web On-call section** — who's on now/next, rotation, open alerts with escalation
    trail, and Ack / Create-incident / Override buttons.

## Next (from incident.io sidebar review — 2026-09-03)

Den walked the incident.io left-nav (screenshots) and mapped each section to what we
actually want. The through-line stays our stance: **single-tenant, hard-coded,
Slack-native** — several of these deliberately collapse incident.io's config screens
into "point at a Slack group" or "one opinionated shape".

**Full sidebar → our disposition** (incident.io nav item → what we do):

| incident.io nav | Our disposition |
|---|---|
| **Teams** (Engineering, Support, …) | **✅ Shipped** — linked Slack user groups (config), not a team-mgmt UI (below). |
| On-call › **Alerts** | Have `POST /api/alerts`; **✅ Zendesk webhook receiver** `POST /api/alerts/zendesk` added (below). |
| On-call › **Alert routing** | **New** — route inbound alerts; **partner status-page monitor** is the killer case (below). |
| On-call › **Escalations** | **✅ Shipped** — cross-alert escalations list over `oncall_escalations` (below). |
| On-call › **Escalation paths** | **✅ Shipped** — read-only annotated ladder diagram (no builder; below). |
| On-call › **Schedules** | **Shipped** — the rotation + overrides. |
| On-call › **Maintenance** | **✅ Shipped** — scheduled maintenance windows (below). |
| On-call › **Pay calculator** | **Out of scope** — on-call compensation calc; not our concern. |
| Response › **Incidents** | **Shipped** — the incident engine + web/Slack management. |
| Response › **Post-incident flow** | **✅ Shipped** — read-only view of the hard-coded checklist (below). |
| Response › **Follow-ups** | **✅ Shipped** — cross-incident action-item view + incident history (below). |
| Response › **Post-mortems** | **Shipped** — auto-draft + edit/publish + Jira export. |
| **Status pages** | Internal page **shipped**; public/branded **out of scope**; Statuspage mirror deferred. |
| **Nexus › Catalog** | **Parked / likely out of scope** — multi-tenant service-catalog tooling. |
| **Insights** | **✅ Shipped** — dashboards on `/api/insights`; also exposed read-only over **MCP** (`POST /mcp`, below). |

Detail on the real gaps:

- **Response teams = linked Slack user groups (NOT a team-management UI).** *Small.* **✅ SHIPPED.**
  Two fixed teams (Engineering, Customer Support) each **link a Slack user group** via a
  config var (`TEAM_ENGINEERING_USERGROUP` / `TEAM_SUPPORT_USERGROUP` — the `S…` usergroup
  ids); membership is managed **in Slack**, resolved on demand via `usergroups.users.list`
  (`src/teams/service.ts`: `resolveTeam`/`resolveTeams`/`isTeamMember`, injectable
  `UsergroupClient` seam). An unconfigured team resolves to an empty roster
  (`configured:false`), a lookup failure is swallowed to empty (best-effort). Read-only
  `GET /api/teams` (session-gated) + a web **Teams** section. No membership CRUD — one
  usergroup id per team. *Replaces incident.io "Teams".*

- **Routing paths: internal vs external incidents.** *Medium — a real capability.* **✅ SHIPPED.**
  Two fixed incident shapes chosen at declare (`routing_path` on `incidents`, migration
  0011; default `internal`). **external** (upstream/partner, e.g. a POS vendor is down):
  we mostly communicate — the roles panel offers **Customer Support Lead only**, no
  Engineering Lead. **internal**: full shape (both roles). Selectable in the Slack
  declare modal, the web declare form, and `POST /api/incidents` (`routing_path`); shown
  as a badge on the incident card. Roles panel gating via `rolesForPath()`. Hard-coded
  set — not a routing-rule builder. (On-call engagement per path + alert-routing hooks
  build on this next.)

- **Alert routing.** *Medium.* **✅ SHIPPED (decision layer).** An inbound alert carries
  a `route` (`internal`|`external`, migration 0012; default internal), and a fixed
  route→action table (`src/oncall/routing.ts`, `decideAlertRoute`) decides what happens:
  **internal** → engage on-call escalation (page); **external** → do NOT page, post a
  comms notice with a Create-incident button to `ONCALL_FALLBACK_CHANNEL` for a human to
  promote. `POST /api/alerts` accepts `route` and calls `routeNewAlert` instead of an
  unconditional `escalateNew` — this is where "external = no on-call page" actually bites
  (on-call is engaged by an alert, never by declaring an incident). Promoting an alert
  carries its `route` → the incident's `routing_path`. Hard-coded, not a rule builder.

  **Killer use case — upstream/partner incidents (Den, 2026-09-03).** **✅ SHIPPED.**
  A **partner status-page monitor** (`src/oncall/partnerMonitor.ts`) polls a configured
  list of upstream status pages (`PARTNER_STATUS_FEEDS` var — Statuspage.io-style
  `…/api/v2/status.json`) on the 1-min cron, throttled to every 5th minute. When a
  partner is not operational it emits a `route:"external"` alert (→ comms notice +
  Create-incident button, **no on-call page**, indicator→severity), dedup'd per partner
  so it fires once; auto-resolves when the partner recovers. Config var, not a
  management UI. Monitor
  **partner/upstream status pages** (many expose a Statuspage.io/Atom/JSON feed or
  webhook). When a watched partner posts an incident, run a fixed workflow: **prompt to
  update our status page** (a component depends on that partner) and/or **prompt to open
  an incident on the external routing path** (Support-Lead-only, no eng page — ties to
  routing paths). This is a distinct alert *source* (a poller/webhook over partner
  status feeds) feeding the routing decision — arguably the highest-value alert-routing
  application for us, since upstream POS/partner outages are exactly the "communicate,
  don't fix" case.

- **Scheduled maintenance.** *Medium.* **✅ SHIPPED.** First-class planned windows
  (`maintenance_windows`, migration 0013) — distinct from incidents (no post-mortem, no
  Slack channel). Schedule via `POST /api/maintenance` / the web "Scheduled maintenance"
  section; a cron reconcile on the 1-min sweep (`reconcileMaintenance`) flips affected
  components to `under_maintenance` when the window starts and back to `operational` when
  it ends (idempotent, cron-driven — no live timer). Cancel restores components.
  Surfaced in `/api/status` + the web section. One fixed window shape, no recurrence builder.

- **On-call roster management (engineering only).** *Small — mostly done.* We already
  have the rotation + overrides (on-call epic). What's needed is the **management
  surface** for the *engineering* roster specifically. **Support is always-on, so it
  needs no roster** — only Engineering has a rotation. Reframe the On-call section
  around the eng roster + overrides; drop any notion of a support rotation.

- **Escalations list.** *Small.* **✅ SHIPPED.** A standing cross-alert log
  (`listEscalationEvents`, `src/oncall/escalationPath.ts`) — every escalation event
  across ALL alerts (firing/acked/resolved), joined to alert title/status/incident,
  newest first. Folded into `GET /api/oncall` as `escalation_events`; rendered as an
  **Escalations** list in the web On-call section. Distinct from the per-alert trail —
  not every incident has one.

- **Escalation-path diagram (read-only, explanatory).** *Small.* **✅ SHIPPED.**
  `buildEscalationPath` (`src/oncall/escalationPath.ts`) derives the fixed ladder purely
  from config as an annotated set of steps (page channel → L0 primary → L1 next +
  `@manager` → L2 `@channel`), each labelled with the real `ONCALL_ACK_TIMEOUT_MIN` wait
  and L2 marked terminal. Folded into `GET /api/oncall` as `path`; rendered as a
  read-only **Escalation path** diagram in the web On-call section (view-only, no Edit —
  the ladder stays hard-coded per stance).

- **Alerts = inbound monitoring + Zendesk webhooks.** *Small–Medium.* **✅ SHIPPED (Zendesk).**
  `POST /api/alerts/zendesk` — a Zendesk trigger webhook POSTs a templated JSON body,
  verified with a shared-secret `X-Signature: sha256=<hex>` (keyed on
  `ZENDESK_WEBHOOK_SECRET`, same scheme as `/api/alerts`; unset = receiver disabled).
  `src/oncall/zendesk.ts` maps the Zendesk-shaped payload → `AlertInput` (priority→severity,
  solved/closed→resolve, `dedup_key=zendesk:<ticket id>`, defaults `route:"external"`) and
  reuses `ingestAlert` + `routeNewAlert` — Zendesk is one adapter behind the same pipeline,
  the alert model is unchanged. Setup docs (which trigger, webhook, URL, secret, JSON
  template) in `docs/DEPLOY.md`. No IMAP/SMTP, no mailbox polling.

- **Follow-ups (first-class) + historical incidents.** *Medium.* **✅ SHIPPED.**
  `GET /api/followups?open=` — cross-incident action items joined to their incident +
  post-mortem (open/done, owner, Jira key); `GET /api/history?severity=&routing_path=`
  — browsable past incidents (newest first, with has-postmortem + open-action counts +
  filters). Web **Follow-ups & history** section: an outstanding/all follow-ups list and
  a filterable incident-history list. `src/reporting/followups.ts`, read-only over
  existing tables — no migration.

- **Post-incident flow (surface the fixed checklist).** *Small.* **✅ SHIPPED.**
  `buildPostIncidentFlow` (`src/postmortem/postIncidentFlow.ts`) derives the FIXED
  checklist per incident from existing data — no builder, no new table, no writes:
  resolved → post-mortem drafted → action items captured → action items filed (n/a when
  none) → post-mortem published. Read-only `GET /api/incidents/:id/post-incident-flow`
  (session-gated) + a **Post-incident flow** checklist in the web incident card.

- **Insights = dashboards.** *Medium — "definitely useful".* **✅ SHIPPED.**
  `GET /api/insights?period=` (`src/reporting/insights.ts` — `buildInsights`) aggregates
  over the recorded data: volume **by severity**, **by routing path**, a **monthly
  opened/resolved trend**, MTTR per bucket + overall, and the open action-item backlog.
  Web **Insights section** (`InsightsSection`) renders it with monochrome bar charts +
  a period selector (30d/90d/all) — no chart lib, matches the borderless stance. Builds
  on the reporting metrics.

- **MCP connector for Claude (analytics-first).** *Medium — Den, 2026-09-03.* **✅ SHIPPED.**
  MCP-over-HTTP at **`POST /mcp`** (`src/mcp/server.ts`) — a minimal, self-contained
  JSON-RPC 2.0 handler for the core MCP methods (`initialize` / `tools/list` /
  `tools/call`, plus `ping` + `notifications/initialized`), no SDK dependency
  (single-tenant, opinionated). Bearer-token auth via `MCP_TOKEN` (unset = disabled).
  Four **read-only analytics** tools, thin wrappers over the existing reporting layer:
  `get_report` (metrics over a period), `get_insights` (severity/path/monthly-trend +
  MTTR breakdowns), `list_follow_ups` (cross-incident action items), `list_incidents`
  (history with severity/path filters). This is where an LLM adds the most value —
  cross-incident pattern mining over recorded data. Live-response tools
  (declare/update from Claude) remain a deliberate, secondary later addition.

- **Conversational control — @-mention the bot in-channel (Den, 2026-09-03).** *Medium.* **✅ SHIPPED.**
  `@Incident Management <instruction>` in a mapped incident channel is classified to an
  intent (`src/incidents/intent.ts`: OpenAI JSON-mode classifier + a deterministic
  rule-based fallback/fake) and dispatched via `applyIntent` through the SHARED command
  functions — a THIRD surface alongside slash commands + the button panel. Handles:
  **update** ("update please"), **status** ("set status to identified"), **severity**
  ("this is sev1"), **escalate** ("escalate to @alice"), **summarize** ("what's the
  summary?" → new on-demand DO `summarize` command), **resolve** (→ joint-resolve). An
  unrecognised mention gets a help reply; unmapped channels are ignored. The
  `app_mention` plumbing already existed; this added the intent→action step.

- **Catalog / Pay calculator — NOT useful for us.** Den: "not sure the catalog is
  useful." incident.io's service/ownership **Catalog** (under "Nexus") is
  multi-tenant/large-org tooling; our fixed component list already covers it. The
  **Pay calculator** (on-call compensation) is likewise out of scope. **Parked** unless
  a concrete need appears.

## Next (capability gaps — real functionality, not config)

Ordered roughly by value/effort. Each non-trivial item gets its own mini-spec.

- **Status-page prompt (severity-gated, coupled to StatuspageSink).** *Small, but
  DEFERRED until StatuspageSink is real.* Internal AI summaries stay **automatic** —
  a wrong internal note is cheaply corrected, so no gate there (decided). The only
  place a human 👍 is warranted is the **outbound-to-customers** hop: when a
  qualifying (e.g. ≥ Major) update would mirror to Statuspage.io, prompt "post this
  to the status page?" first. This is the "one hard-coded workflow" — it *is* this
  prompt, not a separate concept — and it can't be built until the StatuspageSink
  exists (see Later) and severity is modelled.

- **Incident action buttons in Slack (slash commands optional).** *Medium.* **✅ SHIPPED.**
  Every incident action is now a **button on the incident-controls panel** the bot posts
  to the channel on declare (alongside the roles panel): **Post update**, **Change status**,
  **Escalate**, **Change severity** (each opens a `views.open` modal), and **Request resolve**
  (the two-person joint-resolve flow). All route through the shared `postIncidentUpdate` /
  `setSeverity` / `requestResolve` / escalate functions via `/slack/interactivity`
  (`block_actions` + `view_submission`), so Slack buttons, slash commands, and web all drive
  one path. Slash commands remain as an optional power-user path. One fixed button set — not
  a configurable action builder. (`src/incidents/controls.ts`.)

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

## On-call *(shipped — see Shipped above)*

The one large epic is **complete**: rotation, HTTP alert ingestion, the three-level
escalation ladder (cron-driven), Slack + optional Twilio notifiers with phone ack, the
alert→incident bridge, and the web On-call section all landed. Design and the resolved
decisions live in [`docs/SPEC_ONCALL.md`](docs/SPEC_ONCALL.md); the runtime overview is
ARCHITECTURE §13. Nothing here is a config surface — one rotation shape, one escalation
shape, one alert source, all hard-coded per the product stance above.

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
