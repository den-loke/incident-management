import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateShifts,
  setOverride,
  whoIsOnCall,
  nextResponder,
} from "../src/oncall/rotation";

// Unique per-file ids so this shares the pool-wide D1 without colliding.
const R = {
  a: "U_rot_alice",
  b: "U_rot_bob",
  c: "U_rot_carol",
};
const ALL = Object.values(R);

async function seedResponders() {
  let i = 0;
  for (const id of ALL) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, NULL, 1, ?)",
    )
      .bind(id, id, i++)
      .run();
  }
}

async function clean() {
  // Scope every delete to this file's responders / their shifts.
  const placeholders = ALL.map(() => "?").join(",");
  await env.DB.prepare(
    `DELETE FROM oncall_shifts WHERE responder IN (${placeholders})`,
  )
    .bind(...ALL)
    .run();
  await env.DB.prepare(
    `DELETE FROM oncall_responders WHERE id IN (${placeholders})`,
  )
    .bind(...ALL)
    .run();
}

describe("on-call rotation", () => {
  beforeEach(async () => {
    await clean();
    await seedResponders();
  });
  afterEach(clean);

  it("generateShifts materialises windows ahead and is idempotent", async () => {
    const first = await generateShifts(env as any, 4);
    expect(first.inserted).toBe(4);

    // Re-run: no new base windows inserted.
    const second = await generateShifts(env as any, 4);
    expect(second.inserted).toBe(0);

    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM oncall_shifts WHERE is_override = 0 AND responder IN (?,?,?)`,
    )
      .bind(...ALL)
      .first<{ n: number }>();
    expect(rows?.n).toBe(4);
  });

  it("whoIsOnCall returns the responder covering an instant", async () => {
    await generateShifts(env as any, 4);
    const oc = await whoIsOnCall(env as any, new Date());
    expect(oc).not.toBeNull();
    expect(ALL).toContain(oc!.id);
  });

  it("an override wins over the base shift for the covered instant", async () => {
    await generateShifts(env as any, 4);
    const at = new Date();
    const base = await whoIsOnCall(env as any, at);
    // Pick a responder different from the base holder.
    const other = ALL.find((id) => id !== base!.id)!;
    const from = new Date(at.getTime() - 3600_000).toISOString();
    const to = new Date(at.getTime() + 3600_000).toISOString();
    await setOverride(env as any, other, from, to);

    const now = await whoIsOnCall(env as any, at);
    expect(now!.id).toBe(other);
  });

  it("whoIsOnCall returns null on an empty rotation (no deadlock)", async () => {
    await clean(); // no responders, no shifts
    const oc = await whoIsOnCall(env as any, new Date());
    expect(oc).toBeNull();
    // generateShifts also no-ops rather than erroring.
    const g = await generateShifts(env as any, 4);
    expect(g.inserted).toBe(0);
    await seedResponders(); // restore for afterEach symmetry
  });

  it("nextResponder round-robins over active responders", async () => {
    // Ordered by sort_order: alice(0), bob(1), carol(2).
    expect((await nextResponder(env as any, R.a))!.id).toBe(R.b);
    expect((await nextResponder(env as any, R.b))!.id).toBe(R.c);
    expect((await nextResponder(env as any, R.c))!.id).toBe(R.a); // wraps
  });
});
