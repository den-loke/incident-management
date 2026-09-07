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

  it("stamps last_updated_at on open and identified_at when first reaching identified", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);
    const inc = await sink.openIncident({ name: "Degraded" });

    expect(inc.last_updated_at).toBe(inc.created_at);
    expect(inc.identified_at).toBeNull();
    expect(inc.closed_at).toBeNull();

    await sink.appendIncidentUpdate(inc.id, "Root cause found", "identified");
    const identified = await sink.getIncident(inc.id);
    expect(identified?.identified_at).not.toBeNull();
    expect(identified?.last_updated_at).toBe(identified?.identified_at);
    expect(identified?.closed_at).toBeNull();

    // identified_at is stamped ONCE — a later monitoring update must not move it,
    // while last_updated_at tracks the latest update (>=, since the clock may not
    // have advanced a whole millisecond between the two writes).
    const firstIdentifiedAt = identified?.identified_at as string;
    await sink.appendIncidentUpdate(inc.id, "Watching", "monitoring");
    const monitoring = await sink.getIncident(inc.id);
    expect(monitoring?.identified_at).toBe(firstIdentifiedAt);
    expect(
      new Date(monitoring?.last_updated_at as string).getTime(),
    ).toBeGreaterThanOrEqual(new Date(firstIdentifiedAt).getTime());
  });

  it("stamps closed_at (and identified_at) when an update resolves directly", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);
    const inc = await sink.openIncident({ name: "Outage" });

    await sink.appendIncidentUpdate(inc.id, "All clear", "resolved");
    const after = await sink.getIncident(inc.id);
    expect(after?.closed_at).toBe(after?.resolved_at);
    // Resolving directly from investigating back-stamps identified_at,
    // since 'resolved' outranks 'identified'.
    expect(after?.identified_at).not.toBeNull();
  });

  it("stamps identified_at at open when declared already at that status", async () => {
    const db = new FakeDb();
    const sink = new InternalStatusSink(db);
    const inc = await sink.openIncident({ name: "Known", status: "identified" });
    expect(inc.identified_at).toBe(inc.created_at);
    expect(inc.closed_at).toBeNull();
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
