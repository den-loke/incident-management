/// <reference types="@cloudflare/workers-types" />
// On-call rotation. See docs/SPEC_ONCALL.md §2.
//
// One opinionated shape: weekly hand-off (ONCALL_ROTATION_DAYS, default 7),
// changeover Monday 10:00 in ONCALL_TZ (default Australia/Melbourne), round-robin
// over active responders ordered by sort_order then id. Shifts are materialised
// ahead by a daily cron so "who is on call now/next" is a single indexed read;
// overrides are is_override=1 rows that win over the base rotation.

import type { Env } from "../env";
import { D1Db } from "../status/d1";

const DEFAULT_TZ = "Australia/Melbourne";
const DEFAULT_ROTATION_DAYS = 7;
const CHANGEOVER_DOW = 1; // Monday (0=Sun..6=Sat)
const CHANGEOVER_HOUR = 10; // 10:00 local
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Responder {
  id: string;
  name: string;
  phone: string | null;
  active: number;
  sort_order: number;
}

export interface Shift {
  id: string;
  responder: string;
  starts_at: string;
  ends_at: string;
  is_override: number;
}

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function tz(env: Env): string {
  return env.ONCALL_TZ || DEFAULT_TZ;
}
function rotationDays(env: Env): number {
  const n = Number(env.ONCALL_ROTATION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ROTATION_DAYS;
}

/**
 * The wall-clock parts of an instant, rendered in a given IANA timezone.
 * Uses Intl (full ICU is available in Workers) so we need no tz dependency.
 */
function partsInTz(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value;
  const dowMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour === "24" ? "0" : p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    dow: dowMap[p.weekday],
  };
}

/**
 * The UTC instant of the most recent changeover (Monday CHANGEOVER_HOUR local,
 * in `timeZone`) at or before `at`. Robust across DST because we re-derive the
 * local wall-clock of a candidate instant and step by whole days.
 */
function lastChangeoverBefore(at: Date, timeZone: string): Date {
  const p = partsInTz(at, timeZone);
  // Days since the last Monday (in local wall-clock terms).
  let daysSinceMon = (p.dow - CHANGEOVER_DOW + 7) % 7;
  // If today is the changeover day but before the hour, the changeover was a week ago.
  if (daysSinceMon === 0 && p.hour < CHANGEOVER_HOUR) daysSinceMon = 7;

  // Start from `at`, walk back to the target local date, then pin the hour.
  // We approximate the local midnight of the target day, then binary-adjust the
  // hour by comparing rendered local hour to CHANGEOVER_HOUR.
  const target = new Date(at.getTime() - daysSinceMon * DAY_MS);
  // Snap to local CHANGEOVER_HOUR:00 on the target local day.
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const gp = partsInTz(guess, timeZone);
    const deltaHours = gp.hour - CHANGEOVER_HOUR;
    const deltaMin = gp.minute;
    const deltaSec = gp.second;
    guess = new Date(
      guess.getTime() -
        deltaHours * 3600 * 1000 -
        deltaMin * 60 * 1000 -
        deltaSec * 1000,
    );
    const check = partsInTz(guess, timeZone);
    if (check.hour === CHANGEOVER_HOUR && check.minute === 0 && check.second === 0)
      break;
  }
  // Zero any residual sub-second so the anchor (and thus starts_at) is stable
  // across cron runs — this is what makes generateShifts idempotent.
  guess = new Date(Math.floor(guess.getTime() / 1000) * 1000);
  return guess;
}

async function activeResponders(db: D1Db): Promise<Responder[]> {
  return db.all<Responder>(
    "SELECT id, name, phone, active, sort_order FROM oncall_responders WHERE active = 1 ORDER BY sort_order, id",
  );
}

/**
 * Ensure base (non-override) shifts exist from the current changeover forward
 * `weeksAhead` windows. Idempotent: only inserts a window that does not already
 * have a base shift starting at that instant. Safe to re-run (cron discipline).
 */
export async function generateShifts(
  env: Env,
  weeksAhead = 4,
  now: Date = new Date(),
): Promise<{ inserted: number }> {
  const db = new D1Db(env.DB);
  const responders = await activeResponders(db);
  if (responders.length === 0) return { inserted: 0 };

  const days = rotationDays(env);
  const start = lastChangeoverBefore(now, tz(env));

  // Anchor the round-robin deterministically to the epoch so re-runs and future
  // windows keep the same responder ordering regardless of when cron fires.
  const windowIndexAtStart = Math.floor(start.getTime() / (days * DAY_MS));

  let inserted = 0;
  for (let w = 0; w < weeksAhead; w++) {
    const s = new Date(start.getTime() + w * days * DAY_MS);
    const e = new Date(s.getTime() + days * DAY_MS);
    const startsAt = s.toISOString();

    const existing = await db.get<{ id: string }>(
      "SELECT id FROM oncall_shifts WHERE starts_at = ? AND is_override = 0",
      [startsAt],
    );
    if (existing) continue;

    const idx = (windowIndexAtStart + w) % responders.length;
    const responder = responders[((idx % responders.length) + responders.length) % responders.length];
    await db.run(
      "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 0)",
      [uid("shift"), responder.id, startsAt, e.toISOString()],
    );
    inserted++;
  }
  return { inserted };
}

/**
 * Insert a manual override shift. Overrides win over the base rotation for any
 * instant they cover (see whoIsOnCall).
 */
export async function setOverride(
  env: Env,
  responder: string,
  startsAt: string,
  endsAt: string,
): Promise<string> {
  const db = new D1Db(env.DB);
  const id = uid("shift");
  await db.run(
    "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 1)",
    [id, responder, startsAt, endsAt],
  );
  return id;
}

/**
 * Who is on call at `at`. An override covering `at` wins; otherwise the base
 * shift covering `at`. Returns null when nobody is scheduled (empty rotation) —
 * callers must handle this without deadlocking (fallback channel, skip escalation).
 */
export async function whoIsOnCall(
  env: Env,
  at: Date = new Date(),
): Promise<Responder | null> {
  const db = new D1Db(env.DB);
  const iso = at.toISOString();
  const shift = await db.get<{ responder: string }>(
    `SELECT responder FROM oncall_shifts
      WHERE starts_at <= ? AND ends_at > ?
      ORDER BY is_override DESC, starts_at DESC
      LIMIT 1`,
    [iso, iso],
  );
  if (!shift) return null;
  return db.get<Responder>(
    "SELECT id, name, phone, active, sort_order FROM oncall_responders WHERE id = ?",
    [shift.responder],
  );
}

/**
 * The next responder in rotation order after `current` — the level-1 backstop.
 * Round-robins over active responders; returns null if there is 0/1 responder.
 */
export async function nextResponder(
  env: Env,
  currentId: string,
): Promise<Responder | null> {
  const db = new D1Db(env.DB);
  const responders = await activeResponders(db);
  if (responders.length < 2) return null;
  const i = responders.findIndex((r) => r.id === currentId);
  if (i < 0) return responders[0];
  return responders[(i + 1) % responders.length];
}
