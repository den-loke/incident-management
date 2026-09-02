# Roadmap

The source-of-truth roadmap for the incident-management tool (not just tickets).
Ordered roughly by sequence, not priority. Architecture rationale lives in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Shipped
- ✅ **Incident engine** — declare / update / resolve via Slack; one Durable Object
  per incident; 15-min alarm → OpenAI summary → progress-update loop.
- ✅ **Resolve-from-Slack** wiring.
- ✅ **Web UI (read-only)** — Slack OIDC auth (`team_id` allow-list, signed-cookie
  session) + React/ShadCN status page rendering components + incident timeline from
  D1 via `GET /api/status`. Two-env deploy config (`test` / `production`).

## Next
- **Web-based incident management.** Write actions from the dashboard — declare,
  post update, resolve, edit component status — via `POST /api/incidents*` endpoints
  that call the **same Incident DO command API** Slack already drives, so Slack and
  web stay in sync with no duplicated logic. Turns the read-only page into the
  fuller dashboard.

## Post-mortems  *(needs its own mini-spec before build)*
- **Goal:** every resolved incident gets a structured post-mortem / incident review.
- **Auto-draft:** on resolve, use OpenAI over the incident's Slack channel + the D1
  update timeline to draft summary, timeline (already captured), impact, root cause,
  contributing factors, and action items. Fits the existing "agentic summarization"
  theme and reuses data we already store.
- **Human-in-the-loop:** the draft is editable (web UI) before finalized — never
  auto-published as fact.
- **Storage:** new D1 tables (e.g. `postmortems`, `postmortem_action_items`), linked
  to `incidents`. Append-only history where sensible.
- **Surface:** rendered in the web UI on the incident; exportable.
- **Open questions to resolve first:** exact field set; whether action items get
  their own tracking/assignees; does it publish anywhere (Slack canvas, Statuspage
  post-incident note); retention.

## Reporting  *(needs its own mini-spec before build)*
- **Goal:** aggregate views across incidents, not just per-incident.
- **Metrics:** incident count over time, MTTA / MTTR (from status transitions +
  timestamps we already record), incidents per component, frequency/severity trends,
  open action-item backlog.
- **Surface:** a reporting view in the web UI (period filter) + likely a
  `GET /api/reports` JSON endpoint feeding it. Export (CSV / Markdown / PDF).
- **Cadence:** consider a scheduled digest (weekly/monthly) — a Cloudflare cron
  trigger summarizing the period; delivery target TBD (Slack post / email).
- **Open questions to resolve first:** which metrics matter most day-one; report
  period defaults; export formats; whether the scheduled digest is in scope now.

## Later (deferred)
- **StatuspageSink** real implementation (currently a stub) + Statuspage
  outbound-webhook subscription (consume component/incident events back).
- **Recall.ai** call transcription (Zoom / Meet / Teams / Webex) behind the abstraction.
- **Custom domains** per environment (code already origin-relative; DNS only).
- **Status-page fixtures:** dev-only `?fixture=<name>` preview route rendering
  hardcoded states (all-operational, degraded, partial/major outage, each incident
  lifecycle phase, maintenance) + `scripts/shoot-states.ts` driving `wrangler dev`
  with Playwright to save `screenshots/<state>.png`. Lightweight — not Storybook.
