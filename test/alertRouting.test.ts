import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestAlert } from "../src/oncall/alerts";
import { decideAlertRoute, routeNewAlert } from "../src/oncall/routing";
import { promoteAlertToIncident } from "../src/oncall/escalation";
import { __setNotifierSlackClient } from "../src/oncall/notifier";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setControlsSlackClient } from "../src/incidents/controls";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const KEY = "test_route_alert";
const RESP = "U_route_a";
const FALLBACK = "C_route_fallback";

async function seedResponder() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, NULL, 1, 0)",
  ).bind(RESP, RESP).run();
  await env.DB.prepare(
    "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 1)",
  ).bind(
    "shift_route_test", RESP,
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() + 3600_000).toISOString(),
  ).run();
}

async function clean() {
  await env.DB.prepare(
    "DELETE FROM oncall_escalations WHERE alert_id IN (SELECT id FROM oncall_alerts WHERE dedup_key LIKE 'test_route_%')",
  ).run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_route_%'").run();
  await env.DB.prepare("DELETE FROM oncall_shifts WHERE id = 'shift_route_test'").run();
  await env.DB.prepare("DELETE FROM oncall_responders WHERE id = ?").bind(RESP).run();
  await env.DB.prepare("DELETE FROM incidents WHERE name LIKE 'RT_%'").run();
}

async function escCount(alertId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM oncall_escalations WHERE alert_id = ?")
    .bind(alertId).first<{ n: number }>();
  return r?.n ?? 0;
}

describe("alert routing — decision", () => {
  it("internal pages, external notifies-only", () => {
    expect(decideAlertRoute("internal")).toEqual({ page: true, notifyChannel: false, incidentPath: "internal" });
    expect(decideAlertRoute("external")).toEqual({ page: false, notifyChannel: true, incidentPath: "external" });
  });
});

describe("alert routing — behavior", () => {
  let fake: FakeSlackClient;
  beforeEach(async () => {
    await clean();
    await seedResponder();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    (env as any).ONCALL_ACK_TIMEOUT_MIN = "10";
    fake = new FakeSlackClient(false);
    __setNotifierSlackClient(() => fake);
    __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
    __setRolesSlackClient(() => fake);
    __setControlsSlackClient(() => fake);
    __setStakeholderSlackClient(() => fake);
  });
  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    __resetIncidentClientOverrides();
    __setRolesSlackClient(undefined);
    __setControlsSlackClient(undefined);
    __setStakeholderSlackClient(undefined);
    delete (env as any).ONCALL_FALLBACK_CHANNEL;
    await clean();
  });

  it("internal alert pages on-call (escalation row created)", async () => {
    const out = await ingestAlert(env as any, { title: "RT_internal", dedup_key: KEY, route: "internal" });
    if (out.result !== "created") throw new Error("expected created");
    expect(out.alert.route).toBe("internal");
    const action = await routeNewAlert(env as any, out.alert);
    expect(action.page).toBe(true);
    expect(await escCount(out.alert.id)).toBeGreaterThan(0);
  });

  it("external alert does NOT page — posts a comms notice instead", async () => {
    const out = await ingestAlert(env as any, { title: "RT_external", dedup_key: KEY, route: "external" });
    if (out.result !== "created") throw new Error("expected created");
    expect(out.alert.route).toBe("external");
    const action = await routeNewAlert(env as any, out.alert);
    expect(action.page).toBe(false);
    // No escalation ladder for external.
    expect(await escCount(out.alert.id)).toBe(0);
    // A comms notice with a Create-incident button landed in the fallback channel.
    const notice = fake.postedBlocks.find(
      (b) => b.channel === FALLBACK && b.text.includes("Upstream alert"),
    );
    expect(notice).toBeTruthy();
  });

  it("default route is internal when unspecified", async () => {
    const out = await ingestAlert(env as any, { title: "RT_default", dedup_key: KEY });
    if (out.result !== "created") throw new Error("expected created");
    expect(out.alert.route).toBe("internal");
  });

  it("promoting an external alert opens the incident on the external routing path", async () => {
    const out = await ingestAlert(env as any, { title: "RT_promote", dedup_key: KEY, route: "external" });
    if (out.result !== "created") throw new Error("expected created");
    const res = await promoteAlertToIncident(env as any, out.alert.id);
    expect(res).not.toBeNull();
    const inc = await env.DB.prepare("SELECT name, routing_path FROM incidents WHERE id = ?")
      .bind(res!.incidentId).first<{ name: string; routing_path: string }>();
    expect(inc?.routing_path).toBe("external");
    // rename so scoped cleanup (RT_% ... but title is the alert's) catches it:
    await env.DB.prepare("UPDATE incidents SET name = 'RT_promoted' WHERE id = ?").bind(res!.incidentId).run();
  });
});
