# incident-management

Slack-first incident management tool. Cloudflare-native (Workers, Durable
Objects, D1, Workflows). Mirrors status to statuspage.io; incident operations
run through Slack. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Develop

```bash
npm install
npm run typecheck   # worker + scripts
npm run test        # vitest (vitest-pool-workers) — deterministic, no network
```

## Local development WITHOUT Slack

You can run and drive a full fake incident locally with no Slack workspace and
no OpenAI key — the Durable Object swaps in in-process fakes when
`AUTH_MODE=bypass`, while the internal status page is still written to the local
D1.

1. Copy `.dev.vars.example` to `.dev.vars` and use the **LOCAL NO-SLACK
   PROFILE** at the bottom (`AUTH_MODE=bypass`, `SLACK_SIGNING_SECRET=dev-secret`).
2. Start the Worker:
   ```bash
   npm run dev            # wrangler dev on 127.0.0.1:8787
   ```
3. In another terminal, drive a scripted incident:
   ```bash
   npm run dev:fake-incident
   ```
   The harness forges *validly signed* Slack Events API requests (the real
   `verify → ack → route` path runs) that declare an incident and post chatter.
   Watch the `npm run dev` terminal for `[fake-slack]` / `[fake-openai]` output.

The 15-minute progress-update alarm is exercised deterministically in the
vitest suite (by advancing the DO alarm), not by waiting in real time.
