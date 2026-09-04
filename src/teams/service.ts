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

export type TeamKey = "engineering" | "support" | "stakeholders";

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
  /** Slack usergroups.users.update → replace the usergroup's full member list. */
  setUsers(usergroupId: string, userIds: string[]): Promise<void>;
}

const SLACK_API = "https://slack.com/api";

class WebApiUsergroupClient implements UsergroupClient {
  constructor(private readonly botToken: string) {}
  // Slack's usergroups.* methods reject a JSON body (→ invalid_arguments); they
  // require application/x-www-form-urlencoded params. (Unlike chat.postMessage,
  // which does accept JSON.) So encode args as a form body.
  private async call<T>(method: string, params: Record<string, string>): Promise<T> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params).toString(),
    });
    const data = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!data.ok) throw new Error(`slack ${method} failed: ${data.error}`);
    return data as T;
  }
  async listUsers(usergroupId: string): Promise<string[]> {
    const data = await this.call<{ users?: string[] }>("usergroups.users.list", { usergroup: usergroupId });
    return data.users ?? [];
  }
  async setUsers(usergroupId: string, userIds: string[]): Promise<void> {
    // Slack requires a non-empty list; usergroups.users.update can't empty a
    // group. Callers guard against that (a group with one member stays).
    await this.call("usergroups.users.update", { usergroup: usergroupId, users: userIds.join(",") });
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
  stakeholders: "Stakeholders",
};

function usergroupIdFor(env: Env, key: TeamKey): string | null {
  const id =
    key === "engineering"
      ? env.TEAM_ENGINEERING_USERGROUP
      : key === "support"
        ? env.TEAM_SUPPORT_USERGROUP
        : env.TEAM_STAKEHOLDERS_USERGROUP;
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
  } catch (e) {
    // best-effort: leave members empty on failure, but surface why in logs.
    console.log(`[teams] listUsers(${usergroup_id}) failed for ${key}: ${String(e)}`);
  }
  return base;
}

/** All fixed teams, resolved. Used by the web Teams view. */
export async function resolveTeams(env: Env): Promise<Team[]> {
  return [
    await resolveTeam(env, "engineering"),
    await resolveTeam(env, "support"),
    await resolveTeam(env, "stakeholders"),
  ];
}

/** Is a Slack user a member of the given team's linked group? False when unconfigured. */
export async function isTeamMember(env: Env, key: TeamKey, userId: string): Promise<boolean> {
  const team = await resolveTeam(env, key);
  return team.members.includes(userId);
}

/** The configured Stakeholders usergroup id, or null when unset. */
export function stakeholdersUsergroupId(env: Env): string | null {
  return usergroupIdFor(env, "stakeholders");
}

/**
 * Add or remove a user from the Stakeholders Slack usergroup (needs the
 * `usergroups:write` scope). Read-modify-write on the current member list.
 * Returns true if a write happened, false if the group is unconfigured or the
 * change was a no-op. Guards Slack's "can't empty a group" rule: a remove that
 * would leave zero members is refused (returns false) so the caller can fall
 * back to the local opt-in list.
 */
export async function setStakeholderMembership(
  env: Env,
  userId: string,
  member: boolean,
): Promise<boolean> {
  const usergroup = stakeholdersUsergroupId(env);
  if (!usergroup) return false;
  const client = clientFor(env);
  const current = await client.listUsers(usergroup);
  const has = current.includes(userId);
  if (member === has) return false; // already in the desired state
  const next = member ? [...current, userId] : current.filter((u) => u !== userId);
  if (next.length === 0) return false; // Slack can't store an empty usergroup
  await client.setUsers(usergroup, next);
  return true;
}
