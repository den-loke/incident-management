# Deploying — two URLs, two Slack workspaces

The Worker ships in two named environments (`test`, `production`) defined in
`wrangler.jsonc`. Each has its own worker name, its own D1 database, and its own
set of secrets. One deployment == one Slack workspace == one Statuspage page
(single-tenant, per `docs/ARCHITECTURE.md`).

| Env          | Worker name                | URL (workers.dev)                                          | Slack          |
| ------------ | -------------------------- | ---------------------------------------------------------- | -------------- |
| `test`       | `incident-management-test` | `https://incident-management-test.<subdomain>.workers.dev` | test workspace |
| `production` | `incident-management`      | `https://incident-management.<subdomain>.workers.dev`      | real workspace |

`<subdomain>` is your account's workers.dev subdomain (set once in the Cloudflare
dashboard under Workers & Pages). Custom domains can be attached later per env —
nothing in the code assumes workers.dev; the OIDC `redirect_uri` is derived from
the incoming request origin.

## One-time per environment

Do this once for `test`, then again for `production`.

### 1. Create the D1 database and paste its id into `wrangler.jsonc`

```bash
npx wrangler d1 create incident-management-test        # (or -prod for production)
```

Copy the printed `database_id` into the matching
`env.<name>.d1_databases[0].database_id` in `wrangler.jsonc` (they currently hold
`PLACEHOLDER_...`).

### 2. Apply migrations to that database

```bash
npx wrangler d1 migrations apply incident-management-test --remote
```

### 3. Create the Slack app for that workspace

- **Sign in with Slack (OpenID Connect):** add redirect URL
  `https://incident-management-test.<subdomain>.workers.dev/auth/callback`.
  Grant the `openid` and `profile` scopes.
- **Event Subscriptions:** request URL
  `https://incident-management-test.<subdomain>.workers.dev/slack/events`
  (the Worker answers the `url_verification` challenge automatically).
- **Interactivity & Shortcuts:** turn on Interactivity and set the request URL
  `https://incident-management-test.<subdomain>.workers.dev/slack/interactivity`.
  This is what delivers role-claim buttons, the joint-resolve Confirm button, the
  Home-tab stakeholder toggle, AND the declare-modal submission (`view_submission`)
  — shared by the Home-tab "Declare incident" button and `/incident declare`.
- **Slash Commands:** create one command `/incident` with request URL
  `https://incident-management-test.<subdomain>.workers.dev/slack/commands`.
  A single command carries all subcommands — `declare` (bare opens the shared
  declare modal (name + severity), or pass a title to declare immediately),
  `update <text>`, `status <investigating|identified|monitoring> [note]`,
  `resolve [note]`, and `help`. No extra bot scopes are needed beyond those
  already granted (`chat:write`, `channels:manage`, `channels:read`,
  `channels:history`); the modal uses `views.open`/`views.publish`, which
  chat:write covers.
- Note the **Client ID**, **Client Secret**, **Signing Secret**, **Bot token**
  (`xoxb-…`), and the workspace **Team ID** (`T…`).

### 4. Set secrets for that environment

