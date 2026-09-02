/**
 * Runs the test suite, captures stdout, and extracts any timeline transcripts
 * (printed between TIMELINE markers by TimelineRecorder.emit) into
 * test-artifacts/<slug>.md so you can open and read each incident play-by-play.
 *
 * Usage:  npm run test:timeline
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BEGIN = "<<<TIMELINE_BEGIN>>>";
const END = "<<<TIMELINE_END>>>";

const run = spawnSync("npx", ["vitest", "run", "--silent=false"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const lines = output.split("\n");

const outDir = path.join(process.cwd(), "test-artifacts");
mkdirSync(outDir, { recursive: true });

let current: { slug: string; body: string[] } | null = null;
const written: string[] = [];

for (const raw of lines) {
  const line = stripPrefixes(raw);
  if (line.startsWith(BEGIN)) {
    const slug = line.slice(BEGIN.length).trim() || "timeline";
    current = { slug, body: [] };
    continue;
  }
  if (line.startsWith(END)) {
    if (current) {
      const file = path.join(outDir, `${current.slug}.md`);
      writeFileSync(file, current.body.join("\n").trim() + "\n", "utf8");
      written.push(file);
      current = null;
    }
    continue;
  }
  if (current) current.body.push(line);
}

/** Vitest/console can prefix lines (e.g. "stdout | test/e2e.test.ts >"); strip it. */
function stripPrefixes(line: string): string {
  return line.replace(/^stdout \| .*?\r?\n?/, "").replace(/^\s*stdout \|\s?/, "");
}

if (written.length === 0) {
  console.log("No timeline transcripts found in test output.");
} else {
  console.log(`Wrote ${written.length} timeline artifact(s):`);
  for (const f of written) console.log(`  ${f}`);
}

// Surface the underlying test exit code.
process.exit(run.status ?? 0);
