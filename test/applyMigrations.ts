import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// Apply the SQL migrations (read in vitest.config.ts and exposed as
// env.TEST_MIGRATIONS) to the isolated test D1 before any test runs.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
