import { useEffect, useState } from "react";

type Agent = { id: string; agent_name: string; created_at: string };

export function McpAgentSettings() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [newToken, setNewToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch("/api/settings/mcp-agents");
    if (!response.ok) throw new Error("Could not load agent tokens");
    setAgents((await response.json() as { agents: Agent[] }).agents);
  }
  useEffect(() => { void load().catch((e) => setError(String(e.message ?? e))); }, []);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNewToken("");
    try {
      const response = await fetch("/api/settings/mcp-agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_name: name }) });
      const result = await response.json() as { error?: string; token?: string };
      if (!response.ok || !result.token) throw new Error(result.error ?? "Could not create token");
      setNewToken(result.token); setName(""); await load();
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  }

  async function revoke(agent: Agent) {
    if (!window.confirm(`Revoke the token for ${agent.agent_name}? This takes effect immediately.`)) return;
    setError("");
    try {
      const response = await fetch(`/api/settings/mcp-agents/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not revoke token");
      await load();
    } catch (e) { setError(String((e as Error).message ?? e)); }
  }

  return <section className="space-y-5">
    <p className="text-sm text-muted-foreground">Create a separate credential for each MCP agent. Tokens are stored as hashes and shown only once when created. Revocation takes effect immediately.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {newToken && <div className="rounded-md border border-primary p-4"><p className="mb-2 text-sm font-medium">Copy this token now. It will not be shown again.</p><code className="block break-all text-sm">{newToken}</code><button className="mt-3 rounded border px-3 py-1 text-sm" onClick={() => setNewToken("")}>Dismiss</button></div>}
    <form className="flex flex-wrap gap-2" onSubmit={create}><label className="sr-only" htmlFor="agent-name">Agent name</label><input id="agent-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Agent name" className="h-9 rounded-md border bg-background px-3 text-sm"/><button disabled={busy} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">Create token</button></form>
    <div className="space-y-2">{agents.map((agent) => <div key={agent.id} className="flex items-center justify-between rounded-md border p-3"><div><p className="font-medium">{agent.agent_name}</p><p className="text-xs text-muted-foreground">Created {new Date(agent.created_at).toLocaleString()}</p></div><button onClick={() => void revoke(agent)} className="rounded-md border px-3 py-1.5 text-sm">Revoke</button></div>)}{agents.length === 0 && <p className="text-sm text-muted-foreground">No active agent tokens.</p>}</div>
  </section>;
}
