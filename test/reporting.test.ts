import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { buildReport, periodWindow, reportToCsv } from "../src/reporting/service";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import type { Report } from "../src/reporting/service";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function inc(id: string, created: string, resolved: string | null, status = resolved ? "resolved" : "investigating") {
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, id, status, created, resolved)
    .run();
}
async function upd(id: string, incId: string, at: string) {
  await env.DB.prepare(
    "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, 'x', 'investigating', ?)",
  )
    .bind(id, incId, at)
    .run();
}

describe("reporting", () => {
  afterEach(async () => {
    for (const t of ["postmortem_action_items", "postmortems", "incident_updates", "incidents"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("periodWindow maps tokens to windows", () => {
    const now = new Date("2026-09-30T00:00:00.000Z");
    expect(periodWindow("30d", now).from).toBe("2026-08-31T00:00:00.000Z");
    expect(periodWindow("all", now).from).toBe("1970-01-01T00:00:00.000Z");
    expect(periodWindow("bogus", now).from).toBe("2026-08-31T00:00:00.000Z"); // defaults 30d
  });

  it("computes opened/resolved/open_now/MTTR/MTTA/backlog", async () => {
    // Window: all of September.
    const from = "2026-09-01T00:00:00.000Z";
    const to = "2026-10-01T00:00:00.000Z";

    // A: opened+resolved in window; open->resolve = 1h; first ack update +10m.
    await inc("A", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z");
    await upd("A0", "A", "2026-09-02T00:00:00.000Z"); // opening update
    await upd("A1", "A", "2026-09-02T00:10:00.000Z"); // ack
    // B: opened in window, still open; ack +20m.
    await inc("B", "2026-09-03T00:00:00.000Z", null);
    await upd("B0", "B", "2026-09-03T00:00:00.000Z");
    await upd("B1", "B", "2026-09-03T00:20:00.000Z");
    // Backlog: one done, one open action item on a post-mortem.
    await env.DB.prepare("INSERT INTO postmortems (id, incident_id, status) VALUES ('pmA','A','draft')").run();
    await env.DB.prepare("INSERT INTO postmortem_action_items (id, postmortem_id, description, done) VALUES ('i1','pmA','x',0)").run();
    await env.DB.prepare("INSERT INTO postmortem_action_items (id, postmortem_id, description, done) VALUES ('i2','pmA','y',1)").run();

    const r = await buildReport(new D1Db(env.DB), from, to);
    expect(r.opened).toBe(2);
    expect(r.resolved).toBe(1);
    expect(r.open_now).toBe(1);
    expect(r.mttr_seconds).toBe(3600); // A: 1h
    expect(r.mtta_seconds).toBe((600 + 1200) / 2); // A 10m, B 20m -> mean 15m
    expect(r.open_action_items).toBe(1);
  });

  it("returns nulls when nothing resolved/acked", async () => {
    const r = await buildReport(new D1Db(env.DB), "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    expect(r.mttr_seconds).toBeNull();
    expect(r.mtta_seconds).toBeNull();
    expect(r.opened).toBe(0);
  });

  it("serializes CSV", () => {
    const r: Report = {
      from: "a", to: "b", opened: 3, resolved: 2, open_now: 1,
      mttr_seconds: 3600, mtta_seconds: null, open_action_items: 4,
    };
    const csv = reportToCsv(r);
    expect(csv).toContain("metric,value");
    expect(csv).toContain("opened,3");
    expect(csv).toContain("mtta_seconds,");
  });

  it("serves the endpoint as JSON and CSV, gated", async () => {
    expect((await SELF.fetch("https://x/api/reports")).status).toBe(401);
    const s = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
    const cookie = `${SESSION_COOKIE}=${await signSession(s, SECRET)}`;

    const jsonRes = await SELF.fetch("https://x/api/reports?period=all", { headers: { Cookie: cookie } });
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");

    const csvRes = await SELF.fetch("https://x/api/reports?period=all&format=csv", { headers: { Cookie: cookie } });
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    expect(csvRes.headers.get("content-disposition")).toContain("attachment");
  });
});
