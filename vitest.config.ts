import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  // Load the SQL migrations so the test setup can apply them to the test D1.
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    test: {
      setupFiles: ["./test/applyMigrations.ts"],
      // Never discover tests inside nested git worktrees (.worktrees/<branch>/):
      // vitest would double-collect them against the shared D1 and they collide.
      exclude: ["**/node_modules/**", "**/.worktrees/**"],
      poolOptions: {
        workers: {
          singleWorker: true,
          isolatedStorage: false,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // Surface the parsed migrations to the test setup as a binding,
            // plus a known Slack signing secret + team id so E2E tests can
            // forge validly-signed webhooks the Worker will accept.
            bindings: {
              TEST_MIGRATIONS: migrations,
              SLACK_SIGNING_SECRET: "e2e-signing-secret",
              SLACK_TEAM_ID: "T_E2E",
              // Pin auth to real OIDC in tests. Overrides any AUTH_MODE=bypass
              // that a local .dev.vars might otherwise leak into the test env,
              // which would silently turn the auth-gating assertions green.
              AUTH_MODE: "",
              // On-call alert HMAC secret so endpoint tests can forge a valid
              // X-Signature header (POST /api/alerts). See docs/SPEC_ONCALL.md §4.
              ONCALL_ALERT_SECRET: "e2e-alert-secret",
              // Zendesk webhook HMAC secret (POST /api/alerts/zendesk). Same
              // X-Signature scheme; see docs/DEPLOY.md.
              ZENDESK_WEBHOOK_SECRET: "e2e-zendesk-secret",
              // Twilio auth token so inbound-webhook tests can forge a valid
              // X-Twilio-Signature (POST /api/twilio/{sms,voice}). §3a.
              ONCALL_TWILIO_AUTH_TOKEN: "e2e-twilio-token",
              // A linked Engineering usergroup so /api/teams has one configured team.
              TEAM_ENGINEERING_USERGROUP: "S_ENG_E2E",
              // MCP connector bearer token so /mcp tests can authenticate.
              MCP_TOKEN: "e2e-mcp-token",
            },
          },
        },
      },
    },
  };
});
