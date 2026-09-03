/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";
import type { SlackClient } from "./clients/slack";
import type { Summarizer } from "./clients/openai";
import { WebApiSlackClient } from "./clients/slack";
import { OpenAiSummarizer } from "./clients/openai";
import { FakeSlackClient } from "./clients/fakeSlack";
import { FakeSummarizer } from "./clients/fakeOpenai";
import type { StatusSink } from "./status/sink";
import type { IncidentStatus } from "./status/types";
import type { IncidentSeverity } from "./status/types";
import { buildStatusSink } from "./status";
import { D1Db } from "./status/d1";

/** Progress-update cadence. See docs/ARCHITECTURE.md §2. */
export const ALARM_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Local no-Slack dev: when AUTH_MODE=bypass the DO uses process-wide fake
 * Slack/OpenAI clients (singletons, so channel state persists across the DO's
 * requests within the isolate) instead of calling out. The status sink stays
 * REAL so the internal status page is written to the local D1.
 * See docs/ARCHITECTURE.md §4 (local dev) and the scripts/fake-incident harness.
 */
function isBypass(env: Env): boolean {
  return env.AUTH_MODE === "bypass";
}
let devSlack: FakeSlackClient | undefined;
let devSummarizer: FakeSummarizer | undefined;
function getDevSlack(): FakeSlackClient {
  return (devSlack ??= new FakeSlackClient(true));
}
function getDevSummarizer(): FakeSummarizer {
  return (devSummarizer ??= new FakeSummarizer(true));
}

/**
 * Test-only injection seam. In production this stays empty and the DO builds
 * real clients from env. Tests (which run in the same workerd isolate under
 * vitest-pool-workers) register fakes here before driving the DO, so no live
 * Slack / OpenAI / D1 network is touched. See docs/ARCHITECTURE.md §9.
 */
export interface IncidentClientOverrides {
  slack?: (env: Env) => SlackClient;
  summarizer?: (env: Env) => Summarizer;
  sink?: (env: Env) => StatusSink;
}
let overrides: IncidentClientOverrides = {};
export function __setIncidentClientOverrides(o: IncidentClientOverrides): void {
  overrides = o;
}
export function __resetIncidentClientOverrides(): void {
  overrides = {};
}

/** Persisted DO storage keys. */
const KEY = {
  incidentId: "incidentId",
  incidentName: "incidentName",
  channelId: "channelId",
  status: "status",
  lastMessageCount: "lastMessageCount",
} as const;

interface DeclareCommand {
  cmd: "declare";
  name: string;
  body?: string;
  id?: string;
  severity?: IncidentSeverity;
}
interface PostUpdateCommand {
  cmd: "postUpdate";
  body: string;
  status?: IncidentStatus;
}
interface ResolveCommand {
  cmd: "resolve";
  body?: string;
}
interface MessageCommand {
  cmd: "message";
  user: string;
  text: string;
}
type Command =
  | DeclareCommand
  | PostUpdateCommand
  | ResolveCommand
  | MessageCommand;

/**
 * One Durable Object instance == one incident. See docs/ARCHITECTURE.md §2.
 * Owns per-incident state and the 15-min progress-update alarm.
 *
 * Slack + OpenAI + the StatusSink are reached through the protected `build*`
 * factories so tests can subclass this DO and inject fakes without a live
 * Slack/OpenAI/D1 (see test/incident.test.ts and docs/ARCHITECTURE.md §9).
 */
export class Incident implements DurableObject {
  constructor(
    protected readonly state: DurableObjectState,
    protected readonly env: Env,
  ) {}

  // --- injectable seams (overridden in tests via __setIncidentClientOverrides) ---
  protected buildSlack(): SlackClient {
    if (overrides.slack) return overrides.slack(this.env);
    if (isBypass(this.env)) return getDevSlack();
    return new WebApiSlackClient(this.env.SLACK_BOT_TOKEN);
  }
  protected buildSummarizer(): Summarizer {
    if (overrides.summarizer) return overrides.summarizer(this.env);
    if (isBypass(this.env)) return getDevSummarizer();
    return new OpenAiSummarizer(this.env.OPENAI_API_KEY);
  }
  protected buildSink(): StatusSink {
    if (overrides.sink) return overrides.sink(this.env);
    return buildStatusSink(new D1Db(this.env.DB), this.env);
  }

  /**
   * Internal command API. The front Worker routes to a DO stub via fetch();
   * the body is a JSON Command. Not a public HTTP surface.
   */
  async fetch(request: Request): Promise<Response> {
    let command: Command;
    try {
      command = (await request.json()) as Command;
    } catch {
      return json({ error: "bad_json" }, 400);
    }

    switch (command.cmd) {
      case "declare":
        return json(await this.declare(command));
      case "postUpdate":
        return json(await this.postUpdate(command.body, command.status));
      case "resolve":
        return json(await this.resolve(command.body));
      case "message":
        // Inbound channel activity — recorded implicitly by Slack; the DO
        // simply keeps its alarm alive. Nothing to persist here yet.
        return json({ ok: true });
      default:
        return json({ error: "unknown_command" }, 400);
    }
  }

