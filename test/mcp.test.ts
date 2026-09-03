import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "e2e-mcp-token"; // matches vitest.config.ts binding

async function rpc(body: unknown, token: string | null = TOKEN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return SELF.fetch("https://x/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

describe("MCP connector (/mcp)", () => {
  it("rejects a missing/wrong bearer token", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, null)).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, "nope")).status).toBe(401);
  });

  it("initialize returns protocol + serverInfo", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("incident-management");
    expect(typeof body.result.protocolVersion).toBe("string");
  });

  it("tools/list advertises the four read-only analytics tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_insights", "get_report", "list_follow_ups", "list_incidents"]);
  });

  it("tools/call get_report returns JSON text content", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_report", arguments: { period: "all" } },
    });
    const body = (await res.json()) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(false);
    const parsed = JSON.parse(body.result.content[0].text) as { opened: number; open_now: number };
    expect(typeof parsed.opened).toBe("number");
    expect(typeof parsed.open_now).toBe("number");
  });

  it("tools/call list_incidents accepts filters", async () => {
    const res = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "list_incidents", arguments: { severity: "sev1", limit: 5 } },
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0].text) as { incidents: unknown[] };
    expect(Array.isArray(parsed.incidents)).toBe(true);
  });

  it("unknown tool → JSON-RPC error; unknown method → method-not-found", async () => {
    const t = (await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } })).json()) as {
      error?: { code: number };
    };
    expect(t.error?.code).toBe(-32602);
    const m = (await (await rpc({ jsonrpc: "2.0", id: 6, method: "bogus/method" })).json()) as { error?: { code: number } };
    expect(m.error?.code).toBe(-32601);
  });

  it("a notification (no id) gets a 204 and no body", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(204);
  });

  it("handles a JSON-RPC batch, dropping notification replies", async () => {
    const res = await rpc([
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 11, method: "ping" },
    ]);
    const arr = (await res.json()) as { id: number }[];
    expect(arr.map((r) => r.id).sort()).toEqual([10, 11]); // notification produced no reply
  });
});
