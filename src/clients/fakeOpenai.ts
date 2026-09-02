import type { Summarizer, PostmortemDraftFields, TimelineEntry } from "./openai";
import type { SlackMessage } from "./slack";

/**
 * Deterministic fake summarizer for tests and local no-OpenAI dev. Produces a
 * stable string derived from the input so assertions never flake, and records
 * every call for inspection. See docs/ARCHITECTURE.md §9 (OpenAI determinism).
 */
export class FakeSummarizer implements Summarizer {
  calls: { incidentName: string; messages: SlackMessage[] }[] = [];
  postmortemCalls: { incidentName: string; timeline: TimelineEntry[] }[] = [];

  constructor(private readonly log = false) {}

  async summarize(
    incidentName: string,
    messages: SlackMessage[],
  ): Promise<string> {
    this.calls.push({ incidentName, messages });
    const last = messages[messages.length - 1]?.text ?? "no new activity";
    const body = `Progress update for "${incidentName}": ${messages.length} message(s) since last update. Latest: ${last}`;
    if (this.log) console.log(`[fake-openai] summarize -> ${body}`);
    return body;
  }

  async draftPostmortem(
    incidentName: string,
    timeline: TimelineEntry[],
  ): Promise<PostmortemDraftFields> {
    this.postmortemCalls.push({ incidentName, timeline });
    return {
      summary: `Post-mortem draft for "${incidentName}" (${timeline.length} timeline entries).`,
      impact: "Impact derived from the incident timeline.",
      root_cause: timeline[0]?.body ?? "Root cause to be determined.",
      contributing_factors: "Contributing factors to be reviewed.",
      action_items: ["Review the incident timeline", "Add a follow-up action"],
    };
  }
}
