// Injectable OpenAI client. The real impl calls the Chat Completions API over
// fetch (workerd-native, no SDK); the fake returns deterministic summaries so
// the engine runs in tests and local dev with no OpenAI.
// See docs/ARCHITECTURE.md §2 (OpenAI via fetch) and §9 (determinism).

import type { SlackMessage } from "./slack";

export interface Summarizer {
  /**
   * Draft a short incident progress update from recent channel messages.
   * Returns the update body text only (status is chosen by the engine).
   */
  summarize(incidentName: string, messages: SlackMessage[]): Promise<string>;
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
}