  /**
   * Declare a new incident: open it in the status sink, create the Slack
   * incident channel, persist ids to DO storage, and arm the 15-min alarm.
   */
  private async declare(
    cmd: DeclareCommand,
  ): Promise<{ incidentId: string; channelId: string }> {
    const existing = await this.state.storage.get<string>(KEY.incidentId);
    if (existing) {
      // Idempotent: a DO only ever declares once.
      const channelId = (await this.state.storage.get<string>(KEY.channelId))!;
      return { incidentId: existing, channelId };
    }

    const sink = this.buildSink();
    const slack = this.buildSlack();

    const incident = await sink.openIncident({
      id: cmd.id,
      name: cmd.name,
      body: cmd.body,
      severity: cmd.severity,
    });
    const channelId = await slack.createChannel(channelName(incident.id));
    if (cmd.body) {
      await slack.postMessage(channelId, `:rotating_light: ${cmd.body}`);
    }

    await this.state.storage.put({
      [KEY.incidentId]: incident.id,
      [KEY.incidentName]: incident.name,
      [KEY.channelId]: channelId,
      [KEY.status]: incident.status,
      [KEY.lastMessageCount]: 0,
    });

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);

    return { incidentId: incident.id, channelId };
  }

  /** Append an explicit update, persist it, and post it to the channel. */
  private async postUpdate(
    body: string,
    status?: IncidentStatus,
  ): Promise<{ ok: true }> {
    const incidentId = await this.requireIncidentId();
    const channelId = (await this.state.storage.get<string>(KEY.channelId))!;
    const nextStatus =
      status ??
      (await this.state.storage.get<IncidentStatus>(KEY.status)) ??
      "monitoring";

    const sink = this.buildSink();
    await sink.appendIncidentUpdate(incidentId, body, nextStatus);
    await this.state.storage.put(KEY.status, nextStatus);

    const slack = this.buildSlack();
    await slack.postMessage(channelId, body);

    return { ok: true };
  }

  /** Resolve the incident, post a final update, and stop the alarm loop. */
  private async resolve(body?: string): Promise<{ ok: true }> {
    const incidentId = await this.requireIncidentId();
    const channelId = (await this.state.storage.get<string>(KEY.channelId))!;

    const sink = this.buildSink();
    await sink.appendIncidentUpdate(
      incidentId,
      body ?? "Incident resolved.",
      "resolved",
    );
    await this.state.storage.put(KEY.status, "resolved");

    const slack = this.buildSlack();
    await slack.postMessage(channelId, `:white_check_mark: ${body ?? "Resolved."}`);

    // Stop the loop: cancel any pending alarm so alarm() never reschedules.
    await this.state.storage.deleteAlarm();

    return { ok: true };
  }

  /**
   * Fires on the 15-min cadence: pull recent channel messages, summarize via
   * OpenAI, append the update, post it, and reschedule — UNLESS resolved, in
   * which case the loop stops (no further alarm is set).
   */
  async alarm(): Promise<void> {
    const status = await this.state.storage.get<IncidentStatus>(KEY.status);
    if (status === "resolved") {
      // Terminal: do not reschedule.
      return;
    }

    const incidentId = await this.state.storage.get<string>(KEY.incidentId);
    const channelId = await this.state.storage.get<string>(KEY.channelId);
    const incidentName =
      (await this.state.storage.get<string>(KEY.incidentName)) ?? "Incident";
    if (!incidentId || !channelId) {
      // Not fully declared; nothing to do and nothing to reschedule.
      return;
    }

    const slack = this.buildSlack();
    const messages = await slack.history(channelId);

    // Only summarize/post when there is genuinely new activity, but always
    // keep the loop alive so a quiet channel resumes updates once it speaks.
    const lastCount =
      (await this.state.storage.get<number>(KEY.lastMessageCount)) ?? 0;
    if (messages.length > lastCount) {
      const summarizer = this.buildSummarizer();
      const body = await summarizer.summarize(incidentName, messages);

      const sink = this.buildSink();
      await sink.appendIncidentUpdate(incidentId, body, "monitoring");
      await slack.postMessage(channelId, body);

      await this.state.storage.put(KEY.status, "monitoring");
      await this.state.storage.put(KEY.lastMessageCount, messages.length);
    }

    // Reschedule while the incident remains open.
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async requireIncidentId(): Promise<string> {
    const id = await this.state.storage.get<string>(KEY.incidentId);
    if (!id) throw new Error("incident not declared");
    return id;
  }
}

/** Slack channel names: lowercase, no dots. */
function channelName(incidentId: string): string {
  return `inc-${incidentId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`.slice(
    0,
    80,
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
