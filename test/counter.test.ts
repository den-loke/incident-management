import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { formatIncidentId, nextIncidentNumber } from "../src/counter";

describe("IncidentCounter", () => {
  it("hands out strictly increasing numbers from a single instance", async () => {
    const a = await nextIncidentNumber(env.INCIDENT_COUNTER);
    const b = await nextIncidentNumber(env.INCIDENT_COUNTER);
    const c = await nextIncidentNumber(env.INCIDENT_COUNTER);

    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it("is monotonic under concurrent draws (no duplicates)", async () => {
    const draws = await Promise.all(
      Array.from({ length: 20 }, () => nextIncidentNumber(env.INCIDENT_COUNTER)),
    );
    const unique = new Set(draws);
    expect(unique.size).toBe(draws.length); // every draw distinct
    // Contiguous range: max - min == count - 1.
    expect(Math.max(...draws) - Math.min(...draws)).toBe(draws.length - 1);
  });

  it("formats a number as its public id", () => {
    expect(formatIncidentId(1)).toBe("INC-1");
    expect(formatIncidentId(42)).toBe("INC-42");
  });
});