**Non-secret config lives in `wrangler.jsonc` `vars`** (committed, per-env — named
envs don't inherit, so each env repeats its block). For `test` these are already
set: `APP_BASE_URL`, `SLACK_CLIENT_ID` (public — it's in the OAuth redirect),
`SLACK_TEAM_ID`, and the on-call defaults (`ONCALL_TZ`, `ONCALL_ROTATION_DAYS`,
`ONCALL_ACK_TIMEOUT_MIN`). Non-secret identifiers for optional features go here too
when you enable them: `STATUSPAGE_PAGE_ID`, `JIRA_BASE_URL`, `JIRA_EMAIL`,
`JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE`, `ONCALL_MANAGER`, `ONCALL_FALLBACK_CHANNEL`,
`ONCALL_TWILIO_ACCOUNT_SID`, `ONCALL_TWILIO_FROM`, `ONCALL_CHANNEL_POLICY`.

**Secrets are ONLY real credentials** — set via `wrangler secret put`:

```bash
npx wrangler secret put SLACK_BOT_TOKEN      --env test
npx wrangler secret put SLACK_SIGNING_SECRET --env test
npx wrangler secret put SLACK_CLIENT_SECRET  --env test
npx wrangler secret put OPENAI_API_KEY       --env test
# Optional tokens, as you enable each feature:
npx wrangler secret put STATUSPAGE_API_KEY   --env test   # + STATUSPAGE_PAGE_ID as a var
npx wrangler secret put JIRA_API_TOKEN       --env test   # + JIRA_* ids as vars
npx wrangler secret put ONCALL_ALERT_SECRET  --env test
npx wrangler secret put ONCALL_TWILIO_AUTH_TOKEN --env test
npx wrangler secret put ZENDESK_WEBHOOK_SECRET --env test  # enables POST /api/alerts/zendesk
```

A `vars` entry and a same-named secret CONFLICT — a value is either a var or a
secret, never both. Do NOT set `AUTH_MODE` in a real deployment — leave it unset so
Slack OIDC is enforced. `AUTH_MODE=bypass` is for the test runner and local
no-Slack dev only.

### 5. Deploy

```bash
npx wrangler deploy --env test          # or --env production
```

Open the URL, click **Sign in with Slack**, approve — you land on the status page.
An account outside the configured `SLACK_TEAM_ID` is rejected at the callback.

## Day-to-day

```bash
npm run dev                         # local, http://localhost:8787
npx wrangler deploy --env test
npx wrangler deploy --env production
```

## Auth model (recap)

- Dashboard routes (`/`, `/auth/*`) are gated by a signed session cookie minted
  after Slack OIDC. The whole UI is behind login day-one.
- `/slack/events` authenticates **independently** by Slack's HMAC signature and
  never touches OIDC.
- The `team_id === SLACK_TEAM_ID` check on the OIDC callback is the authorization
  gate: any member of the workspace is allowed, everyone else is rejected.

## Zendesk webhook receiver (optional alert source)

Turns a Zendesk trigger into an alert (an extra source alongside `POST /api/alerts`).
This is a **webhook**, not mail ingestion — no IMAP/SMTP, no mailbox polling.

1. **Set the shared secret** (above): `wrangler secret put ZENDESK_WEBHOOK_SECRET`.
   The receiver is disabled while this is unset (all requests → `401`).
2. **Create a Zendesk webhook** (Admin Center → Apps and integrations → Webhooks →
   *Create webhook*, "Trigger or automation"):
   - **Endpoint URL**: `https://<your-worker-host>/api/alerts/zendesk`
   - **Request method**: `POST`, **Format**: JSON
   - **Authentication**: none here — we verify a signature header instead (next step).
3. **Sign the request.** We verify `X-Signature: sha256=<hex>` = HMAC-SHA256 of the
   **raw JSON body** keyed on `ZENDESK_WEBHOOK_SECRET` (same scheme as `/api/alerts`).
   Add the header in the webhook config. (If you front the webhook with a small relay
   that computes the HMAC, point Zendesk at the relay; native Zendesk signing keys are
   not used by this receiver.)
4. **Create a trigger** (Admin Center → Objects and rules → Triggers) that fires the
   webhook — e.g. *Ticket is assigned to group = "Escalations"*. Under **Actions →
   Notify webhook**, select the webhook and template the JSON body:
   ```json
   {
     "ticket": {
       "id": "{{ticket.id}}",
       "subject": "{{ticket.title}}",
       "description": "{{ticket.description}}",
       "priority": "{{ticket.priority}}",
       "status": "{{ticket.status}}",
       "url": "{{ticket.link}}"
     }
   }
   ```

**Mapping** (`src/oncall/zendesk.ts`): `priority` urgent→SEV1, high→SEV2, else SEV3;
`status` solved/closed → an alert **resolve** (recovery), anything else → **firing**;
`dedup_key = zendesk:<ticket id>` so re-fires fold and a later solved webhook closes
the open alert. Defaults to **`route:"external"`** (customer-facing → comms notice +
Create-incident button, no on-call page); send `"route":"internal"` in the body to page.
