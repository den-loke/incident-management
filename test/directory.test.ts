import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { resolveNames, __setDirectoryFetch } from "../src/slack/directory";
import type { Env } from "../src/env";

async function clean() {
  await env.DB.prepare("DELETE FROM slack_users WHERE slack_user_id LIKE 'UDIR%'").run();
}

describe("slack user directory (pull-through cache)", () => {
  afterEach(async () => {
    __setDirectoryFetch(null);
    await clean();
  });

  it("misses → fetches from Slack, upserts, and resolves names", async () => {
    let calls = 0;
    __setDirectoryFetch(async () => {
      calls++;
      return { UDIR1: "Alice", UDIR2: "Bob" };
    });
    const names = await resolveNames(env as unknown as Env, ["UDIR1", "UDIR2"]);
    expect(names).toEqual({ UDIR1: "Alice", UDIR2: "Bob" });
    expect(calls).toBe(1);
    // persisted to D1
    const row = await env.DB.prepare("SELECT display_name FROM slack_users WHERE slack_user_id = ?").bind("UDIR1").first<{ display_name: string }>();
    expect(row?.display_name).toBe("Alice");
  });

  it("serves fresh ids from the D1 cache without calling Slack", async () => {
    await env.DB.prepare("INSERT INTO slack_users (slack_user_id, display_name) VALUES (?, ?)").bind("UDIR3", "Carol").run();
    let calls = 0;
    __setDirectoryFetch(async () => { calls++; return {}; });
    const names = await resolveNames(env as unknown as Env, ["UDIR3"]);
    expect(names.UDIR3).toBe("Carol");
    expect(calls).toBe(0); // fresh cache hit → no Slack call
  });

  it("keeps a departed user's cached name (Slack no longer returns them)", async () => {
    // Cached earlier…
    await env.DB.prepare("INSERT INTO slack_users (slack_user_id, display_name, updated_at) VALUES (?, ?, ?)")
      .bind("UDIR4", "Dave", "2000-01-01T00:00:00.000Z") // stale → triggers a fetch
      .run();
    // …but Slack no longer lists them (departed): fetch returns others only.
    __setDirectoryFetch(async () => ({ UDIR9: "Someone Else" }));
    const names = await resolveNames(env as unknown as Env, ["UDIR4"]);
    expect(names.UDIR4).toBe("Dave"); // last-known name retained, not the raw id
  });

  it("falls back to the id for a never-seen user + Slack failure", async () => {
    __setDirectoryFetch(async () => { throw new Error("slack users.list failed: missing_scope"); });
    const names = await resolveNames(env as unknown as Env, ["UDIRZZ"]);
    expect(names.UDIRZZ).toBe("UDIRZZ");
  });
});
