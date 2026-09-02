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
- Note the **Client ID**, **Client Secret**, **Signing Secret**, **Bot token**
  (`xoxb-…`), and the workspace **Team ID** (`T…`).

### 4. Set secrets for that environment

```bash
npx wrangler secret put SLACK_TEAM_ID        --env test
npx wrangler secret put SLACK_BOT_TOKEN      --env test
npx wrangler secret put SLACK_SIGNING_SECRET --env test
npx wrangler secret put SLACK_CLIENT_ID      --env test
npx wrangler secret put SLACK_CLIENT_SECRET  --env test
npx wrangler secret put OPENAI_API_KEY       --env test
# Optional — enables the Statuspage mirror sink:
npx wrangler secret put STATUSPAGE_API_KEY   --env test
npx wrangler secret put STATUSPAGE_PAGE_ID   --env test
```

Do NOT set `AUTH_MODE` in a real deployment — leave it unset so Slack OIDC is
enforced. `AUTH_MODE=bypass` is for the test runner and local no-Slack dev only.

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
