import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { PostmortemStore } from "../src/postmortem/store";
import { exportActionItemsToJira, __setIssueTracker } from "../src/postmortem/jiraExport";
import { FakeIssueTracker, type IssueTracker } from "../src/clients/jira";

const INC = "inc_jira";

async function seedResolvedWithPostmortem() {
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, created_at, resolved_at) VALUES (?, 'Checkout 500s', 'resolved', ?, ?)",
  )
    .bind(INC, "2026-09-03T01:00:00Z", "2026-09-03T01:30:00Z")
    .run();
  await new PostmortemStore(new D1Db(env.DB)).saveDraft(INC, {
    summary: "s",
    impact: "i",
    root_cause: "rc",
    contributing_factors: "cf",
    action_items: ["Add canary deploys", "Tighten checkout alarm"],
  });
}

describe("Jira export", () => {
  afterEach(async () => {
    __setIssueTracker(undefined);
    await env.DB.prepare(
      "DELETE FROM postmortem_action_items WHERE postmortem_id IN (SELECT id FROM postmortems WHERE incident_id = ?)",
    ).bind(INC).run();
    await env.DB.prepare("DELETE FROM postmortems WHERE incident_id = ?").bind(INC).run();
    await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(INC).run();
  });

  it("is a no-op (not an error) when Jira is unconfigured", async () => {
    __setIssueTracker(() => null);
    await seedResolvedWithPostmortem();
    const res = await exportActionItemsToJira(env as any, INC);
    expect(res).toEqual({ configured: false, exported: 0 });
    const pm = await new PostmortemStore(new D1Db(env.DB)).get(INC);
    expect(pm?.action_items.every((a) => a.jira_key === null)).toBe(true);
  });

  it("creates an issue per action item and persists the key", async () => {
    const fake = new FakeIssueTracker();
    __setIssueTracker(() => fake);
    await seedResolvedWithPostmortem();

    const res = await exportActionItemsToJira(env as any, INC);
    expect(res.configured).toBe(true);
    expect(res.exported).toBe(2);
    expect(fake.created).toHaveLength(2);

    const pm = await new PostmortemStore(new D1Db(env.DB)).get(INC);
    expect(pm?.action_items.every((a) => a.jira_key?.startsWith("INC-"))).toBe(true);
  });

  it("is idempotent — a second run exports nothing new", async () => {
    const fake = new FakeIssueTracker();
    __setIssueTracker(() => fake);
    await seedResolvedWithPostmortem();

    await exportActionItemsToJira(env as any, INC);
    const second = await exportActionItemsToJira(env as any, INC);
    expect(second.exported).toBe(0);
    expect(fake.created).toHaveLength(2); // no new issues
  });

  it("tolerates a per-item failure and still exports the rest", async () => {
    let n = 0;
    const flaky: IssueTracker = {
      async createIssue(_summary, _description) {
        n += 1;
        if (n === 1) throw new Error("boom");
        return { key: `INC-${n}`, url: `https://jira.example/browse/INC-${n}` };
      },
    };
    __setIssueTracker(() => flaky);
    await seedResolvedWithPostmortem();

    const res = await exportActionItemsToJira(env as any, INC);
    expect(res.exported).toBe(1); // one failed, one succeeded
    const pm = await new PostmortemStore(new D1Db(env.DB)).get(INC);
    const withKeys = pm?.action_items.filter((a) => a.jira_key) ?? [];
    expect(withKeys).toHaveLength(1);
  });
});
