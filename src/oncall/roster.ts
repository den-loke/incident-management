/// <reference types="@cloudflare/workers-types" />
// On-call roster management — the engineering roster CRUD behind the web editor.
// See ROADMAP "On-call roster mgmt (engineering only)". The rotation ORDER is the
// responders' sort_order (generateShifts consumes it); support is always-on and
// has no rotation, so this manages the engineering roster only.
//
// After any roster change we clear FUTURE base (non-override) shifts and
// regenerate them, so the rotation reflects the new roster/order immediately.
// Past shifts and manual overrides are left untouched.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import type { Responder } from "./rotation";
import { generateShifts } from "./rotation";
import { resolveNames } from "../slack/directory";

export interface ResponderInput {
  id: string; // Slack user id (U…)
  name?: string; // optional; resolved from Slack when omitted
  phone?: string | null; // E.164 or null (Slack-only)
}

function isUserId(s: string): boolean {
  return /^[UW][A-Z0-9]{6,}$/.test(s);
}

/** All responders, active first then by rotation order. */
export async function listResponders(env: Env): Promise<Responder[]> {
  return new D1Db(env.DB).all<Responder>(
    "SELECT id, name, phone, active, sort_order FROM oncall_responders ORDER BY active DESC, sort_order, id",
  );
}

/**
 * Drop future base shifts and regenerate them from the current roster, so a
 * roster edit takes effect from the next changeover forward. Overrides and
 * already-started/past shifts are preserved.
 */
async function regenerateFutureShifts(env: Env): Promise<void> {
  const db = new D1Db(env.DB);
  const nowIso = new Date().toISOString();
  await db.run("DELETE FROM oncall_shifts WHERE is_override = 0 AND starts_at > ?", [nowIso]);
  await generateShifts(env);
}

/** Add (or upsert) a responder. Name is resolved from Slack when not given.
 * New responders go to the end of the rotation order. */
export async function addResponder(env: Env, input: ResponderInput): Promise<Responder> {
  if (!isUserId(input.id)) throw new Error("invalid_user_id");
  const db = new D1Db(env.DB);
  let name = input.name?.trim();
  if (!name) {
    const names = await resolveNames(env, [input.id]);
    name = names[input.id] ?? input.id;
  }
  const maxRow = await db.get<{ m: number }>("SELECT COALESCE(MAX(sort_order), -1) AS m FROM oncall_responders");
  const nextOrder = (maxRow?.m ?? -1) + 1;
  await db.run(
    "INSERT INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, ?, 1, ?) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, phone = excluded.phone, active = 1",
    [input.id, name, input.phone ?? null, nextOrder],
  );
  await regenerateFutureShifts(env);
  const row = await db.get<Responder>("SELECT id, name, phone, active, sort_order FROM oncall_responders WHERE id = ?", [input.id]);
  return row!;
}

/** Update a responder's name / phone / active flag. */
export async function updateResponder(
  env: Env,
  id: string,
  patch: { name?: string; phone?: string | null; active?: boolean },
): Promise<Responder | null> {
  const db = new D1Db(env.DB);
  const existing = await db.get<Responder>("SELECT id, name, phone, active, sort_order FROM oncall_responders WHERE id = ?", [id]);
  if (!existing) return null;
  const name = patch.name?.trim() || existing.name;
  const phone = patch.phone === undefined ? existing.phone : patch.phone;
  const active = patch.active === undefined ? existing.active : patch.active ? 1 : 0;
  await db.run("UPDATE oncall_responders SET name = ?, phone = ?, active = ? WHERE id = ?", [name, phone, active, id]);
  await regenerateFutureShifts(env);
  return db.get<Responder>("SELECT id, name, phone, active, sort_order FROM oncall_responders WHERE id = ?", [id]);
}

/** Remove a responder from the roster. Refuses to remove the LAST active one
 * (a rotation must keep at least one responder). Past shifts referencing them
 * remain (FK is by id; history is preserved). */
export async function removeResponder(env: Env, id: string): Promise<{ removed: boolean; reason?: string }> {
  const db = new D1Db(env.DB);
  const activeCount = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM oncall_responders WHERE active = 1");
  const target = await db.get<{ active: number }>("SELECT active FROM oncall_responders WHERE id = ?", [id]);
  if (!target) return { removed: false, reason: "not_found" };
  if (target.active === 1 && (activeCount?.n ?? 0) <= 1) {
    return { removed: false, reason: "min_one" }; // keep at least one active responder
  }
  // oncall_shifts.responder FKs oncall_responders(id): clear this responder's
  // shifts before removing them, else the delete fails the constraint. Overrides
  // and base shifts alike are removed; regenerate refills future base shifts.
  await db.run("DELETE FROM oncall_shifts WHERE responder = ?", [id]);
  await db.run("DELETE FROM oncall_responders WHERE id = ?", [id]);
  await regenerateFutureShifts(env);
  return { removed: true };
}

/** Set the full rotation order from an ordered list of responder ids. Ids not in
 * the list keep their relative order after the provided ones. */
export async function reorderResponders(env: Env, orderedIds: string[]): Promise<Responder[]> {
  const db = new D1Db(env.DB);
  let i = 0;
  for (const id of orderedIds) {
    await db.run("UPDATE oncall_responders SET sort_order = ? WHERE id = ?", [i, id]);
    i++;
  }
  await regenerateFutureShifts(env);
  return listResponders(env);
}
