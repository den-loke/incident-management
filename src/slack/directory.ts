/// <reference types="@cloudflare/workers-types" />
// Slack user directory — a DURABLE pull-through cache of user id → display name
// for the web UI (which, unlike Slack surfaces, can't auto-render <@U…>).
//
// Why persist (D1, not just an isolate cache): incidents reference user ids
// (roles, acked_by, escalation targets) forever. If that person later LEAVES the
// workspace, Slack's users.list no longer returns them — but we still want the
// historical incident to show their NAME. So every id→name we resolve is upserted
// into `slack_users` (migration 0014) and survives the user leaving.
//
// resolveNames(ids): serve known ids from D1; for any MISSING (or stale) id, fetch
// from Slack (users.list, paginated, form-encoded — Slack rejects a JSON body),
// upsert the freshly-seen names, and return the merged map. Unknown even after a
// Slack fetch → fall back to the raw id (never throws). Needs `users:read`.

import type { Env } from "../env";
import { D1Db } from "../status/d1";

const SLACK_API = "https://slack.com/api";
const STALE_MS = 24 * 60 * 60 * 1000; // refresh a cached name at most daily

interface SlackMember {
  id: string;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string };
  real_name?: string;
  name?: string;
}

// Test seam: override the Slack fetch with a fake id→name map.
let fetchOverride: ((env: Env) => Promise<Record<string, string>>) | null = null;
export function __setDirectoryFetch(f: ((env: Env) => Promise<Record<string, string>>) | null): void {
  fetchOverride = f;
}

function pickName(m: SlackMember): string {
  return (
    m.profile?.display_name?.trim() ||
    m.profile?.real_name?.trim() ||
    m.real_name?.trim() ||
    m.name?.trim() ||
    m.id
  );
}

/** Full workspace directory from Slack (id→name). Best-effort; may throw. */
async function fetchFromSlack(env: Env): Promise<Record<string, string>> {
  if (fetchOverride) return fetchOverride(env);
  const names: Record<string, string> = {};
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SLACK_API}/users.list`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: params.toString(),
    });
    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      members?: SlackMember[];
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) throw new Error(`slack users.list failed: ${data.error}`);
    for (const m of data.members ?? []) {
      if (!m.deleted) names[m.id] = pickName(m);
    }
    cursor = data.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return names;
}

/** Read cached names for the given ids from D1. */
async function readCache(db: D1Db, ids: string[]): Promise<Map<string, { name: string; at: number }>> {
  const out = new Map<string, { name: string; at: number }>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(",");
  const rows = await db.all<{ slack_user_id: string; display_name: string; updated_at: string }>(
    `SELECT slack_user_id, display_name, updated_at FROM slack_users WHERE slack_user_id IN (${placeholders})`,
    ids,
  );
  for (const r of rows) out.set(r.slack_user_id, { name: r.display_name, at: new Date(r.updated_at).getTime() });
  return out;
}

/** Upsert freshly-seen id→name pairs into the durable cache. */
async function writeCache(db: D1Db, names: Record<string, string>): Promise<void> {
  const now = new Date().toISOString();
  for (const [id, name] of Object.entries(names)) {
    await db.run(
      "INSERT INTO slack_users (slack_user_id, display_name, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(slack_user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at",
      [id, name, now],
    );
  }
}

/**
 * Resolve user ids to display names via the durable pull-through cache.
 * - Serve ids present + fresh in D1 directly.
 * - If any requested id is missing or stale, fetch the workspace directory from
 *   Slack, upsert it, and merge.
 * - Any id still unknown (never seen, or a Slack failure) falls back to itself.
 * Never throws. A departed user keeps their last-known cached name.
 */
export async function resolveNames(env: Env, ids: Iterable<string>): Promise<Record<string, string>> {
  const wanted = Array.from(new Set([...ids].filter(Boolean)));
  const out: Record<string, string> = {};
  if (wanted.length === 0) return out;

  const db = new D1Db(env.DB);
  const cached = await readCache(db, wanted);
  const now = Date.now();
  const missingOrStale = wanted.filter((id) => {
    const hit = cached.get(id);
    return !hit || now - hit.at > STALE_MS;
  });

  if (missingOrStale.length > 0) {
    try {
      const fresh = await fetchFromSlack(env);
      if (Object.keys(fresh).length > 0) {
        await writeCache(db, fresh);
        for (const [id, name] of Object.entries(fresh)) cached.set(id, { name, at: now });
      }
    } catch {
      /* best-effort: keep whatever the cache had, fall back to id below */
    }
  }

  for (const id of wanted) out[id] = cached.get(id)?.name ?? id;
  return out;
}
