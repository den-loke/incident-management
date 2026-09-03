/// <reference types="@cloudflare/workers-types" />
// Conversational control — map a natural-language @-mention to an incident
// action. See ROADMAP.md → "Conversational control". This is a THIRD surface
// (alongside slash commands + the button panel): `@Incident Management update
// please` → post an update; "set status to identified"; "escalate to @alice";
// "what's the summary?"; "resolve". The classifier maps text → a structured
// intent; the router dispatches it through the SHARED command functions so all
// three surfaces drive one path.
//
// Injectable (like the Summarizer): the real impl uses OpenAI JSON-mode; the
// fake is deterministic keyword rules so tests never touch the network.

import type { Env } from "../env";
import type { IncidentStatus, IncidentSeverity } from "../status/types";

export type IntentAction =
  | "update" // post a status update (text = body)
  | "status" // advance lifecycle status
  | "severity" // change severity
  | "escalate" // page a specific user
  | "summarize" // summarize the incident so far
  | "resolve" // request resolution (joint sign-off)
  | "unknown"; // couldn't map — reply with help

export interface Intent {
  action: IntentAction;
  /** For update: the update body. For escalate: the trailing message. */
  text?: string;
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  /** For escalate: the Slack user id parsed from a mention. */
  target?: string;
}

export interface IntentClassifier {
  classify(text: string): Promise<Intent>;
}

const OPENAI_API = "https://api.openai.com/v1/chat/completions";
const STATUSES = ["investigating", "identified", "monitoring"] as const;
const SEVERITIES = ["sev1", "sev2", "sev3"] as const;

/** Strip a leading bot mention (`<@U…>`), leaving the instruction text. */
export function stripMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9_]+>\s*/i, "").trim();
}

/** Parse the first `<@U…>` user mention in the text (the escalate target). */
function firstUserMention(text: string): string | undefined {
  const m = text.match(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/i);
  return m?.[1];
}

/**
 * Deterministic keyword classifier — the always-available fallback AND the test
 * fake. Cheap, no network. The OpenAI classifier is used when configured; this
 * covers the common phrasings and guarantees a sane intent offline.
 */
export function ruleClassify(raw: string): Intent {
  const text = stripMention(raw);
  const lower = text.toLowerCase();

  // escalate — needs a user mention; the target is NOT the leading bot mention
  // (already stripped), so any remaining <@…> is the person to page.
  if (/\bescalate\b|\bpage\b|\bpull in\b/.test(lower)) {
    const target = firstUserMention(text);
    if (target) {
      const msg = text.replace(/<@[A-Z0-9_]+(?:\|[^>]*)?>/i, "").replace(/\b(escalate|page|pull in)\b/i, "").trim();
      return { action: "escalate", target, text: msg || undefined };
    }
  }

  // resolve
  if (/\bresolve\b|\bresolved\b|\bclose (?:the )?incident\b/.test(lower)) {
    return { action: "resolve" };
  }

  // status — "set status to X" / "mark as X" / a bare status word
  const statusHit = STATUSES.find((s) => lower.includes(s));
  if (statusHit && /\bstatus\b|\bset\b|\bmark\b|\bmove to\b/.test(lower)) {
    const note = text.replace(/\b(set|status|to|mark(ed)?|as|move)\b/gi, "").replace(statusHit, "").trim();
    return { action: "status", status: statusHit, text: note || undefined };
  }

  // severity — "set severity to sev1" / "this is sev1"
  const sevHit = SEVERITIES.find((s) => lower.includes(s));
  if (sevHit) {
    return { action: "severity", severity: sevHit };
  }

  // summarize / what's happening
  if (/\bsummar/.test(lower) || /what('| i)?s? (the )?(status|happening|going on|the summary)/.test(lower)) {
    return { action: "summarize" };
  }

  // update — "update please", "post an update: …", or a general instruction to update
  if (/\bupdate\b/.test(lower)) {
    // Body is any text after an "update" keyword / colon, else the whole thing.
    const afterColon = text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : "";
    const body = afterColon || text.replace(/\b(post|an?|update|please)\b/gi, "").trim();
    return { action: "update", text: body || undefined };
  }

  return { action: "unknown" };
}

/** Real OpenAI-backed classifier (JSON mode). Falls back to rules on any error. */
export class OpenAiIntentClassifier implements IntentClassifier {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async classify(raw: string): Promise<Intent> {
    const text = stripMention(raw);
    try {
      const res = await fetch(OPENAI_API, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You map an incident responder's instruction to a JSON intent. " +
                "Fields: action (one of update|status|severity|escalate|summarize|resolve|unknown), " +
                "text (string, optional — the update/escalate message), " +
                "status (investigating|identified|monitoring, optional), " +
                "severity (sev1|sev2|sev3, optional), " +
                "target (a Slack user id like U123 parsed from a <@…> mention, optional). " +
                "Respond with ONLY the JSON object.",
            },
            { role: "user", content: text },
          ],
        }),
      });
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: unknown };
      if ((data as { error?: unknown }).error) return ruleClassify(raw);
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as Partial<Intent>;
      const action = (parsed.action ?? "unknown") as IntentAction;
      // A target may come back bare (U123) or the model may miss it; backfill from text.
      const target = parsed.target ?? firstUserMention(text);
      return { action, text: parsed.text, status: parsed.status, severity: parsed.severity, target };
    } catch {
      return ruleClassify(raw); // network/parse failure → deterministic fallback
    }
  }
}

