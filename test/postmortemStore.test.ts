import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { PostmortemStore } from "../src/postmortem/store";
import type { PostmortemDraft } from "../src/postmortem/types";

const draft = (over: Partial<PostmortemDraft> = {}): PostmortemDraft => ({
  summary: "Checkout was down for 30m.",
  impact: "~20% of checkouts failed.",
  root_cause: "Bad deploy shipped a null-deref.",
  contributing_factors: "No canary; alert was slow.",
  action_items: ["Add canary deploys", "Tighten checkout alarm"],
  ...over,
});

async function seedIncident(id: string) {
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, created_at, resolved_at) VALUES (?, ?, 'resolved', ?, ?)",
  )
    .bind(id, "Checkout 500s", "2026-09-02T01:00:00Z", "2026-09-02T01:30:00Z")
    .run();
}

describe("PostmortemStore", () => {
  let store: PostmortemStore;

  beforeEach(async () => {
    store = new PostmortemStore(new D1Db(env.DB));
    await seedIncident("inc_pm");
  });
  afterEach(async () => {
    await env.DB.prepare("DELETE FROM postmortem_action_items").run();
    await env.DB.prepare("DELETE FROM postmortems").run();
    await env.DB.prepare("DELETE FROM incidents").run();
  });

  it("returns null when no post-mortem exists", async () => {
    expect(await store.get("inc_pm")).toBeNull();
  });

  it("creates a draft with action items", async () => {
    const pm = await store.saveDraft("inc_pm", draft());
    expect(pm.status).toBe("draft");
    expect(pm.summary).toContain("Checkout was down");
    expect(pm.action_items).toHaveLength(2);
    expect(pm.action_items[0].done).toBe(false);
  });

  it("overwrites the draft and replaces action items on re-save", async () => {
    await store.saveDraft("inc_pm", draft());
    const pm = await store.saveDraft(
      "inc_pm",
      draft({ summary: "Rewritten", action_items: ["Only one now"] }),
    );
    expect(pm.summary).toBe("Rewritten");
    expect(pm.action_items).toHaveLength(1);
    expect(pm.action_items[0].description).toBe("Only one now");
  });

  it("skips blank action-item descriptions", async () => {
    const pm = await store.saveDraft(
      "inc_pm",
      draft({ action_items: ["Real", "   ", ""] }),
    );
    expect(pm.action_items).toHaveLength(1);
  });

  it("toggles an action item done", async () => {
    const pm = await store.saveDraft("inc_pm", draft());
    await store.setActionItemDone(pm.action_items[0].id, true);
    const after = await store.get("inc_pm");
    expect(after?.action_items[0].done).toBe(true);
  });

  it("publishes and then refuses to overwrite the published post-mortem", async () => {
    await store.saveDraft("inc_pm", draft());
    await store.publish("inc_pm");
    const published = await store.get("inc_pm");
    expect(published?.status).toBe("published");
    expect(published?.published_at).not.toBeNull();

    // saveDraft must be a no-op on a published post-mortem
    const after = await store.saveDraft("inc_pm", draft({ summary: "SHOULD NOT APPLY" }));
    expect(after.summary).not.toBe("SHOULD NOT APPLY");
    expect(after.status).toBe("published");
  });
});
