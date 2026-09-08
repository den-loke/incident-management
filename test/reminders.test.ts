import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStakeholderReminders, __setReminderSlackClient } from "../src/incidents/reminders";
import { FakeSlackClient } from "../src/clients/fakeSlack";

function iso(minsAgo: number, from = Date.now()): string {
  return new Date(from - minsAgo * 60_000).toISOString();
}

async function seed(opts: {
  id: string;
  severity: string;
  status?: string;
  lastUpdatedMinsAgo: number;
  lastRemindedMinsAgo?: number | null;
  channel?: string | null;
  csl?: string | null;
  el?: string | null;
}) {
  const status = opts.status ?? "investigating";
  await env.DB.prepare(
    `INSERT INTO incidents (id, name, status, severity, routing_path, created_at, last_updated_at, last_reminded_at)
     VALUES (?, ?, ?, ?, 'internal', ?, ?, ?)`,
  ).bind(
    opts.id, opts.id, status, opts.severity,
    iso(opts.lastUpdatedMinsAgo + 5), iso(opts.lastUpdatedMinsAgo),
    opts.lastRemindedMinsAgo == null ? null : iso(opts.lastRemindedMinsAgo),
  ).run();
  if (opts.channel !== null) {
    await env.DB.prepare(
      "INSERT INTO incident_channels (channel, incident_id, do_id) VALUES (?, ?, ?)",
    ).bind(opts.channel ?? `C_${opts.id}`, opts.id, opts.id).run();
  }
  if (opts.csl) {
    await env.DB.prepare(
      "INSERT INTO incident_roles (incident_id, role, slack_user_id, assigned_at) VALUES (?, 'customer_support_lead', ?, ?)",
    ).bind(opts.id, opts.csl, iso(0)).run();
  }
  if (opts.el) {
    await env.DB.prepare(
      "INSERT INTO incident_roles (incident_id, role, slack_user_id, assigned_at) VALUES (?, 'engineering_lead', ?, ?)",
    ).bind(opts.id, opts.el, iso(0)).run();
  }
}

describe("stakeholder-waiting reminders", () => {
  let fake: FakeSlackClient;
  const wipe = async () => {
    // Delete every table that FK-references incidents BEFORE incidents itself —
    // shared D1 (isolatedStorage off) means other files' rows can dangle.
    for (const t of [
      "oncall_escalations",
      "oncall_alerts",
      "incident_resolution_requests",
      "postmortem_action_items",
      "postmortems",
      "incident_roles",
      "incident_channels",
      "incident_updates",
      "incidents",
    ]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  };
  beforeEach(async () => {
    fake = new FakeSlackClient(false);
    __setReminderSlackClient(() => fake);
    await wipe();
  });
  afterEach(async () => {
    __setReminderSlackClient(undefined);
    await wipe();
  });

  it("nudges a SEV1 quiet for >15 min, tagging the Customer Support Lead", async () => {
    await seed({ id: "INC-1", severity: "sev1", lastUpdatedMinsAgo: 20, csl: "U_CSL", el: "U_EL" });
    const r = await sweepStakeholderReminders(env as any);
    expect(r.reminded).toBe(1);
    expect(fake.posted).toHaveLength(1);
    expect(fake.posted[0].channel).toBe("C_INC-1");
    expect(fake.posted[0].text).toContain("<@U_CSL>"); // CSL preferred over EL
  });

  it("does NOT nudge a SEV3 quiet for only 20 min (60-min threshold)", async () => {
    await seed({ id: "INC-2", severity: "sev3", lastUpdatedMinsAgo: 20, csl: "U_CSL" });
    const r = await sweepStakeholderReminders(env as any);
    expect(r.reminded).toBe(0);
    expect(fake.posted).toHaveLength(0);
  });

  it("nudges a SEV3 quiet for >60 min", async () => {
    await seed({ id: "INC-3", severity: "sev3", lastUpdatedMinsAgo: 75, csl: "U_CSL" });
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(1);
  });

  it("suppresses a re-nudge within a threshold window of the last reminder", async () => {
    // SEV1 (15m): quiet 40m but reminded 5m ago → still within window → skip.
    await seed({ id: "INC-4", severity: "sev1", lastUpdatedMinsAgo: 40, lastRemindedMinsAgo: 5, csl: "U_CSL" });
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(0);
  });

  it("re-nudges once the reminder window has elapsed", async () => {
    // SEV1 (15m): quiet 40m, last reminded 20m ago → window elapsed → nudge again.
    await seed({ id: "INC-5", severity: "sev1", lastUpdatedMinsAgo: 40, lastRemindedMinsAgo: 20, csl: "U_CSL" });
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(1);
  });

  it("falls back to the Engineering Lead, then @channel, when no CSL", async () => {
    await seed({ id: "INC-6", severity: "sev1", lastUpdatedMinsAgo: 20, el: "U_EL" });
    await sweepStakeholderReminders(env as any);
    expect(fake.posted[0].text).toContain("<@U_EL>");

    fake.posted.length = 0;
    await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = 'INC-6'").run();
    await env.DB.prepare("UPDATE incidents SET last_reminded_at = NULL WHERE id = 'INC-6'").run();
    await sweepStakeholderReminders(env as any);
    expect(fake.posted[0].text).toContain("<!channel>");
  });

  it("skips resolved incidents and incidents with no Slack channel", async () => {
    await seed({ id: "INC-7", severity: "sev1", status: "resolved", lastUpdatedMinsAgo: 60, csl: "U_CSL" });
    await seed({ id: "INC-8", severity: "sev1", lastUpdatedMinsAgo: 60, channel: null, csl: "U_CSL" });
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(0);
  });

  it("stamps last_reminded_at so the next immediate sweep is a no-op", async () => {
    await seed({ id: "INC-9", severity: "sev1", lastUpdatedMinsAgo: 20, csl: "U_CSL" });
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(1);
    // Immediately again: last_reminded_at just set → within window → no-op.
    expect((await sweepStakeholderReminders(env as any)).reminded).toBe(0);
  });
});
