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
  /** Post a message to a channel; returns the posted message ts. */
  postMessage(channel: string, text: string): Promise<string>;
  /** Post a Block Kit message with fallback text; returns the posted message ts. */
  postBlocks(channel: string, text: string, blocks: unknown[]): Promise<string>;
  /** Read recent messages from a channel (newest last). */
  history(channel: string, limit?: number): Promise<SlackMessage[]>;
  /** Add a reaction emoji to a message (used to seed ✅/❌ affordances). */
  addReaction(channel: string, ts: string, emoji: string): Promise<void>;
  /** Publish a Block Kit view to a user's App Home tab. */
  viewsPublish(userId: string, blocks: unknown[]): Promise<void>;
  /** Open a modal view in response to a trigger (e.g. a Home-tab button). */
  viewsOpen(triggerId: string, view: unknown): Promise<void>;
  /** Invite users to a channel (used to add stakeholders to incident channels). */
  inviteToChannel(channel: string, userIds: string[]): Promise<void>;
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

  async postMessage(channel: string, text: string): Promise<string> {
    const data = await this.call<{ ts: string }>("chat.postMessage", { channel, text });
    return data.ts;
  }

  async postBlocks(channel: string, text: string, blocks: unknown[]): Promise<string> {
    const data = await this.call<{ ts: string }>("chat.postMessage", {
      channel,
      text,
      blocks,
    });
    return data.ts;
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

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.call("reactions.add", { channel, timestamp: ts, name: emoji });
    } catch (e) {
      // already_reacted is benign (e.g. re-seeding an affordance).
      if (!String(e).includes("already_reacted")) throw e;
    }
  }

  async viewsPublish(userId: string, blocks: unknown[]): Promise<void> {
    await this.call("views.publish", {
      user_id: userId,
      view: { type: "home", blocks },
    });
  }

  async viewsOpen(triggerId: string, view: unknown): Promise<void> {
    await this.call("views.open", { trigger_id: triggerId, view });
  }

  async inviteToChannel(channel: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.call("conversations.invite", {
        channel,
        users: userIds.join(","),
      });
    } catch (e) {
      // Benign: someone already in the channel, or the bot re-inviting itself.
      const msg = String(e);
      if (
        !msg.includes("already_in_channel") &&
        !msg.includes("cant_invite_self")
      ) {
        throw e;
      }
    }
  }
}
