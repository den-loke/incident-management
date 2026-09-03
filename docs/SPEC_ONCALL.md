# Spec: On-call (rotation, escalation, alert ingestion)

Status: **Decisions resolved (§10) — building slice 1.** This is the one large roadmap epic that hard-coding
does not shrink much: even a single team needs a real rotation, an escalation path,
and a way for monitoring to reach a human. Everything below stays **minimal and
opinionated** — one rotation shape, one escalation shape, one alert source — never a
config surface.

## 0. Guiding constraints (inherited)
- **Single-tenant.** One team, one Slack workspace. No org/team/tenant tables. The
  "team" is implicit — every responder is a member of the one workspace allow-list.
- **Serverless.** Cloudflare Workers + D1 + Durable Objects, same as the incident
  engine. No always-on process; time-driven work runs on a **Cron Trigger**, not a
  long-lived timer.
- **Slack-first.** Every human touchpoint has a Slack surface; the web UI mirrors it.
- **Reuse what exists.** `incident_channels`, `incident_roles`, the `/slack/events`
  router, the `/slack/interactivity` `block_actions` handler, the `SlackClient`
  (`postMessage`/`postBlocks`), and the `openIncident` path. On-call *feeds* the
  incident engine; it does not fork it.

Out of scope: paid paging vendors (PagerDuty/Opsgenie), SMS/voice/phone paging,
multi-team routing, per-service ownership graphs, configurable escalation builders.

---

## 1. Data model (migration `0008_oncall.sql`)

Four tables. All timestamps are the repo's ISO-8601 `strftime(...'now')` default.

### `oncall_responders`
The pool of people who can be on call. Seeded from the Slack allow-list; a person is
eligible only if `active = 1`.
```
id          TEXT PRIMARY KEY          -- Slack user id (U...)
name        TEXT NOT NULL
active      INTEGER NOT NULL DEFAULT 1
sort_order  INTEGER NOT NULL DEFAULT 0  -- rotation order
```

### `oncall_shifts`
The materialised rotation — one row per shift window. Generated ahead by the cron so
"who is on call now/next" is a single indexed read, and manual overrides are just rows
with `is_override = 1`.
```
id          TEXT PRIMARY KEY
responder   TEXT NOT NULL REFERENCES oncall_responders(id)
starts_at   TEXT NOT NULL
ends_at     TEXT NOT NULL
is_override INTEGER NOT NULL DEFAULT 0
created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
```
Index: `(starts_at, ends_at)`. "On call at T" = the override covering T if any, else
the base shift covering T.

### `oncall_alerts`
Every inbound alert, append-only (mirrors how `incident_updates` is append-only).
```
id           TEXT PRIMARY KEY
source       TEXT NOT NULL            -- 'http' for now
dedup_key    TEXT                     -- caller-supplied; groups flaps
title        TEXT NOT NULL
body         TEXT
severity     TEXT                     -- optional hint, maps to incident severity
status       TEXT NOT NULL DEFAULT 'firing'
             CHECK (status IN ('firing','ack','resolved'))
incident_id  TEXT REFERENCES incidents(id)   -- set if promoted
received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
```
Index: `(dedup_key, status)` for grouping; `(status, received_at)` for the open list.

### `oncall_escalations`
Append-only audit of each escalation hop (who was paged, when, and why the next hop
fired). Also the source of truth for "has this been acked".
```
id         TEXT PRIMARY KEY
alert_id   TEXT NOT NULL REFERENCES oncall_alerts(id)
level      INTEGER NOT NULL         -- 0 primary, 1 next-responder+manager, 2 channel broadcast (terminal)
target     TEXT NOT NULL            -- Slack user id paged; channel id at level 2
fired_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
acked_at   TEXT
acked_by   TEXT
```

---

## 2. Rotation (one shape)

- **Weekly hand-off**, changeover **Monday 10:00** in a hard-coded `ONCALL_TZ`
  (env, default `Australia/Melbourne`). Round-robin over `oncall_responders` ordered
  by `sort_order` then `id`.
- **Generation**: a daily **Cron Trigger** (`wrangler.jsonc` `[triggers] crons`) calls
  a `generateShifts()` service that ensures shifts exist ~4 weeks ahead. Idempotent —
  it only inserts windows that don't already exist, so re-runs are safe (same
  `INSERT OR IGNORE` discipline the tests rely on).
