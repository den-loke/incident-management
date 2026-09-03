/// <reference types="@cloudflare/workers-types" />
// On-call scheduled work. See docs/SPEC_ONCALL.md §2/§3.
//
// Cron-driven rather than live timers, so it survives Worker restarts:
//   - daily  → generateShifts() keeps ~4 weeks of rotation materialised ahead.
//   - ~1 min → sweepEscalations() (added in build slice 3) fires the next level.
// Dispatch is by the fired cron expression so one Worker serves both cadences.

import type { Env } from "../env";
import { generateShifts } from "./rotation";
import { sweepEscalations } from "./escalation";

// Cron expressions declared in wrangler.jsonc [triggers].
const SHIFT_GEN_CRON = "0 0 * * *"; // daily at 00:00 UTC — top up the rotation
const ESCALATION_SWEEP_CRON = "* * * * *"; // every minute — advance unacked escalations

export async function runOncallScheduled(
  event: ScheduledController,
  env: Env,
): Promise<void> {
  switch (event.cron) {
    case SHIFT_GEN_CRON:
      await generateShifts(env);
      break;
    case ESCALATION_SWEEP_CRON:
      await sweepEscalations(env);
      break;
    default:
      // Unknown cron: run both idempotent maintenance passes as a safe default.
      await generateShifts(env);
      await sweepEscalations(env);
      break;
  }
}
