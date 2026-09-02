import type { SlackClient, SlackMessage } from "./slack";

/**
 * In-memory Slack client for tests and local no-Slack dev. Records outbound
 * calls, stores per-channel messages, and lets callers seed inbound history.
 * When `log` is true (local dev), it prints activity to the console.
 */
export class FakeSlackClient implements SlackClient {
  channels = new Map<string, SlackMessage[]>();
  created: string[] = [];
  posted: { channel: string; text: string }[] = [];
  private seq = 0;

  constructor(private readonly log = false) {}

  private nextTs(): string {
    this.seq += 1;
    return `${1700000000 + this.seq}.000000`;
  }

  async createChannel(name: string): Promise<string> {
    const id = `C_${name}`;
    if (!this.channels.has(id)) this.channels.set(id, []);
    this.created.push(name);
    if (this.log) console.log(`[fake-slack] createChannel(${name}) -> ${id}`);
    return id;
  }

  async postMessage(channel: string, text: string): Promise<void> {
    const msgs = this.channels.get(channel) ?? [];
    msgs.push({ user: "incident-bot", text, ts: this.nextTs() });
    this.channels.set(channel, msgs);
    this.posted.push({ channel, text });
    if (this.log) console.log(`[fake-slack] postMessage(${channel}): ${text}`);
  }

  async history(channel: string, limit = 50): Promise<SlackMessage[]> {
    const msgs = this.channels.get(channel) ?? [];
    return msgs.slice(-limit);
  }

  /** Test/dev helper: inject an inbound human message into a channel. */
  seedMessage(channel: string, user: string, text: string): void {
    const msgs = this.channels.get(channel) ?? [];
    msgs.push({ user, text, ts: this.nextTs() });
    this.channels.set(channel, msgs);
  }
}
