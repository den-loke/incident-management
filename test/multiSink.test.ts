import { describe, expect, it, vi } from "vitest";
import { MultiSink } from "../src/status/multiSink";
import type { StatusSink } from "../src/status/sink";
import type { Incident } from "../src/status/types";

function fakeSink(tag: string, calls: string[]): StatusSink {
  const incident: Incident = {
    id: "inc_1",
    name: "n",
    status: "investigating",
    severity: "sev2",
    created_at: "t",
    resolved_at: null,
  };
  return {
    openIncident: vi.fn(async () => {
      calls.push(`${tag}:open`);
      return incident;
    }),
    appendIncidentUpdate: vi.fn(async () => {
      calls.push(`${tag}:append`);
      return {
        id: "iu_1",
        incident_id: "inc_1",
        body: "b",
        status: "identified" as const,
        created_at: "t",
      };
    }),
    setComponentStatus: vi.fn(async () => {
      calls.push(`${tag}:component`);
    }),
    getIncident: vi.fn(async () => {
      calls.push(`${tag}:getIncident`);
      return { ...incident, name: tag };
    }),
    listComponents: vi.fn(async () => {
      calls.push(`${tag}:listComponents`);
      return [];
    }),
  };
}

describe("MultiSink", () => {
  it("throws with no sinks", () => {
    expect(() => new MultiSink([])).toThrow();
  });

  it("fans writes out primary-first, then secondaries in order", async () => {
    const calls: string[] = [];
    const multi = new MultiSink([
      fakeSink("primary", calls),
      fakeSink("second", calls),
    ]);

    await multi.openIncident({ name: "x" });
    await multi.appendIncidentUpdate("inc_1", "b", "identified");
    await multi.setComponentStatus("cmp", "major_outage");

    expect(calls).toEqual([
      "primary:open",
      "second:open",
      "primary:append",
      "second:append",
      "primary:component",
      "second:component",
    ]);
  });

  it("reads only from the primary sink", async () => {
    const calls: string[] = [];
    const multi = new MultiSink([
      fakeSink("primary", calls),
      fakeSink("second", calls),
    ]);

    const inc = await multi.getIncident("inc_1");
    await multi.listComponents();

    expect(inc?.name).toBe("primary");
    expect(calls).toEqual(["primary:getIncident", "primary:listComponents"]);
  });
});
