# Incident Management — Architecture

Slack-first incident management tool. Drives status pages, listens to incident
Slack channels, transcribes calls, and posts automated progress updates.
Modeled loosely on incident.io, but deliberately narrow: we do **not** build our
own status-page product (we mirror to statuspage.io), and we ship only the
integrations we need, starting with the essentials.

**Status:** architecture decided (2026-09-02). Not yet implemented.

---

## 1. Guiding constraints

1. **Reliability first.** The tool must work when we depend on it — during a real
   incident, unattended. Scheduled steps ("post a progress update every 15 min")
   must fire reliably with no human present.
2. **No servers to manage.** Serverless only.
3. **Start minimal, grow over time.** Essentials now: **Statuspage + Slack**.
   Recall.ai and richer integrations layer in later behind clean abstractions.
4. **End-to-end testable.** We can run a fully faked incident to resolution
   deterministically, in CI, with no real external infrastructure and no waiting
   on wall-clock timers.
5. **Single-tenant per installation.** One deployment == one Slack workspace ==
   one Statuspage page.

---

## 2. Platform: Cloudflare-native

An incident is a **long-lived (minutes → days), stateful, event-driven process
with its own timers**. Every integration independently demands durable,
serialized, retryable, timer-driven execution. That is exactly the shape of
Cloudflare's durable primitives, and exactly what Vercel's request-scoped
function model fights (you would bolt on Inngest/Trigger.dev + an external store —
more vendors, weaker guarantees).

| Concern | Primitive | Why |
|---|---|---|
| Inbound webhooks (Slack / Statuspage / Recall) | **Worker** (HTTP) | Verify signature, ack `200` in < 3s, hand off. Public HTTPS endpoint, no socket to hold. |
| Per-incident state + logic | **Durable Object** (one per incident) | Single-threaded actor ⇒ serialized writes; holds incident state; owns the timers. Hibernates when idle. |
| "Every 15 min" progress update | **DO Alarms** | Per-incident timer, survives restarts, at-least-once, fires unattended. |
| Retry-heavy multi-step flows | **Workflows** | Durable steps w/ built-in retry + sleep. Recall `507`×10, Statuspage `429` backoff, incident close-out. |
| Incident data / audit log / internal status | **D1** (SQLite) | Incidents, updates, components, transcripts, event log. |
| Agentic summarization | **OpenAI** via `fetch` | Called from DO/Workflow to derive updates from Slack context. |
| Transcript-event buffering | **Queues** (optional) | Absorb Recall real-time bursts, feed the DO. |
| Dashboard auth | **Sign in with Slack (OIDC)** | See §7. |

**Mental model: one Durable Object *is* one incident.** The front Worker routes
Slack messages, reactions, and transcript chunks to the incident's DO. The DO
owns a 15-min alarm; on each tick it pulls recent Slack context, calls OpenAI to
draft an update, and writes status through the StatusSink (§6). On resolution the
DO cancels its alarm and goes idle.

> Runtime is Cloudflare Workers (`workerd`), TypeScript. Note this is **not** the
> Bun runtime — production code runs on `workerd`. Use `nodejs_compat` where a
> Node built-in is genuinely required.

---

## 3. Tenancy — single Slack workspace per installation

- The Slack workspace id is a **config constant**, not data: `SLACK_TEAM_ID` env var.
- Bot token, signing secret, `team_id`, and the (optional) Statuspage token are
  all **per-deployment env vars**.
- No multi-tenant user tables, no tenant column in D1 — incidents are implicitly
  scoped to the one workspace.

---

## 4. Slack integration

### Inbound — HTTP Events API (NOT Socket Mode)
- Socket Mode needs a persistent WebSocket (a long-lived process) and is
  incompatible with serverless. We use the **HTTP Events API**: Slack POSTs each
  event to our Worker.
- **Verify the request signature** (`v0:{timestamp}:{raw_body}` →
  `v0=HMAC_SHA256(signing_secret, basestring)`) using **Web Crypto**
  (`crypto.subtle`, HMAC-SHA256 — first-class on Workers, zero deps).
- **Ack `200` within 3 seconds**, then process asynchronously (hand to the DO /
  Queue). Slack retries failed deliveries for us — a reliability *gain* over
  Socket Mode's DIY reconnect.

### Outbound — Web API (HTTPS)
- `chat.postMessage`, `conversations.create` (per-incident channel),
  `conversations.invite`, `reactions.*`, etc. Plain HTTPS from the Worker/DO.

### Local dev
- **`cloudflared` tunnel → live HTTP events into the local Worker.** Same
  transport as production, no divergent code path.
