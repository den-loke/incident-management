/// <reference types="@cloudflare/workers-types" />
// Standing stakeholder subscriptions. A single opt-in list (migration 0010):
// a stakeholder is invited to the channel of every FUTURE incident at declare
// time. See src/stakeholders/service.ts for the Home-tab UI and invite hook.

import type { D1Db } from "../status/d1";

export class StakeholderStore {
  constructor(private readonly db: D1Db) {}

  /** Opt a user in (idempotent). */
  async subscribe(slackUserId: string): Promise<void> {
    await this.db.run(
      "INSERT OR IGNORE INTO incident_stakeholders (slack_user_id) VALUES (?)",
      [slackUserId],
    );
  }

  /** Opt a user out (idempotent). */
  async unsubscribe(slackUserId: string): Promise<void> {
    await this.db.run(
      "DELETE FROM incident_stakeholders WHERE slack_user_id = ?",
      [slackUserId],
    );
  }

  /** True if the user is currently subscribed. */
  async isSubscribed(slackUserId: string): Promise<boolean> {
    const row = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM incident_stakeholders WHERE slack_user_id = ?",
      [slackUserId],
    );
    return (row?.n ?? 0) > 0;
  }

  /** All subscribed Slack user ids. */
  async list(): Promise<string[]> {
    const rows = await this.db.all<{ slack_user_id: string }>(
      "SELECT slack_user_id FROM incident_stakeholders ORDER BY created_at",
    );
    return rows.map((r) => r.slack_user_id);
  }
}
