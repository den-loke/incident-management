/**
 * Records an incident E2E as a human-readable timeline you can open and read
 * like a play-by-play — the backend equivalent of "watching it unfold". Steps
 * carry a LOGICAL incident clock (declare = T+0, each alarm tick advances the
 * 15-min cadence) so the transcript reads in incident-time, not test-time.
 *
 * Not a video (this flow has no UI to film) — it's the informative view for a
 * headless Worker/DO/D1 test. See docs/ARCHITECTURE.md §9.
 *
 * Runs inside the workers-pool runtime, which has NO filesystem, so the
 * transcript is printed between markers via `emit()`; `scripts/collect-timelines.ts`
 * extracts printed transcripts from the test output into test-artifacts/*.md.
 */
export interface TimelineStep {
  atMs: number; // logical incident time offset from declare, in ms
  actor: string; // e.g. "Slack", "Engine", "OpenAI", "StatusPage", "Test"
  event: string; // short imperative summary
  detail?: string; // optional extra line
}

export const TIMELINE_BEGIN = "<<<TIMELINE_BEGIN>>>";
export const TIMELINE_END = "<<<TIMELINE_END>>>";

export class TimelineRecorder {
  private steps: TimelineStep[] = [];
  private clockMs = 0;

  constructor(private readonly title: string) {}

  /** Advance the logical incident clock (e.g. one 15-min alarm cadence). */
  advance(ms: number): void {
    this.clockMs += ms;
  }

  /** Record a step at the current logical time. */
  record(actor: string, event: string, detail?: string): void {
    this.steps.push({ atMs: this.clockMs, actor, event, detail });
  }

  private static fmt(ms: number): string {
    if (ms === 0) return "T+0";
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `T+${m}m${s ? ` ${s}s` : ""}` : `T+${s}s`;
  }

  /** Stable slug used as the artifact filename by the collector. */
  slug(): string {
    return this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  toMarkdown(): string {
    const lines: string[] = [
      `# Incident E2E timeline — ${this.title}`,
      "",
      `_Generated ${new Date().toISOString()} · logical incident time._`,
      "",
      "| Time | Actor | Event | Detail |",
      "| --- | --- | --- | --- |",
    ];
    for (const s of this.steps) {
      const detail = (s.detail ?? "").replace(/\|/g, "\\|");
      lines.push(
        `| ${TimelineRecorder.fmt(s.atMs)} | ${s.actor} | ${s.event} | ${detail} |`,
      );
    }
    lines.push("");
    return lines.join("\n");
  }

  /**
   * Print the transcript between markers so `scripts/collect-timelines.ts` can
   * extract it to test-artifacts/<slug>.md. Also readable inline in test output.
   */
  emit(): void {
    console.log(`${TIMELINE_BEGIN} ${this.slug()}`);
    console.log(this.toMarkdown());
    console.log(TIMELINE_END);
  }
}