/** Deterministic fake for tests / no-OpenAI dev — pure rule classifier. */
export class FakeIntentClassifier implements IntentClassifier {
  calls: string[] = [];
  async classify(raw: string): Promise<Intent> {
    this.calls.push(raw);
    return ruleClassify(raw);
  }
}

// --- Injection seam (mirrors the Summarizer seam in incident.ts). ---
let classifierOverride: ((env: Env) => IntentClassifier) | undefined;
export function __setIntentClassifier(f: ((env: Env) => IntentClassifier) | undefined): void {
  classifierOverride = f;
}
export function buildIntentClassifier(env: Env): IntentClassifier {
  if (classifierOverride) return classifierOverride(env);
  if (env.AUTH_MODE === "bypass" || !env.OPENAI_API_KEY) return new FakeIntentClassifier();
  return new OpenAiIntentClassifier(env.OPENAI_API_KEY, env.OPENAI_MODEL?.trim() || "gpt-4o-mini");
}

/** What applyIntent did, so the router can report / the bot can confirm. */
export type IntentOutcome =
  | { applied: "update" | "status" | "severity" | "escalate" | "summarize" | "resolve" }
  | { applied: "unknown" };

/**
 * Dispatch a classified intent through the SHARED command functions — the same
 * path slash commands, buttons, and the web UI use. Channel-scoped: the caller
 * has already resolved this to a mapped incident. Best-effort; a wrong action is
 * as cheap to correct as any Slack message.
 */
export async function applyIntent(
  env: Env,
  incidentId: string,
  channelId: string,
  userId: string,
  intent: Intent,
): Promise<IntentOutcome> {
  // Lazy imports avoid a module cycle (commands.ts → … → intent.ts).
  const { postIncidentUpdate } = await import("./commands");

  switch (intent.action) {
    case "update": {
      const body = intent.text?.trim() || `Update requested by <@${userId}>.`;
      await postIncidentUpdate(env, incidentId, `<@${userId}>: ${body}`);
      return { applied: "update" };
    }
    case "status": {
      if (!intent.status) return { applied: "unknown" };
      const note = intent.text?.trim() || `Status set to *${intent.status}* by <@${userId}>.`;
      await postIncidentUpdate(env, incidentId, note, intent.status);
      return { applied: "status" };
    }
    case "severity": {
      if (!intent.severity) return { applied: "unknown" };
      const { setSeverity } = await import("./severity");
      await setSeverity(env, incidentId, intent.severity);
      return { applied: "severity" };
    }
    case "escalate": {
      if (!intent.target) return { applied: "unknown" };
      const { buildRouterSlack } = await import("../router");
      const slack = buildRouterSlack(env);
      const reason = intent.text ? `: “${intent.text}”` : ".";
      await slack.postMessage(intent.target, `:rotating_light: <@${userId}> is pulling you into <#${channelId}>${reason}`).catch(() => {});
      await slack.postMessage(channelId, `<@${userId}> escalated to <@${intent.target}> for more hands${reason}`).catch(() => {});
      return { applied: "escalate" };
    }
    case "summarize": {
      const { summarizeIncidentNow } = await import("./commands");
      await summarizeIncidentNow(env, incidentId);
      return { applied: "summarize" };
    }
    case "resolve": {
      const { requestResolve } = await import("./jointResolve");
      await requestResolve(env, incidentId, channelId, userId, intent.text || undefined);
      return { applied: "resolve" };
    }
    default:
      return { applied: "unknown" };
  }
}