- (Socket Mode via a thin Node dev-harness is possible but rejected as the
  default: it introduces a prod/dev behaviour split.)

---

## 5. Status model — components 1:1 with Statuspage

The internal status model mirrors Statuspage's shape exactly, so the internal
page and the Statuspage mirror never drift and `StatuspageSink` is a trivial
translation.

- **Components** (e.g. `API`, `Dashboard`, `Webhooks`), each carrying a status:
  `operational` · `degraded_performance` · `partial_outage` · `major_outage` ·
  `under_maintenance`.
- **Incident lifecycle:** `investigating → identified → monitoring → resolved`.
- **Incident updates:** an append-only timeline (body + status + timestamp),
  matching how Statuspage appends `incident_updates`.

---

## 6. StatusSink abstraction — internal page always on, Statuspage optional mirror

The incident engine (DO) **never calls Statuspage directly.** It calls an internal
`StatusSink` and is unaware of fan-out.

```
DO ──sink.applyIncidentUpdate(...)──▶ MultiSink
                                        ├── InternalStatusSink   (D1)         ALWAYS
                                        └── StatuspageSink        (statuspage.io) IFF STATUSPAGE_API_KEY set
```

- **`InternalStatusSink`** — writes components + incident updates to D1. Always
  active, in dev **and** prod. It is the **source of truth**; the web UI renders
  from it. There is no mode where the internal page goes dark.
- **`StatuspageSink`** — pushes to statuspage.io. Constructed **only when
  `STATUSPAGE_API_KEY` (+ `STATUSPAGE_PAGE_ID`) is present.** Absent ⇒ internal-only
  (dev, testing, or an un-configured workspace).
- **Statuspage is a fan-out target, not a replacement.** Every transition writes
  internal, and *additionally* mirrors to Statuspage when the token exists.

### Statuspage reliability, isolated in `StatuspageSink`
- Auth header: `Authorization: OAuth <STATUSPAGE_API_KEY>` (it is an API key,
  despite the `OAuth` keyword).
- **Rate limit: 1 request/second** (60/min rolling), returns `420`/`429` on
  breach. Writes are **serialized and backed off inside the sink** — because the
  per-incident DO is single-threaded, natural serialization already helps; the
  sink adds throttle + backoff. No other component knows or cares.
- Statuspage's own outbound webhooks (2xx within 30s) are handled by the front
  Worker if/when we subscribe.

---

## 7. Auth — Sign in with Slack (OIDC), single-workspace allow-list

- **Login = "Sign in with Slack" (OpenID Connect / OAuth 2.0).** JSON + JWT over
  HTTPS — no XML-DSig, no RSA-SHA1, no `xml-crypto`. None of the SAML crypto pain,
  on any platform.
- On callback, **verify `team_id === SLACK_TEAM_ID`** — reject anyone outside our
  workspace. Membership in the workspace *is* the authorization gate.
- We get the Slack **`user_id` natively**, so dashboard identity == the identity
  we act as in Slack (no separate identity → Slack-user mapping to maintain — the
  reason this beats Google SSO for a Slack-first tool).
- Auth applies to **dashboard/web-UI routes only**. Webhook routes authenticate
  independently by HMAC signature (Slack) / API token (Recall) and never touch
  OIDC.
- `AUTH_MODE=bypass` (E2E deployment + test runner) stubs a Slack session with a
  fake user in the configured `team_id`. See §9.

> Cloudflare Access (Google Workspace SSO, free ≤ 50 seats) was evaluated and is a
> valid zero-code alternative; it can be added later as an *outer* edge layer, but
> Slack OIDC is the primary login for product-fit reasons above.

---

## 8. Recall.ai (call transcription) — deferred, behind an abstraction

Not in the day-one essentials, but the design accounts for it.

- Create scheduled bots (`join_at` ≥ 10 min ahead). Retry `507` every 30s up to
  10× (isolated in a Workflow).
- Region-specific base URL (`https://{region}.recall.ai/...`). Auth:
  `Authorization: <RECALLAI_API_KEY>`.
- Consume webhooks async (Svix; 2xx within 15s) via the front Worker → Queue → DO.
  Real-time `transcript.data` events feed the incident DO's OpenAI summarization.
