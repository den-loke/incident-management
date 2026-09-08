import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getIncidentDetail, getIncidentTimeline, getDraftReportData } from "../src/incidents/read";

const TOKEN = "e2e-mcp-token"; // matches vitest.config.ts binding

async function seedIncident(id: string) {
  // Declared at 00:00, identified 00:10, resolved 00:40 → durations derivable.
  await env.DB.prepare(
    `INSERT INTO incidents (id, name, status, severity, routing_path, created_at, resolved_at, identified_at, closed_at, last_updated_at)
     VALUES (?, ?, 'resolved', 'sev1', 'internal', ?, ?, ?, ?, ?)`,
  ).bind(
    id, "DB is down",
    "2026-09-02T00:00:00.000Z", "2026-09-02T00:40:00.000Z",
    "2026-09-02T00:10:00.000Z", "2026-09-02T00:40:00.000Z", "2026-09-02T00:40:00.000Z",
  ).run();
  await env.DB.prepare(
    "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("iu_1", id, "Investigating", "investigating", "2026-09-02T00:00:00.000Z").run();
  await env.DB.prepare(
    "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind("iu_2", id, "Fixed", "resolved", "2026-09-02T00:40:00.000Z").run();
}

async function rpc(body: unknown) {
  return SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

describe("per-incident read helpers + MCP tools", () => {
  beforeEach(async () => {
    for (const t of ["incident_updates", "incidents"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });
  afterEach(async () => {
    for (const t of ["postmortem_action_items", "postmortems", "incident_updates", "incidents"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("getIncidentDetail returns the incident, timeline, and derived durations (seconds)", async () => {
    await seedIncident("INC-100");
    const d = await getIncidentDetail(env as any, "INC-100");
    expect(d).not.toBeNull();
    expect(d!.id).toBe("INC-100");
    expect(d!.updates.map((u) => u.body)).toEqual(["Investigating", "Fixed"]);
    // total 40m, TTI 10m, TTR 40m.
    expect(d!.durations.total_seconds).toBe(2400);
    expect(d!.durations.time_to_identify_seconds).toBe(600);
    expect(d!.durations.time_to_resolve_seconds).toBe(2400);
  });

  it("getIncidentDetail returns null for an unknown incident", async () => {
    expect(await getIncidentDetail(env as any, "INC-nope")).toBeNull();
  });

  it("getIncidentTimeline returns updates chronologically; null when unknown", async () => {
    await seedIncident("INC-101");
    const t = await getIncidentTimeline(env as any, "INC-101");
    expect(t!.map((u) => u.status)).toEqual(["investigating", "resolved"]);
    expect(await getIncidentTimeline(env as any, "INC-nope")).toBeNull();
  });

  it("getDraftReportData bundles detail + (absent) post-mortem", async () => {
    await seedIncident("INC-102");
    const data = await getDraftReportData(env as any, "INC-102");
    expect(data!.incident.id).toBe("INC-102");
    expect(data!.postmortem).toBeNull(); // none drafted in this test
  });

  it("MCP get_incident returns the detail as JSON text; unknown id → isError", async () => {
    await seedIncident("INC-103");
    const ok = (await (await rpc({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "get_incident", arguments: { incident_id: "INC-103" } },
    })).json()) as { result: { content: { text: string }[]; isError: boolean } };
    expect(ok.result.isError).toBe(false);
    const parsed = JSON.parse(ok.result.content[0].text) as { id: string; durations: { total_seconds: number } };
    expect(parsed.id).toBe("INC-103");
    expect(parsed.durations.total_seconds).toBe(2400);

    const bad = (await (await rpc({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "get_incident", arguments: { incident_id: "INC-nope" } },
    })).json()) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
  });
});
