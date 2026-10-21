/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../env";
import { D1Db } from "../status/d1";

const encoder = new TextEncoder();

async function digest(token: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AgentToken { id: string; agent_name: string; created_at: string }

export async function authenticateAgent(env: Env, token: string): Promise<AgentToken | null> {
  const tokenHash = await digest(token);
  return new D1Db(env.DB).get<AgentToken>(
    "SELECT id, agent_name, created_at FROM mcp_agent_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    [tokenHash],
  );
}

export async function listAgentTokens(env: Env): Promise<AgentToken[]> {
  return new D1Db(env.DB).all<AgentToken>(
    "SELECT id, agent_name, created_at FROM mcp_agent_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC",
  );
}

export async function createAgentToken(env: Env, agentName: string): Promise<{ token: string; agent: AgentToken }> {
  const token = `imcp_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const agent = { id: crypto.randomUUID(), agent_name: agentName, created_at: new Date().toISOString() };
  await new D1Db(env.DB).run(
    "INSERT INTO mcp_agent_tokens (id, agent_name, token_hash) VALUES (?, ?, ?)",
    [agent.id, agentName, await digest(token)],
  );
  return { token, agent };
}

export async function revokeAgentToken(env: Env, id: string): Promise<boolean> {
  const db = new D1Db(env.DB);
  const found = await db.get<{ id: string }>("SELECT id FROM mcp_agent_tokens WHERE id = ? AND revoked_at IS NULL", [id]);
  if (!found) return false;
  await db.run("UPDATE mcp_agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?", [id]);
  return true;
}
