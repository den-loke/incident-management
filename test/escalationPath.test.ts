import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { buildEscalationPath, listEscalationEvents } from "../src/oncall/escalationPath";
import type { Env } from "../src/env";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ...overrides };
}

describe("escalation path (read-only diagram)", () => {
  it("derives the fixed ladder with configured timings + manager", () => {
    const p = buildEscalationPath(
      baseEnv({ ONCALL_ACK_TIMEOUT_MIN: "15", ONCALL_MANAGER: "U_MGR", ONCALL_FALLBACK_CHANNEL: "C_ALERTS" }),
    );
    expect(p.ack_timeout_minutes).toBe(15);
    expect(p.manager).toBe("U_MGR");
    expect(p.fallback_channel).toBe("C_ALERTS");
    // page → L0 → L1 → L2
    expect(p.steps.map((s) => s.level)).toEqual([-1, 0, 1, 2]);
    expect(p.steps[1].wait_minutes).toBe(15); // L0 waits the ack timeout
    expect(p.steps[3].wait_minutes).toBeNull(); // L2 terminal
    expect(p.steps[2].detail).toContain("U_MGR"); // manager mentioned at L1
  });

  it("falls back to a 10-minute default and notes missing manager/channel", () => {
    const p = buildEscalationPath(baseEnv({ ONCALL_ACK_TIMEOUT_MIN: "", ONCALL_MANAGER: undefined, ONCALL_FALLBACK_CHANNEL: undefined }));
    expect(p.ack_timeout_minutes).toBe(10);
    expect(p.manager).toBeNull();
    expect(p.steps[2].detail).toContain("No manager");
    expect(p.steps[0].detail).toContain("No fallback channel");
  });
});

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_escalations WHERE id LIKE 'ESCT-%'").run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE id LIKE 'ALT-%'").run();
}

describe("escalation events (cross-alert log)", () => {
  afterEach(clean);

  it("joins alert title/status, newest first", async () => {
    await env.DB.prepare(
      "INSERT INTO oncall_alerts (id, source, title, status, received_at) VALUES (?, 'http', ?, ?, ?)",
    ).bind("ALT-1", "DB latency", "resolved", "2026-09-01T00:00:00.000Z").run();
    await env.DB.prepare(
      "INSERT INTO oncall_alerts (id, source, title, status, received_at) VALUES (?, 'http', ?, ?, ?)",
    ).bind("ALT-2", "API 500s", "firing", "2026-09-02T00:00:00.000Z").run();

    await env.DB.prepare(
      "INSERT INTO oncall_escalations (id, alert_id, level, target, channel, fired_at, acked_at, acked_by) VALUES (?, ?, ?, ?, 'slack', ?, ?, ?)",
    ).bind("ESCT-1", "ALT-1", 0, "U_A", "2026-09-01T00:01:00.000Z", "2026-09-01T00:02:00.000Z", "U_A").run();
    await env.DB.prepare(
      "INSERT INTO oncall_escalations (id, alert_id, level, target, channel, fired_at) VALUES (?, ?, ?, ?, 'slack', ?)",
    ).bind("ESCT-2", "ALT-2", 0, "U_B", "2026-09-02T00:01:00.000Z").run();

    const events = (await listEscalationEvents(env as unknown as Env)).filter((e) => e.id.startsWith("ESCT-"));
    // Newest (ALT-2) first.
    expect(events[0].id).toBe("ESCT-2");
    expect(events[0].alert_title).toBe("API 500s");
    expect(events[0].alert_status).toBe("firing");
    expect(events[0].acked_at).toBeNull();
    const e1 = events.find((e) => e.id === "ESCT-1")!;
    expect(e1.acked_by).toBe("U_A");
    expect(e1.alert_status).toBe("resolved");
  });
});
