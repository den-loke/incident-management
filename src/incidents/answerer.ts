/// <reference types="@cloudflare/workers-types" />
// Agentic @-mention answering. The classifier (intent.ts) handles MUTATING
// instructions (update / status / severity / escalate / resolve) determinis-
// tically. Everything else — questions like "who's the eng lead?", "when did
// this start?", "what's the on-call?", "how bad is it?", "what's happened so
// far?" — used to fall to a single canned "I didn't catch that" reply. This is
// what made the bot feel non-agentic.
//
// This module answers those questions in natural language, GROUNDED in the
// incident's real state (status, severity, roles, timeline, durations, on-call)
// so the bot is a genuine assistant in-channel, not a command parser with a
// help string. Injectable like the Summarizer/Classifier so tests are offline
// and deterministic.

import type { Env } from "../env";
import { D1Db } from "../status/d1";
import { getIncidentDetail } from "./read";
import { RoleStore } from "../roles/store";
import { ROLE_LABEL, type IncidentRole } from "../roles/types";
import { SEVERITY_LABEL } from "../status/types";
import { deriveDurationsSeconds } from "./durations";

const OPENAI_API = "https://api.openai.com/v1/chat/completions";

/** A compact, fully-grounded snapshot of one incident for the answerer. */
export interface IncidentContext {
  incidentId: string;
  name: string;
  status: string;
  severity: string;
  routingPath: string;
  createdAt: string;
  resolvedAt: string | null;
  roles: { role: string; holder: string }[];
  onCall: string | null;
  durations: {
    total_seconds: number | null;
    time_to_identify_seconds: number | null;
    time_to_resolve_seconds: number | null;
  };
  timeline: { at: string; status: string; body: string }[];
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "n/a";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Build the grounded context for an incident. Null if the incident is unknown. */
export async function buildIncidentContext(
  env: Env,
  incidentId: string,
): Promise<IncidentContext | null> {
  const detail = await getIncidentDetail(env, incidentId);
  if (!detail) return null;

  const db = new D1Db(env.DB);
  const roleRows = await new RoleStore(db).list(incidentId);
  const roles = roleRows.map((r) => ({
    role: ROLE_LABEL[r.role as IncidentRole] ?? r.role,
    holder: r.slack_user_id,
  }));

  // On-call is best-effort context; a missing rotation must not fail an answer.
  let onCall: string | null = null;
  try {
    const { whoIsOnCall } = await import("../oncall/rotation");
    const r = await whoIsOnCall(env);
    onCall = r?.name ?? null;
  } catch {
    /* no rotation configured — leave null */
  }

  return {
    incidentId: detail.id,
    name: detail.name,
    status: detail.status,
    severity: SEVERITY_LABEL[detail.severity] ?? detail.severity,
    routingPath: (detail as { routing_path?: string }).routing_path ?? "internal",
    createdAt: detail.created_at,
    resolvedAt: detail.resolved_at ?? null,
    roles,
    onCall,
    durations: deriveDurationsSeconds(detail),
    timeline: detail.updates.map((u) => ({
      at: u.created_at,
      status: u.status,
      body: u.body,
    })),
  };
}

/** Render the context as a compact text block for the model / the fake. */
export function renderContext(ctx: IncidentContext): string {
  const roleLines = ctx.roles.length
    ? ctx.roles.map((r) => `  ${r.role}: <@${r.holder}>`).join("\n")
    : "  (none claimed)";
  const timeline = ctx.timeline.length
    ? ctx.timeline.map((t) => `  [${t.at}] (${t.status}) ${t.body}`).join("\n")
    : "  (no updates yet)";
  return [
    `Incident ${ctx.incidentId}: ${ctx.name}`,
    `Status: ${ctx.status}`,
    `Severity: ${ctx.severity}`,
    `Routing: ${ctx.routingPath}`,
    `Declared: ${ctx.createdAt}`,
    `Resolved: ${ctx.resolvedAt ?? "not resolved"}`,
    `On-call: ${ctx.onCall ?? "no rotation configured"}`,
    `Time to identify: ${fmtDuration(ctx.durations.time_to_identify_seconds)}`,
    `Time to resolve: ${fmtDuration(ctx.durations.time_to_resolve_seconds)}`,
    `Total duration: ${fmtDuration(ctx.durations.total_seconds)}`,
    `Roles:\n${roleLines}`,
    `Timeline:\n${timeline}`,
  ].join("\n");
}

export interface IncidentAnswerer {
  /** Answer a natural-language question grounded in the incident context. */
  answer(question: string, ctx: IncidentContext): Promise<string>;
}

/** Real OpenAI-backed answerer. Falls back to a deterministic summary on error. */
export class OpenAiIncidentAnswerer implements IncidentAnswerer {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async answer(question: string, ctx: IncidentContext): Promise<string> {
    try {
      const res = await fetch(OPENAI_API, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You are the incident bot for a Slack incident channel. Answer the " +
                "responder's question about THIS incident, using ONLY the context " +
                "provided. Be concise (1-3 sentences), factual, and never invent " +
                "facts that are not in the context. If the context does not contain " +
                "the answer, say so briefly and suggest what you CAN do (post an " +
                "update, change status/severity, escalate, summarize, or resolve). " +
                "Refer to people with their Slack mention as given (e.g. <@U123>). " +
                "No preamble, no markdown headings.",
            },
            { role: "user", content: `Context:\n${renderContext(ctx)}\n\nQuestion: ${question}` },
          ],
        }),
      });
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message?: string };
      };
      if (data.error) return fallbackAnswer(ctx);
      const text = data.choices?.[0]?.message?.content?.trim();
      return text || fallbackAnswer(ctx);
    } catch {
      return fallbackAnswer(ctx);
    }
  }
}

