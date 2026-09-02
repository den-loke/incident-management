// Injectable OpenAI client. The real impl calls the Chat Completions API over
// fetch (workerd-native, no SDK); the fake returns deterministic summaries so
// the engine runs in tests and local dev with no OpenAI.
// See docs/ARCHITECTURE.md §2 (OpenAI via fetch) and §9 (determinism).

import type { SlackMessage } from "./slack";

/** Structured post-mortem draft fields produced from an incident's timeline. */
export interface PostmortemDraftFields {
  summary: string;
  impact: string;
  root_cause: string;
  contributing_factors: string;
  action_items: string[];
}

/** One incident update, as fed to the post-mortem drafter. */
export interface TimelineEntry {
  body: string;
  status: string;
  created_at: string;
}

export interface Summarizer {
  /**
   * Draft a short incident progress update from recent channel messages.
   * Returns the update body text only (status is chosen by the engine).
   */
  summarize(incidentName: string, messages: SlackMessage[]): Promise<string>;

  /**
   * Draft a structured post-mortem from the incident's name + update timeline.
   * The result is a starting point for human editing, never auto-published.
   */
  draftPostmortem(
    incidentName: string,
    timeline: TimelineEntry[],
  ): Promise<PostmortemDraftFields>;
}

const OPENAI_API = "https://api.openai.com/v1/chat/completions";

/** Real OpenAI client (Chat Completions via fetch). */
export class OpenAiSummarizer implements Summarizer {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini",
  ) {}

  async summarize(
    incidentName: string,
    messages: SlackMessage[],
  ): Promise<string> {
    const transcript = messages
      .map((m) => `${m.user}: ${m.text}`)
      .join("\n");

    const res = await fetch(OPENAI_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You are an incident commander's assistant. Given recent Slack " +
              "messages from an incident channel, write a single concise " +
              "progress update (1-3 sentences) for a public status page. No " +
              "preamble, no markdown, just the update text.",
          },
          {
            role: "user",
            content: `Incident: ${incidentName}\n\nRecent messages:\n${transcript}`,
          },
        ],
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error) throw new Error(`openai failed: ${data.error.message}`);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("openai returned no content");
    return text;
  }

  async draftPostmortem(
    incidentName: string,
    timeline: TimelineEntry[],
  ): Promise<PostmortemDraftFields> {
    const rendered = timeline
      .map((t) => `[${t.created_at}] (${t.status}) ${t.body}`)
      .join("\n");

    const res = await fetch(OPENAI_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are an incident commander's assistant drafting a blameless " +
              "post-mortem from an incident's update timeline. Respond ONLY with " +
              "a JSON object with these string fields: summary, impact, " +
              "root_cause, contributing_factors; and action_items as an array of " +
              "short imperative strings. Be concise and factual; this is a draft " +
              "for human review, so do not invent facts not in the timeline.",
          },
          {
            role: "user",
            content: `Incident: ${incidentName}\n\nTimeline:\n${rendered}`,
          },
        ],
      }),
    });

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (data.error) throw new Error(`openai failed: ${data.error.message}`);
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("openai returned no content");

    let parsed: Partial<PostmortemDraftFields>;
    try {
      parsed = JSON.parse(raw) as Partial<PostmortemDraftFields>;
    } catch {
      throw new Error("openai returned non-JSON post-mortem draft");
    }
    return {
      summary: parsed.summary ?? "",
      impact: parsed.impact ?? "",
      root_cause: parsed.root_cause ?? "",
      contributing_factors: parsed.contributing_factors ?? "",
      action_items: Array.isArray(parsed.action_items)
        ? parsed.action_items.filter((s): s is string => typeof s === "string")
        : [],
    };
  }
}
