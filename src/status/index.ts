import type { Db, StatusSink } from "./sink";
import { InternalStatusSink } from "./internalSink";
import { MultiSink } from "./multiSink";
import { StatuspageSink } from "./statuspageSink";

export interface StatusSinkEnv {
  STATUSPAGE_API_KEY?: string;
  STATUSPAGE_PAGE_ID?: string;
}

/**
 * Always include the internal D1 sink (source of truth). Additionally mirror to
 * Statuspage ONLY when a token (and page id) are configured.
 * See docs/ARCHITECTURE.md §6.
 */
export function buildStatusSink(db: Db, env: StatusSinkEnv): StatusSink {
  const sinks: StatusSink[] = [new InternalStatusSink(db)];

  if (env.STATUSPAGE_API_KEY && env.STATUSPAGE_PAGE_ID) {
    sinks.push(new StatuspageSink(env.STATUSPAGE_API_KEY, env.STATUSPAGE_PAGE_ID));
  }

  return new MultiSink(sinks);
}

export * from "./types";
export * from "./sink";
export { InternalStatusSink } from "./internalSink";
export { MultiSink } from "./multiSink";
export { StatuspageSink } from "./statuspageSink";
