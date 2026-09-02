import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Db, buildStatusSink } from "../src/status";

describe("D1Db + buildStatusSink over real D1", () => {
  it("opens an incident, appends an update, and reads it back from D1", async () => {
    const sink = buildStatusSink(new D1Db(env.DB), env);

    const inc = await sink.openIncident({
      name: "D1 adapter smoke",
      body: "first",
    });
    expect(inc.status).toBe("investigating");

    await sink.appendIncidentUpdate(inc.id, "root cause found", "identified");

    const readBack = await sink.getIncident(inc.id);
    expect(readBack?.status).toBe("identified");

    const updates = await env.DB.prepare(
      "SELECT body, status FROM incident_updates WHERE incident_id = ? ORDER BY created_at",
    )
      .bind(inc.id)
      .all<{ body: string; status: string }>();
    expect(updates.results.map((u) => u.body)).toEqual([
      "first",
      "root cause found",
    ]);
  });

  it("builds an internal-only sink when no Statuspage key is set", async () => {
    // env has no STATUSPAGE_API_KEY -> MultiSink with just the internal sink;
    // a write must not throw (which the StatuspageSink stub would).
    const sink = buildStatusSink(new D1Db(env.DB), {});
    const inc = await sink.openIncident({ name: "internal only" });
    expect(inc.id).toBeTruthy();
  });
});
