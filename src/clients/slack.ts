// Injectable Slack client. The real impl calls the Slack Web API; the fake
// records calls so the engine can run in tests and local dev with no Slack.
// See docs/ARCHITECTURE.md §4 (outbound = Web API).

export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
}

export interface SlackClient {
  /** Create the incident channel; returns its channel id. */
  createChannel(name: string): Promise<string>;
  /** Post a message to a channel. */
  postMessage(channel: string, text: string): Promise<void>;
  /** Read recent messages from a channel (newest last). */
  history(channel: string, limit?: number): Promise<SlackMessage[]>;
}

const SLACK_API = "https://slack.com/api";

/** Real Slack Web API client. */
export class WebApiSlackClient implements SlackClient {
  constructor(private readonly botToken: string) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; error?: string } & Record<
      string,
      unknown
    >;
    if (!data.ok) throw new Error(`slack ${method} failed: ${data.error}`);
    return data as T;
  }

  async createChannel(name: string): Promise<string> {
    const data = await this.call<{ channel: { id: string } }>(
      "conversations.create",
      { name },
    );
    return data.channel.id;
  }

  async postMessage(channel: string, text: string): Promise<void> {
    await this.call("chat.postMessage", { channel, text });
  }

  async history(channel: string, limit = 50): Promise<SlackMessage[]> {
    const data = await this.call<{
      messages: { user?: string; text?: string; ts: string }[];
    }>("conversations.history", { channel, limit });
    // Slack returns newest-first; reverse to chronological.
    return data.messages
      .slice()
      .reverse()
      .map((m) => ({ user: m.user ?? "unknown", text: m.text ?? "", ts: m.ts }));
  }
}
