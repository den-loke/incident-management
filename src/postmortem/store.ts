import type { Db } from "../status/sink";
import type {
  ActionItem,
  Postmortem,
  PostmortemDraft,
  PostmortemStatus,
  PostmortemWithItems,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}
function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// D1 stores booleans as 0/1; normalize on read.
function rowToItem(r: ActionItem & { done: number | boolean }): ActionItem {
  return { ...r, done: !!r.done };
}

/**
 * Post-mortem persistence over the Db port (unit-testable against FakeDb, real
 * D1 in the Worker). One post-mortem per incident. See ROADMAP.md.
 */
export class PostmortemStore {
  constructor(private readonly db: Db) {}

  async get(incidentId: string): Promise<PostmortemWithItems | null> {
    const pm = await this.db.get<Postmortem>(
      "SELECT * FROM postmortems WHERE incident_id = ?",
      [incidentId],
    );
    if (!pm) return null;
    const items = await this.db.all<ActionItem & { done: number }>(
      "SELECT * FROM postmortem_action_items WHERE postmortem_id = ? ORDER BY created_at",
      [pm.id],
    );
    return { ...pm, action_items: items.map(rowToItem) };
  }

  /**
   * Create the post-mortem for an incident if absent, or overwrite its draft
   * fields (used by the auto-draft on resolve, and by regenerate). Never
   * overwrites a published post-mortem. Replaces action items with the draft's.
   */
  async saveDraft(
    incidentId: string,
    draft: PostmortemDraft,
  ): Promise<PostmortemWithItems> {
    const existing = await this.get(incidentId);
    if (existing?.status === "published") return existing;

    const id = existing?.id ?? uid("pm");
    const now = nowIso();

    if (existing) {
      await this.db.run(
        `UPDATE postmortems SET summary = ?, impact = ?, root_cause = ?,
           contributing_factors = ?, updated_at = ? WHERE id = ?`,
        [draft.summary, draft.impact, draft.root_cause, draft.contributing_factors, now, id],
      );
      await this.db.run(
        "DELETE FROM postmortem_action_items WHERE postmortem_id = ?",
        [id],
      );
    } else {
      await this.db.run(
        `INSERT INTO postmortems
           (id, incident_id, status, summary, impact, root_cause, contributing_factors, created_at, updated_at)
         VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [id, incidentId, draft.summary, draft.impact, draft.root_cause, draft.contributing_factors, now, now],
      );
    }

    for (const description of draft.action_items) {
      if (!description.trim()) continue;
      await this.db.run(
        "INSERT INTO postmortem_action_items (id, postmortem_id, description, owner, done, created_at) VALUES (?, ?, ?, ?, 0, ?)",
        [uid("ai"), id, description.trim(), null, now],
      );
    }

    return (await this.get(incidentId))!;
  }

  /** Toggle / set an action item's done state. */
  async setActionItemDone(itemId: string, done: boolean): Promise<void> {
    await this.db.run(
      "UPDATE postmortem_action_items SET done = ? WHERE id = ?",
      [done ? 1 : 0, itemId],
    );
  }

  /** Record the exported Jira issue key on an action item. */
  async setActionItemJiraKey(itemId: string, jiraKey: string): Promise<void> {
    await this.db.run(
      "UPDATE postmortem_action_items SET jira_key = ? WHERE id = ?",
      [jiraKey, itemId],
    );
  }

  /** Mark a post-mortem published (finalized). */
  async publish(incidentId: string): Promise<void> {
    const now = nowIso();
    await this.db.run(
      "UPDATE postmortems SET status = ?, published_at = ?, updated_at = ? WHERE incident_id = ?",
      ["published" as PostmortemStatus, now, now, incidentId],
    );
  }
}
