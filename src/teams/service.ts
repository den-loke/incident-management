/// <reference types="@cloudflare/workers-types" />
// Response teams = linked Slack user groups. See ROADMAP → "Response teams =
// linked Slack user groups (NOT a team-management UI)".
//
// incident.io has a Teams management surface (create teams, add/remove members).
// We are single-tenant and Slack-native: a "team" is just a pointer to a Slack
// **user group** whose membership is managed IN SLACK. We store one usergroup id
// per fixed team (Engineering, Support) as config and resolve eligible members on
// demand via `usergroups.users.list`. No membership CRUD in our app.

import type { Env } from "../env";

export type TeamKey = "engineering" | "support";

export interface Team {
  key: TeamKey;
  label: string;
  usergroup_id: string | null; // configured Slack usergroup id, or null if unset
  members: string[]; // Slack user ids (empty when unconfigured or on lookup failure)
  configured: boolean;
}

/** Minimal Slack surface this module needs — injectable for tests. */
export interface UsergroupClient {
  /** Slack usergroups.users.list → member user ids for a usergroup. */
  listUsers(usergroupId: string): Promise<string[]>;
}

const SLACK_API = "https://slack.com/api";

class WebApiUsergroupClient implements UsergroupClient {
  constructor(private readonly botToken: string) {}
  async listUsers(usergroupId: string): Promise<string[]> {
    const res = await fetch(`${SLACK_API}/usergroups.users.list`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ usergroup: usergroupId }),
    });
    const data = (await res.json()) as { ok: boolean; error?: string; users?: string[] };
    if (!data.ok) throw new Error(`slack usergroups.users.list failed: ${data.error}`);
    return data.users ?? [];
  }
}

// Test seam: override the usergroup client (mirrors the other __set*Client seams).
let clientOverride: UsergroupClient | null = null;
export function __setUsergroupClient(client: UsergroupClient | null): void {
  clientOverride = client;
}
function clientFor(env: Env): UsergroupClient {
  return clientOverride ?? new WebApiUsergroupClient(env.SLACK_BOT_TOKEN);
}

const TEAM_LABELS: Record<TeamKey, string> = {
  engineering: "Engineering",
  support: "Customer Support",
};

function usergroupIdFor(env: Env, key: TeamKey): string | null {
  const id = key === "engineering" ? env.TEAM_ENGINEERING_USERGROUP : env.TEAM_SUPPORT_USERGROUP;
  return id && id.trim() ? id.trim() : null;
}

/**
 * Resolve one team: its configured usergroup id + current members. An unconfigured
 * team (no id) resolves to an empty roster with `configured:false` — never an
 * error. A Slack lookup failure is swallowed to an empty roster (best-effort read;
 * eligibility should not hard-fail incident flows).
 */
export async function resolveTeam(env: Env, key: TeamKey): Promise<Team> {
  const usergroup_id = usergroupIdFor(env, key);
  const base: Team = { key, label: TEAM_LABELS[key], usergroup_id, members: [], configured: usergroup_id !== null };
  if (!usergroup_id) return base;
  try {
    base.members = await clientFor(env).listUsers(usergroup_id);
  } catch {
    // best-effort: leave members empty on failure
  }
  return base;
}

/** Both fixed teams, resolved. Used by the web Teams view. */
export async function resolveTeams(env: Env): Promise<Team[]> {
  return [await resolveTeam(env, "engineering"), await resolveTeam(env, "support")];
}

/** Is a Slack user a member of the given team's linked group? False when unconfigured. */
export async function isTeamMember(env: Env, key: TeamKey, userId: string): Promise<boolean> {
  const team = await resolveTeam(env, key);
  return team.members.includes(userId);
}
