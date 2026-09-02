/**
 * Local no-Slack dev harness. Drives a FAKE incident end-to-end against a
 * locally-running Worker (`npm run dev`) by forging *validly signed* Slack
 * Events API requests — exactly as Slack would send them — so the Worker's real
 * verify -> ack -> route path runs. No Slack workspace, no network to Slack.
 *
 * The Worker must run with AUTH_MODE=bypass and a known SLACK_SIGNING_SECRET so
 * the Incident DO uses the in-process fake Slack/OpenAI clients (see
 * src/incident.ts) and this script can sign requests it will accept.
 *
 * Usage:
 *   1) Put AUTH_MODE=bypass and SLACK_SIGNING_SECRET=dev-secret in .dev.vars
 *   2) npm run dev            # in one terminal (wrangler dev on :8787)
 *   3) npm run dev:fake-incident   # in another
 *
 * See docs/ARCHITECTURE.md §4 (local dev) and §9 (forged signed payloads).
 */
import { createHmac } from "node:crypto";

const WORKER_URL = process.env.WORKER_URL ?? "http://127.0.0.1:8787";
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "dev-secret";
const TEAM_ID = process.env.SLACK_TEAM_ID ?? "T_DEV";
const CHANNEL = "C_general"; // where the declare happens

interface ScriptStep {
  label: string;
  user: string;
  text: string;
  channel?: string;
}

// A hardcoded incident conversation. `declare ...` opens the incident; the
// engine creates its own channel, so later chatter lands there via its alarm.
const CONVERSATION: ScriptStep[] = [
  { label: "declare", user: "U_alice", text: "declare Checkout 500s spiking" },
  { label: "chatter", user: "U_bob", text: "Seeing 500s on /checkout, ~20% of requests" },
  { label: "chatter", user: "U_alice", text: "Rolling back the last deploy now" },
  { label: "chatter", user: "U_bob", text: "Error rate dropping after rollback" },
];

function sign(rawBody: string, timestamp: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(base).digest("hex")}`;
}

async function sendEvent(step: ScriptStep): Promise<void> {
  const envelope = {
    type: "event_callback",
    team_id: TEAM_ID,
    event: {
      type: "message",
      channel: step.channel ?? CHANNEL,
      user: step.user,
      text: step.text,
      ts: `${Date.now() / 1000}`,
    },
  };
  const rawBody = JSON.stringify(envelope);
  const timestamp = `${Math.floor(Date.now() / 1000)}`;

  const res = await fetch(`${WORKER_URL}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": sign(rawBody, timestamp),
    },
    body: rawBody,
  });
  const text = await res.text();
  console.log(`  [${step.label}] ${step.user}: "${step.text}" -> ${res.status} ${text}`);
  if (!res.ok) throw new Error(`event rejected (${res.status})`);
}

async function main(): Promise<void> {
  // Sanity: is the Worker up?
  const health = await fetch(`${WORKER_URL}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      `Worker not reachable at ${WORKER_URL}. Start it with: npm run dev`,
    );
    process.exit(1);
  }
  console.log(`Driving a fake incident against ${WORKER_URL} ...\n`);

  for (const step of CONVERSATION) {
    await sendEvent(step);
    await new Promise((r) => setTimeout(r, 300)); // let waitUntil routing settle
  }

  console.log(
    "\nDone. Watch the `npm run dev` terminal for [fake-slack]/[fake-openai] output.",
  );
  console.log(
    "The 15-min alarm won't have fired yet — assert alarm behaviour in the vitest E2E suite (advance the DO alarm), not here.",
  );
}

void main();
