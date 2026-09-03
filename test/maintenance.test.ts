import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scheduleMaintenance,
  listMaintenance,
  cancelMaintenance,
  reconcileMaintenance,
} from "../src/maintenance/service";

const COMP = "cmp_maint_test";

async function seedComponent() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO components (id, name, status) VALUES (?, 'Maint Test', 'operational')",
  ).bind(COMP).run();
}
async function compStatus(): Promise<string> {
  const r = await env.DB.prepare("SELECT status FROM components WHERE id = ?").bind(COMP).first<{ status: string }>();
  return r?.status ?? "";
}
async function clean() {
  await env.DB.prepare("DELETE FROM maintenance_windows WHERE title LIKE 'MW_%'").run();
  await env.DB.prepare("DELETE FROM components WHERE id = ?").bind(COMP).run();
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe("scheduled maintenance", () => {
  beforeEach(async () => {
    await clean();
    await seedComponent();
  });
  afterEach(clean);

  it("schedules a window (status scheduled) and lists it", async () => {
    const w = await scheduleMaintenance(env as any, {
      title: "MW_future",
      components: [COMP],
      starts_at: iso(3600_000),
      ends_at: iso(7200_000),
    });
    expect(w.status).toBe("scheduled");
    const list = await listMaintenance(env as any);
    expect(list.some((x) => x.id === w.id)).toBe(true);
  });

  it("reconcile activates a window whose start has passed and flips components", async () => {
    const w = await scheduleMaintenance(env as any, {
      title: "MW_active",
      components: [COMP],
      starts_at: iso(-60_000), // started a minute ago
      ends_at: iso(3600_000), // ends in an hour
    });
    const r = await reconcileMaintenance(env as any);
    expect(r.activated).toBeGreaterThanOrEqual(1);
    expect(await compStatus()).toBe("under_maintenance");
    const list = await listMaintenance(env as any);
    expect(list.find((x) => x.id === w.id)?.status).toBe("active");
  });

  it("reconcile completes a window whose end has passed and restores components", async () => {
    await env.DB.prepare("UPDATE components SET status = 'under_maintenance' WHERE id = ?").bind(COMP).run();
    const w = await scheduleMaintenance(env as any, {
      title: "MW_done",
      components: [COMP],
      starts_at: iso(-7200_000),
      ends_at: iso(-60_000), // ended a minute ago
    });
    // it's still 'scheduled' in the row; reconcile should complete it directly.
    const r = await reconcileMaintenance(env as any);
    expect(r.completed).toBeGreaterThanOrEqual(1);
    expect(await compStatus()).toBe("operational");
    const list = await listMaintenance(env as any);
    // completed windows drop out of the active filter used by the section, but
    // listMaintenance returns them too (ordered after active).
    expect(list.find((x) => x.id === w.id)?.status).toBe("completed");
  });

  it("cancel restores components on an active window", async () => {
    const w = await scheduleMaintenance(env as any, {
      title: "MW_cancel",
      components: [COMP],
      starts_at: iso(-60_000),
      ends_at: iso(3600_000),
    });
    await reconcileMaintenance(env as any); // → active, component under_maintenance
    expect(await compStatus()).toBe("under_maintenance");
    const ok = await cancelMaintenance(env as any, w.id);
    expect(ok).toBe(true);
    expect(await compStatus()).toBe("operational");
  });

  it("reconcile is idempotent (no double-activate)", async () => {
    await scheduleMaintenance(env as any, {
      title: "MW_idem",
      components: [COMP],
      starts_at: iso(-60_000),
      ends_at: iso(3600_000),
    });
    await reconcileMaintenance(env as any);
    const second = await reconcileMaintenance(env as any);
    expect(second.activated).toBe(0);
  });
});
