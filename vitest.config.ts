import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  // Load the SQL migrations so the test setup can apply them to the test D1.
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    test: {
      setupFiles: ["./test/applyMigrations.ts"],
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
            },
          },
        },
      },
    },
  };
});