/** A deterministic, grounded one-liner used when OpenAI is unavailable. */
export function fallbackAnswer(ctx: IncidentContext): string {
  const roles = ctx.roles.length
    ? ctx.roles.map((r) => `${r.role}: <@${r.holder}>`).join(", ")
    : "no roles claimed yet";
  return (
    `${ctx.incidentId} (${ctx.name}) is *${ctx.status}* at *${ctx.severity}*. ` +
    `${roles}. ${ctx.timeline.length} update(s) so far. ` +
    `Ask me to post an update, change status/severity, escalate, summarize, or resolve.`
  );
}

/** Deterministic fake for tests / no-OpenAI dev — echoes grounded context. */
export class FakeIncidentAnswerer implements IncidentAnswerer {
  calls: { question: string; ctx: IncidentContext }[] = [];
  async answer(question: string, ctx: IncidentContext): Promise<string> {
    this.calls.push({ question, ctx });
    return fallbackAnswer(ctx);
  }
}

// --- Injection seam (mirrors the classifier seam in intent.ts). ---
let answererOverride: ((env: Env) => IncidentAnswerer) | undefined;
export function __setIncidentAnswerer(f: ((env: Env) => IncidentAnswerer) | undefined): void {
  answererOverride = f;
}
export function buildIncidentAnswerer(env: Env): IncidentAnswerer {
  if (answererOverride) return answererOverride(env);
  if (env.AUTH_MODE === "bypass" || !env.OPENAI_API_KEY) return new FakeIncidentAnswerer();
  return new OpenAiIncidentAnswerer(env.OPENAI_API_KEY, env.OPENAI_MODEL?.trim() || "gpt-4o-mini");
}

/**
 * Answer an @-mention question in a mapped incident channel. Returns the reply
 * text (grounded), or a short fallback if the incident vanished. Called by the
 * router when the classifier returns `unknown` (i.e. not a mutating command).
 */
export async function answerMention(
  env: Env,
  incidentId: string,
  question: string,
): Promise<string> {
  const ctx = await buildIncidentContext(env, incidentId);
  if (!ctx) {
    return "I couldn't find this incident's details right now — try again in a moment.";
  }
  return buildIncidentAnswerer(env).answer(question, ctx);
}
