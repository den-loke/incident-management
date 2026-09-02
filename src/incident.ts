/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";

/**
 * One Durable Object instance == one incident. See docs/ARCHITECTURE.md §2.
 * Owns per-incident state and the 15-min progress-update alarm.
 * Business logic is intentionally NOT implemented yet — this is the skeleton.
 */
export class Incident implements DurableObject {
  // Bindings (state, env) will be stored and used once logic lands; the stub
  // deliberately keeps no unused fields so it type-checks under strict lint.
  constructor(state: DurableObjectState, env: Env) {
    void state;
    void env;
  }

  async fetch(_request: Request): Promise<Response> {
    // TODO: route internal commands (open/update/resolve, ingest Slack event,
    // ingest transcript chunk). Skeleton only.
    return new Response("not implemented", { status: 501 });
  }

  /** Fires on the scheduled progress-update cadence (e.g. every 15 min). */
  async alarm(): Promise<void> {
    // TODO: pull recent Slack context, summarize via OpenAI, write StatusSink,
    // then reschedule (this.state.storage.setAlarm(...)) while incident is open.
  }
}
