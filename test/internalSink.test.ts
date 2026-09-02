import { describe, expect, it } from "vitest";
import { InternalStatusSink } from "../src/status/internalSink";
import { FakeDb } from "./fakeDb";

describe("InternalStatusSink", () => {
  it("opens an incident with defaults and an optional first update", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);

    const inc = await sink.openIncident({ name: "API errors", body: "Looking into it" });

    expect(inc.status).toBe("investigating");
    expect(inc.resolved_at).toBeNull();
    expect(db.incidents.get(inc.id)).toBeTruthy();
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({
      incident_id: inc.id,
      body: "Looking into it",
      status: "investigating",
    });
  });

  it("appends updates and advances incident status", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);
    const inc = await sink.openIncident({ name: "Degraded" });

    await sink.appendIncidentUpdate(inc.id, "Root cause found", "identified");
    const after = await sink.getIncident(inc.id);
    expect(after?.status).toBe("identified");
    expect(after?.resolved_at).toBeNull();
  });

  it("sets resolved_at when an update resolves the incident", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);
    const inc = await sink.openIncident({ name: "Outage" });

    await sink.appendIncidentUpdate(inc.id, "All clear", "resolved");
    const after = await sink.getIncident(inc.id);
    expect(after?.status).toBe("resolved");
    expect(after?.resolved_at).not.toBeNull();
  });

  it("sets component status", async () => {
    const db = new FakeDb();
    db.seedComponent("cmp_api", "API");
    const sink = new InternalStatusSink(db);

    await sink.setComponentStatus("cmp_api", "major_outage");
    const comps = await sink.listComponents();
    expect(comps.find((c) => c.id === "cmp_api")?.status).toBe("major_outage");
  });
});
