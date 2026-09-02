import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";
import type { Env } from "../src/env";

// Make `env` from "cloudflare:test" carry our Worker bindings plus the
// test-only migrations binding injected in vitest.config.ts.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