- **Override**: `setOverride(responder, starts_at, ends_at)` inserts an
  `is_override = 1` row. `whoIsOnCall(at)` prefers an override covering `at`.
- **No holiday feed** in v1 (ROADMAP lists it optional/later). Overrides cover the
  "I'm out" case by hand.

Escalation must **not deadlock on an empty rotation**: if `whoIsOnCall` returns nobody
(no responders configured), alerts still post to the incident channel / a fallback
`ONCALL_FALLBACK_CHANNEL`, and escalation is skipped rather than erroring — mirrors the
"never hard-require a claimed role" rule from joint-resolve.

---

## 3. Escalation path (one opinionated shape)

Hard-coded three-level ladder, no builder. Each level fires only if the previous went
unacked for `ONCALL_ACK_TIMEOUT_MIN` (env, default 10):

1. **Level 0 — primary on-call.** Slack DM + a mention in the alerts channel to
   `whoIsOnCall(now)`. Message carries **Ack** and **Create incident** buttons.
2. **Level 1 — second line.** Page the **next responder in rotation order** (round-robin
   over *available* on-callers) **and** `@`-mention `ONCALL_MANAGER` (env, Slack user id).
   The manager is a **visibility** ping (leadership knows a page went unacked); the next
   responder is the working backstop. Manager id lives in env, **not** in
   `oncall_responders`, so the backstop is always a distinct person and the rotation can
   never land on the manager as primary.
3. **Level 2 — broadcast.** If level 1 is *also* unacked after another timeout, broadcast
   to the whole alerts channel (`@channel`) — last resort, everyone sees it. Nobody
   specific is targeted; the first allow-listed user to **Ack** stops the ladder.

Timeout firing is **cron-driven**, not a live timer: a frequent Cron Trigger
(every 1–2 min) runs `sweepEscalations()` → for each `firing` alert whose newest
`oncall_escalations` row is unacked and older than the timeout, fire the next level and
append a row. This is the DO/cron equivalent of a setTimeout and survives restarts.
Level 2 is terminal — once broadcast, the sweep stops escalating that alert (it stays
`firing` until acked/resolved, but no further pages fire).

**Ack** (`block_actions` action `oncall_ack:<alert_id>`): set the escalation row's
`acked_at/acked_by`, set the alert `status = 'ack'`, stop the ladder, post confirmation.
Only constraint: any allow-listed user may ack (same "confirmer needn't hold a role"
philosophy). This is why the level-2 broadcast works — whoever picks it up can ack.

For the level-2 broadcast, `oncall_escalations.target` is stored as the channel id (not
a user), and `level = 2`; the sweep treats a `level = 2` row as terminal.

---

## 4. Alert ingestion (HTTP source only)

- **Endpoint**: `POST /api/alerts` (public but **HMAC-verified** with
  `ONCALL_ALERT_SECRET` — `X-Signature: sha256=<hex>` over the raw body, same scheme
  as Slack signing). Datadog/Grafana/Prometheus Alertmanager all support a custom
  webhook with a shared secret + templated JSON body, so one generic shape covers them.
- **Payload** (minimal, generic): `{ title, body?, severity?, dedup_key?, status? }`.
  `status: "resolved"` from the source closes the matching `firing` alert(s) by
  `dedup_key` (auto-resolve on recovery).
- **Dedup / grouping**: incoming `firing` with a `dedup_key` that already has an open
  alert is folded into it (bump a count / append to body) instead of re-paging — simple
  time+key grouping, no fancy correlation.
- **Optional AI attribute extraction** (deferred, behind the existing `Summarizer`
  abstraction): later, derive a cleaner title/severity from a noisy payload. Not v1.

---

## 5. Alert → incident bridge

The whole point: turn a page into the existing incident flow.

- **From the Slack alert message**: a **Create incident** button
  (`oncall_create_incident:<alert_id>`) calls the existing `declareIncident(...)`,
  passing the alert title as the name and the alert `severity` hint through the new
  severity field (default `sev2`). Links `oncall_alerts.incident_id`, posts the incident
  channel link back into the alert thread.
- **`/inc escalate <@user|team>`** slash sub-command (router addition): pages a
  specific person out-of-band with a message — for "I need more hands on the incident
  I'm already running". Reuses `SlackClient.postMessage` + a DM.
