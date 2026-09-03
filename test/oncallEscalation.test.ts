import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestAlert } from "../src/oncall/alerts";
import { escalateNew, sweepEscalations, ackAlert } from "../src/oncall/escalation";
import { __setNotifierSlackClient } from "../src/oncall/notifier";
import { FakeSlackClient } from "../src/clients/fakeSlack";

const KEY = "test_esc_disk";
const RESP = ["U_esc_a", "U_esc_b", "U_esc_c"];
const FALLBACK = "C_esc_fallback";

async function seedResponders() {
  let i = 0;
  for (const id of RESP) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, NULL, 1, ?)",
    ).bind(id, id, i++).run();
  }
  // A wide override makes whoIsOnCall deterministic (RESP[0] is primary now).
  await env.DB.prepare(
    "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 1)",
  ).bind(
    "shift_esc_test", RESP[0],
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() + 3600_000).toISOString(),
  ).run();
}

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_escalations WHERE alert_id IN (SELECT id FROM oncall_alerts WHERE dedup_key LIKE 'test_esc_%')").run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_esc_%'").run();
  await env.DB.prepare("DELETE FROM oncall_shifts WHERE id = 'shift_esc_test'").run();
  const ph = RESP.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM oncall_responders WHERE id IN (${ph})`).bind(...RESP).run();
}

async function newAlert() {
  const out = await ingestAlert(env as any, { title: "Disk full", dedup_key: KEY, severity: "sev1" });
  if (out.result !== "created") throw new Error("expected created");
  return out.alert;
}

async function levels(alertId: string): Promise<number[]> {
  const { results } = await env.DB.prepare(
    "SELECT level FROM oncall_escalations WHERE alert_id = ? ORDER BY fired_at",
  ).bind(alertId).all<{ level: number }>();
  return (results ?? []).map((r) => r.level);
}

// Backdate the newest escalation row so the sweep sees it as timed-out.
async function backdate(alertId: string, minutesAgo: number) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await env.DB.prepare(
    "UPDATE oncall_escalations SET fired_at = ? WHERE alert_id = ? AND fired_at = (SELECT MAX(fired_at) FROM oncall_escalations WHERE alert_id = ?)",
  ).bind(iso, alertId, alertId).run();
}

describe("on-call escalation ladder", () => {
  beforeEach(async () => {
    await clean();
    await seedResponders();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    (env as any).ONCALL_ACK_TIMEOUT_MIN = "10";
    (env as any).ONCALL_MANAGER = "U_manager";
    __setNotifierSlackClient(() => new FakeSlackClient(false));
  });
  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    await clean();
  });

  it("escalateNew fires level 0 to the primary on-call", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect(await levels(alert.id)).toEqual([0]);
    const row = await env.DB.prepare(
      "SELECT target, channel FROM oncall_escalations WHERE alert_id = ?",
    ).bind(alert.id).first<{ target: string; channel: string }>();
    expect(row?.target).toBe(RESP[0]);
    expect(row?.channel).toBe("slack");
  });

  it("sweep advances L0->L1->L2 on successive timeouts, terminal at L2", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect((await sweepEscalations(env as any)).escalated).toBe(0); // not timed out

    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(1);
    expect(await levels(alert.id)).toEqual([0, 1]);

    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(1);
    expect(await levels(alert.id)).toEqual([0, 1, 2]);

    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(0); // L2 terminal
    expect(await levels(alert.id)).toEqual([0, 1, 2]);
  });

  it("ack stops the ladder and sets the alert to ack", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    const out = await ackAlert(env as any, alert.id, "U_whoever");
    expect(out).toEqual({ result: "acked", alertId: alert.id });

    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(0);

    const a = await env.DB.prepare("SELECT status FROM oncall_alerts WHERE id = ?")
      .bind(alert.id).first<{ status: string }>();
    expect(a?.status).toBe("ack");
  });

  it("ack is idempotent / no-ops when already acked", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    await ackAlert(env as any, alert.id, "U_first");
    const second = await ackAlert(env as any, alert.id, "U_second");
    expect(second).toEqual({ result: "ignored", reason: "already_acked" });
  });

  it("empty rotation with no fallback channel does not error", async () => {
    await clean();
    delete (env as any).ONCALL_FALLBACK_CHANNEL;
    const out = await ingestAlert(env as any, { title: "Orphan", dedup_key: KEY });
    if (out.result !== "created") throw new Error("expected created");
    await escalateNew(env as any, out.alert); // must not throw
    expect(await levels(out.alert.id)).toEqual([]); // nowhere to page
    await env.DB.prepare("DELETE FROM oncall_alerts WHERE id = ?").bind(out.alert.id).run();
  });
});