- ✅ **DECIDED: Slack huddles are out of scope.** Recall's Slack-huddle bot
  support is unconfirmed/hard (the bot-platform table omits it; SDK capture is
  macOS-only / audio-only). Supported call platforms are **Zoom / Google Meet /
  Microsoft Teams / Webex** (all solid in Recall's bot table).

---

## 9. End-to-end testing — deterministic fake incident

The strongest argument for the Cloudflare choice: a DO owns its own clock via
Alarms, and the Workers test runner (`vitest-pool-workers` / Miniflare) lets us
**advance DO alarms manually** — so we drive a full incident to resolution with
**no waiting**.

- **Inbound Slack** → **forge signed Events API payloads**: set `SLACK_SIGNING_SECRET`
  to a known test value and POST byte-identical signed webhooks. The Worker's
  real verify → ack → dispatch path runs exactly as in production. No test
  workspace required.
- **Scripted conversation** → a hardcoded sequence of message/reaction events
  replayed as fixtures.
- **Outbound integrations faked** → assert on the internal sink (query D1, no
  network) for the default path; swap in a **fake `StatuspageSink`** pointing at a
  local mock to assert the exact Statuspage PATCH bodies. Recall/OpenAI similarly
  mocked / recorded.
- **Time-based behaviour** → don't wait: **advance the DO alarm in-test** and
  assert the 15-min progress update fired.
- **OpenAI determinism** → recorded/seeded responses so assertions are stable.
- **Auth** → `AUTH_MODE=bypass` stubs the Slack session (see §7).

**One test run:** forge signed Slack events → assert incident channel created +
internal status incident opened → advance alarm → assert progress update posted &
component status changed → forge resolve → assert incident resolved. All
in-process, all deterministic. A real test Slack workspace is a *secondary* smoke
test, not the backbone.

---

## 10. Configuration (per-deployment env vars)

| Var | Purpose | Required |
|---|---|---|
| `SLACK_TEAM_ID` | The one workspace this install serves (auth allow-list) | ✅ |
| `SLACK_BOT_TOKEN` | Outbound Web API calls | ✅ |
| `SLACK_SIGNING_SECRET` | Verify inbound Events API signatures | ✅ |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Sign in with Slack (OIDC) | ✅ |
| `OPENAI_API_KEY` | Agentic summarization | ✅ |
| `OPENAI_MODEL` | OpenAI model for summaries + post-mortem drafts (**var**, not secret; default `gpt-4o-mini` when unset) | ⬜ (default) |
| `STATUSPAGE_API_KEY` | Enables the Statuspage mirror sink | ⬜ optional |
| `STATUSPAGE_PAGE_ID` | Target Statuspage page | ⬜ (with key) |
| `RECALLAI_API_KEY` + region | Call transcription (later) | ⬜ optional |
| `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` / `JIRA_PROJECT_KEY` | Post-mortem action-item export to Jira | ⬜ optional |
| `ONCALL_TZ` | Rotation changeover timezone (default `Australia/Melbourne`) | ⬜ (default) |
| `ONCALL_ROTATION_DAYS` | Shift length in days (default 7 = weekly) | ⬜ (default) |
| `ONCALL_ACK_TIMEOUT_MIN` | Minutes before escalating a level (default 10) | ⬜ (default) |
| `ONCALL_MANAGER` | Slack user id — level-1 backstop mention | ⬜ optional |
| `ONCALL_FALLBACK_CHANNEL` | Slack channel id to page when nobody is on call | ⬜ optional |
| `ONCALL_ALERT_SECRET` | HMAC secret for `POST /api/alerts` | ⬜ (for alerts) |
| `ONCALL_TWILIO_ACCOUNT_SID` / `ONCALL_TWILIO_AUTH_TOKEN` / `ONCALL_TWILIO_FROM` | Twilio SMS/voice paging (unset = disabled; token also validates inbound Twilio webhooks) | ⬜ optional |
| `ONCALL_CHANNEL_POLICY` | Override the L0/L1/L2 notifier channel policy | ⬜ optional |
| `PARTNER_STATUS_FEEDS` | JSON `[{id,name,url}]` of upstream status pages to monitor (Statuspage `…/api/v2/status.json`); unset = disabled | ⬜ optional |
| `ZENDESK_WEBHOOK_SECRET` | HMAC secret for `POST /api/alerts/zendesk` (Zendesk trigger webhook); unset = receiver disabled | ⬜ optional |
| `TEAM_ENGINEERING_USERGROUP` / `TEAM_SUPPORT_USERGROUP` | Slack usergroup ids linked as the Engineering / Customer Support response teams; membership managed in Slack, resolved via `usergroups.users.list`; unset = that team unconfigured | ⬜ optional |
| `MCP_TOKEN` | Bearer token for the read-only MCP analytics connector at `POST /mcp`; unset = connector disabled | ⬜ optional |
| `AUTH_MODE` | `bypass` for E2E; unset/`slack` in prod | ⬜ (E2E only) |

---

## 11. Decided vs open

**Decided (2026-09-02):**
- Platform: Cloudflare-native (Workers, DO + Alarms, Workflows, D1, Queues).
- Single Slack workspace per installation.
- Slack HTTP Events API in (HMAC/Web Crypto), Web API out, `cloudflared` tunnel for local dev.
- One Durable Object per incident, owns the 15-min alarm.
- StatusSink abstraction: internal D1 page always on (source of truth) + optional Statuspage mirror gated on token.
- Status model: components 1:1 with Statuspage.
- Auth: Sign in with Slack (OIDC), `team_id` allow-list; `AUTH_MODE=bypass` for E2E.
- E2E: forge signed Slack webhooks + advance DO alarms → deterministic fake incident.
- **Call platform: Zoom / Google Meet / Teams / Webex** (Slack huddles dropped — too hard / unconfirmed).
- **Dashboard scope: Slack-first.** Day-one web UI is the read-only internal status page (components + incident timeline from D1); all incident operations (declare / update / resolve) run through Slack. A fuller dashboard is deferred.

**Open (do not block spec, resolve before/within implementation):**
- Statuspage outbound-webhook subscription (consume component/incident events back) — later.
- **When building the status-page UI:** add fixture-driven example states (a dev-only `?fixture=<name>` / preview route rendering hardcoded states — all-operational, degraded, partial/major outage, each incident lifecycle phase, maintenance) plus a `scripts/shoot-states.ts` that drives `wrangler dev` with Playwright to save `screenshots/<state>.png` for each. Lightweight manual tooling — NOT Storybook (read-only server-rendered page needs named data fixtures + a URL per state, not component-isolation). Uses the browser-recording / web-verify tooling.

---

## 12. Roadmap

The living roadmap (shipped / next / post-mortems / reporting / deferred) lives in
[`ROADMAP.md`](../ROADMAP.md) at the repo root.

---

## 13. On-call (rotation, escalation, alerting)

The one large pillar hard-coding does not shrink much — even a single team needs a
real rotation, escalation, and a way for monitoring to reach a human. Kept minimal
and opinionated (one rotation shape, one escalation shape, one alert source); full
design and decisions in [`SPEC_ONCALL.md`](SPEC_ONCALL.md). **Shipped**, in slices:

- **Rotation** — weekly hand-off, changeover Monday 10:00 `ONCALL_TZ` (round-robin over
  `oncall_responders`). A daily cron materialises shifts ~4 weeks ahead
  (`generateShifts`, idempotent); overrides are `is_override=1` rows that win over the
  base. "On call at T" is a single indexed read (`whoIsOnCall`).
- **Alert ingestion** — `POST /api/alerts` (HMAC via `ONCALL_ALERT_SECRET`), generic
  `{title, body?, severity?, dedup_key?, status?}`; dedup-by-key folds flaps, and
  `status:"resolved"` auto-closes matching open alerts.
- **Escalation ladder** — three levels (L0 primary → L1 next responder + `@ONCALL_MANAGER`
  → L2 `@channel` broadcast, terminal), each firing only if the prior went unacked for
  `ONCALL_ACK_TIMEOUT_MIN`. Timeout firing is **cron-driven** (`sweepEscalations`, ~1-min
  cron), never a live timer — it survives restarts. Any allow-listed user acks; ack stops
  the ladder.
- **Notifiers** — Slack always on; **Twilio** SMS/voice optional behind a `Notifier`
  abstraction, config-gated on `ONCALL_TWILIO_*` (like `StatusSink`). Per-level channel
  policy (L0 Slack+SMS, L1 +voice, L2 Slack-only; `ONCALL_CHANNEL_POLICY`-overridable).
  Phone ack — SMS `Y`/`ACK`, voice press-1 — arrives at `POST /api/twilio/{sms,voice}`
  (validated with `X-Twilio-Signature`) and resolves to the same `oncall_ack` path as the
  Slack button.
- **Alert → incident bridge** — a **Create incident** button (Slack + web) promotes an
  alert via the existing `declareIncident` path and links it back, posting the incident
  channel link into the alert's paging channel. `/incident escalate <@user>` pages a
  specific person out-of-band. Never automatic (avoids an alert storm minting incidents).
- **Web On-call section** — `GET /api/oncall` + a status-page section mirroring who's on
  now/next, the rotation, and open alerts with their escalation trail, plus Ack /
  Create-incident / Override buttons that hit the same functions as Slack.

Cron triggers (`wrangler.jsonc`): a daily shift-gen (`0 0 * * *`) and a ~1-min escalation
sweep (`* * * * *`), declared at the top level **and** in each named env (named envs don't
inherit). All `ONCALL_*` config is optional with sensible defaults (see §10).
