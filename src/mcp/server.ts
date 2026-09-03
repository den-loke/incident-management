/// <reference types="@cloudflare/workers-types" />
// MCP connector (analytics-first, read-only). See ROADMAP → "MCP connector for
// Claude". Exposes the tool's REPORTING/ANALYTICS surface over MCP-over-HTTP so
// Claude (or any MCP client) can query it in natural language: "how many
// incidents last quarter?", "which severities dominate?", "what's the action-item
// backlog?", "show me open follow-ups / past incidents".
//
// Deliberately minimal & self-contained: a small JSON-RPC 2.0 handler for the
// core MCP methods (initialize / tools/list / tools/call) over a single POST /mcp
// endpoint — no SDK dependency (single-tenant, opinionated). All tools are
// READ-ONLY analytics; no declare/update/resolve here (live-response tools are a
// deliberate later, secondary addition). Bearer-token auth via MCP_TOKEN.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { buildReport, periodWindow } from "../reporting/service";
import { buildInsights } from "../reporting/insights";
import { listFollowUps, listIncidentHistory } from "../reporting/followups";
import type { IncidentSeverity, RoutingPath } from "../status/types";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "incident-management", version: "1.0.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type ToolHandler = (env: Env, args: Record<string, unknown>) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const PERIOD_SCHEMA = {
  type: "string",
  enum: ["7d", "30d", "90d", "all"],
  description: "Time window (default 30d).",
};

function period(args: Record<string, unknown>): string {
  const p = typeof args.period === "string" ? args.period : "30d";
  return ["7d", "30d", "90d", "all"].includes(p) ? p : "30d";
}

/** All read-only analytics tools. */
export const MCP_TOOLS: ToolDef[] = [
  {
    name: "get_report",
    description:
      "Aggregate incident metrics over a period: opened, resolved, open-now, MTTR, MTTA proxy, open action-item backlog.",
    inputSchema: { type: "object", properties: { period: PERIOD_SCHEMA } },
    handler: async (env, args) => {
      const { from, to } = periodWindow(period(args));
      return buildReport(new D1Db(env.DB), from, to);
    },
  },
  {
    name: "get_insights",
    description:
      "Analytics breakdowns over a period: incident volume by severity, by routing path, a monthly opened/resolved trend, MTTR per bucket, and the open action-item backlog.",
    inputSchema: { type: "object", properties: { period: PERIOD_SCHEMA } },
    handler: async (env, args) => {
      const { from, to } = periodWindow(period(args));
      return buildInsights(new D1Db(env.DB), from, to);
    },
  },
  {
    name: "list_follow_ups",
    description:
      "Cross-incident follow-up action items (open/done, owner, linked Jira key, which incident). Defaults to open-only.",
    inputSchema: {
      type: "object",
      properties: { open_only: { type: "boolean", description: "Only outstanding items (default true)." } },
    },
    handler: async (env, args) => {
      const onlyOpen = args.open_only !== false;
      return { follow_ups: await listFollowUps(new D1Db(env.DB), onlyOpen) };
    },
  },
  {
    name: "list_incidents",
    description:
      "Browsable incident history, newest first, each with severity, routing path, has-postmortem, and open-action count. Optional severity/routing_path filters.",
    inputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["sev1", "sev2", "sev3"] },
        routing_path: { type: "string", enum: ["internal", "external"] },
        limit: { type: "number", description: "Max rows (default 100)." },
      },
    },
    handler: async (env, args) => {
      const sev = args.severity;
      const rp = args.routing_path;
      return {
        incidents: await listIncidentHistory(new D1Db(env.DB), {
          severity: sev === "sev1" || sev === "sev2" || sev === "sev3" ? (sev as IncidentSeverity) : undefined,
          routing_path: rp === "internal" || rp === "external" ? (rp as RoutingPath) : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      };
    },
  },
];

const TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));

function rpcResult(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}
function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

/** Dispatch one JSON-RPC request against the MCP surface. Returns the response
 * object, or null for a notification (no id → no reply). */
export async function dispatchMcp(env: Env, req: JsonRpcRequest): Promise<object | null> {
  const isNotification = req.id === undefined || req.id === null;
  switch (req.method) {
    case "initialize":
      return rpcResult(req.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null; // notification, no reply
    case "ping":
      return rpcResult(req.id, {});
    case "tools/list":
      return rpcResult(req.id, {
        tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = typeof req.params?.name === "string" ? req.params.name : "";
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return rpcError(req.id, -32602, `unknown tool: ${name}`);
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const data = await tool.handler(env, args);
        // MCP tool result: content array. We return the JSON as text content.
        return rpcResult(req.id, {
          content: [{ type: "text", text: JSON.stringify(data) }],
          isError: false,
        });
      } catch (e) {
        return rpcResult(req.id, {
          content: [{ type: "text", text: `error: ${(e as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(req.id, -32601, `method not found: ${req.method}`);
  }
}

/** Bearer-token check for POST /mcp. False when MCP_TOKEN is unset (disabled). */
export function verifyMcpAuth(headers: Headers, token: string | undefined): boolean {
  if (!token) return false;
  const auth = headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}
