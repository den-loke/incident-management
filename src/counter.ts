/// <reference types="@cloudflare/workers-types" />

// Monotonic incident-number allocator. A single Durable Object instance
// (addressed by a fixed name, see nextIncidentNumber) is the one serialization
// point for the global incident sequence, so two concurrent declares can never
// receive the same number. See docs/ARCHITECTURE.md §2.

const KEY = "n";

/**
 * A single-instance Durable Object holding one monotonically increasing
 * counter. `next()` is serialized by the DO's single-threaded execution model
 * plus blockConcurrencyWhile, so concurrent callers are handed distinct,
 * strictly increasing integers (1, 2, 3, …).
 */
export class IncidentCounter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(): Promise<Response> {
    const value = await this.next();
    return new Response(JSON.stringify({ value }), {
      headers: { "content-type": "application/json" },
    });
  }

  /** Atomically increment and return the next number, starting at 1. */
  private async next(): Promise<number> {
    let value = 0;
    await this.state.blockConcurrencyWhile(async () => {
      const current = (await this.state.storage.get<number>(KEY)) ?? 0;
      value = current + 1;
      await this.state.storage.put(KEY, value);
    });
    return value;
  }
}

// The counter is a singleton: every incident draws from the SAME instance, so
// it is always addressed by this fixed name.
const COUNTER_NAME = "incident-counter";

/**
 * Draw the next incident number from the counter DO. Injectable in tests via
 * __setNextIncidentNumber so the fake harness can produce deterministic ids
 * without a live DO round-trip.
 */
export async function nextIncidentNumber(
  ns: DurableObjectNamespace,
): Promise<number> {
  if (override) return override();
  const stub = ns.get(ns.idFromName(COUNTER_NAME));
  const res = await stub.fetch("https://do/next");
  const { value } = (await res.json()) as { value: number };
  return value;
}

/** Format an incident number as its public id, e.g. 42 -> "INC-42". */
export function formatIncidentId(n: number): string {
  return `INC-${n}`;
}

// --- test seam ---
let override: (() => number) | undefined;
export function __setNextIncidentNumber(fn: (() => number) | undefined): void {
  override = fn;
}