- Auto-promote is **opt-in per alert** (button), **not** automatic — avoids an alert
  storm minting incidents. (Revisit if noise proves otherwise.)

---

## 6. Web UI (mirror, monochrome, no side borders)

New **On-call** section on the status page (or a tab):
- **Who's on call now / next** (name + shift window).
- **This week's rotation** list; an **Override** action (pick responder + window).
- **Open alerts** list with status badge (firing/ack/resolved), each showing its
  escalation trail; **Ack** and **Create incident** buttons that hit the same endpoints
  as the Slack buttons.
Follows the established vanilla black-and-white ShadCN styling; **no side borders**.

---

## 7. Env / config additions (`docs/ARCHITECTURE.md` §10)
```
ONCALL_TZ                 default Australia/Melbourne
ONCALL_ROTATION_DAYS      default 7 (weekly)
ONCALL_ACK_TIMEOUT_MIN    default 10
ONCALL_MANAGER            Slack user id (level-1 backstop)
ONCALL_FALLBACK_CHANNEL   Slack channel id if nobody is on call
ONCALL_ALERT_SECRET       HMAC secret for POST /api/alerts
```
`wrangler.jsonc`: add `[triggers] crons` (daily shift-gen + ~1-min escalation sweep) to
**top level and both named envs** (named envs don't inherit — same gotcha already fixed
for `durable_objects`/`assets`/`migrations`).

---

## 8. Testing (vitest-pool-workers, shared D1)
Per the established discipline: **unique per-file ids**, `INSERT OR IGNORE`, scoped
`DELETE ... WHERE id=` cleanup (no blanket deletes). Drive cron/sweep logic **in-isolate**
via the service functions (waitUntil D1 writes under `SELF` aren't reliably visible).
Cases:
- `whoIsOnCall` picks the covering base shift; an override wins over the base.
- `generateShifts` is idempotent (re-run inserts nothing new).
- `POST /api/alerts` rejects a bad HMAC (401), accepts a good one (201), dedups a repeat
  `firing` by `dedup_key`, auto-resolves on `status:"resolved"`.
- `sweepEscalations` fires level 1 only after the timeout and only when unacked; then
  level 2 (`@channel` broadcast) after a second timeout; ack at any level stops the
  ladder; level 2 is terminal (no further pages fire).
- Empty rotation → alert still lands in the fallback channel, no error.
- **Create incident** button promotes an alert: `declareIncident` called, severity hint
  threaded, `incident_id` linked.

## 9. Build order (PR slices)
1. `0008` migration + `whoIsOnCall`/`generateShifts` service + shift-gen cron + rotation tests.
2. `POST /api/alerts` (HMAC) + dedup/auto-resolve + alerts tests.
3. Escalation ladder + `sweepEscalations` cron + Slack ack/page buttons + tests.
4. Alert→incident button + `/inc escalate` + bridge tests.
5. Web On-call section (rotation + open alerts + override/ack/create buttons).
6. `docs/ARCHITECTURE.md` + `ROADMAP.md` updates; move on-call to Shipped.

## 10. Decisions (resolved — this is the contract slice 1 builds against)
- **Changeover** — **Monday 10:00 `Australia/Melbourne`** (`ONCALL_TZ` env-overridable).
  Mid-morning Monday so a hand-off never lands after-hours or on a weekend; the
  outgoing responder is present to brief the incoming one.
- **Rotation length** — **weekly**. A single constant (`ONCALL_ROTATION_DAYS`, default
  7); daily/bi-weekly is a one-line change.
- **Escalation ladder** — **three levels**: (0) primary on-call → (1) next responder in
  rotation order **+ `@ONCALL_MANAGER` mention** → (2) **`@channel` broadcast** to the
  whole alerts channel. Each hop fires only if the prior went unacked for the timeout.
  Manager id comes from **env**, not a responder row, so the level-1 backstop is always a
  distinct person and the rotation never lands on the manager as primary. Level 2 is
  terminal (no vendor paging beyond it in v1); the first allow-listed user to ack stops
  the ladder.
- **Auto-promote** — **button-only; an alert never auto-mints an incident.** Prevents
  an alert storm creating duplicate incidents; the primary on-call promotes with one
  click. Revisit only if noise proves otherwise.
- **Alert secret** — **one shared `ONCALL_ALERT_SECRET`, reusing the Slack HMAC helper.**
  Single-tenant with few sources; per-source secrets are multi-tenant thinking.
