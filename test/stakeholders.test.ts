import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import { StakeholderStore } from "../src/stakeholders/store";
import {
  homeBlocks,
  publishHomeView,
  toggleStakeholder,
  inviteStakeholdersToChannel,
  STAKEHOLDER_TOGGLE_ACTION,
  __setStakeholderSlackClient,
} from "../src/stakeholders/service";
import { handleSlackInteractivity } from "../src/slack/interactivity";
import { FakeSlackClient } from "../src/clients/fakeSlack";

const SIGNING_SECRET = "e2e-signing-secret";
const encoder = new TextEncoder();

async function sign(rawBody: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

async function cleanup() {
  await env.DB.prepare("DELETE FROM incident_stakeholders").run();
  await env.DB.prepare(
    "DELETE FROM incidents WHERE id LIKE 'inc_stk_%'",
  ).run();
}

describe("StakeholderStore", () => {
  afterEach(cleanup);

  it("subscribe is idempotent and reflected by isSubscribed/list", async () => {
    const store = new StakeholderStore(new D1Db(env.DB));
    expect(await store.isSubscribed("U_ALICE")).toBe(false);
    await store.subscribe("U_ALICE");
    await store.subscribe("U_ALICE"); // idempotent
    expect(await store.isSubscribed("U_ALICE")).toBe(true);
    expect(await store.list()).toEqual(["U_ALICE"]);
  });

  it("unsubscribe removes the user", async () => {
    const store = new StakeholderStore(new D1Db(env.DB));
    await store.subscribe("U_BOB");
    await store.unsubscribe("U_BOB");
    expect(await store.isSubscribed("U_BOB")).toBe(false);
    expect(await store.list()).toEqual([]);
  });
});

describe("homeBlocks", () => {
  it("shows an opt-in CTA and empty state when not a stakeholder", () => {
    const blocks = homeBlocks([], false) as any[];
    const json = JSON.stringify(blocks);
    expect(json).toContain("Include me in future incidents");
    expect(json).toContain(STAKEHOLDER_TOGGLE_ACTION);
    expect(json).toContain("No incidents yet");
    // the toggle carries value "on" so the handler subscribes
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements[0].value).toBe("on");
  });

  it("shows an opt-out CTA and lists incidents when a stakeholder", () => {
    const blocks = homeBlocks(
      [
        {
          id: "inc_stk_1",
          name: "Checkout 500s",
          status: "investigating",
          severity: "sev1",
          created_at: "2026-09-03T01:00:00Z",
          resolved_at: null,
        },
      ],
      true,
    ) as any[];
    const json = JSON.stringify(blocks);
    expect(json).toContain("Stop being a stakeholder");
    expect(json).toContain("Checkout 500s");
    expect(json).toContain("SEV1");
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements[0].value).toBe("off");
  });
});

describe("publishHomeView", () => {
  beforeEach(() =>
    __setStakeholderSlackClient(() => new FakeSlackClient(false)),
  );
  afterEach(async () => {
    __setStakeholderSlackClient(undefined);
    await cleanup();
  });

  it("publishes a home view reflecting stakeholder state", async () => {
    const fake = new FakeSlackClient(false);
    __setStakeholderSlackClient(() => fake);
    await new StakeholderStore(new D1Db(env.DB)).subscribe("U_ALICE");
    await publishHomeView(env as any, "U_ALICE");
    expect(fake.publishedViews).toHaveLength(1);
    expect(fake.publishedViews[0].userId).toBe("U_ALICE");
    expect(JSON.stringify(fake.publishedViews[0].blocks)).toContain(
      "Stop being a stakeholder",
    );
  });
});

describe("toggleStakeholder", () => {
  beforeEach(() =>
    __setStakeholderSlackClient(() => new FakeSlackClient(false)),
  );
  afterEach(async () => {
    __setStakeholderSlackClient(undefined);
    await cleanup();
  });

  it("turns the subscription on then off", async () => {
    const store = new StakeholderStore(new D1Db(env.DB));
    await toggleStakeholder(env as any, "U_CARE", true);
    expect(await store.isSubscribed("U_CARE")).toBe(true);
    await toggleStakeholder(env as any, "U_CARE", false);
    expect(await store.isSubscribed("U_CARE")).toBe(false);
  });
});

describe("inviteStakeholdersToChannel", () => {
  afterEach(cleanup);

  it("invites every subscriber to the channel", async () => {
    const fake = new FakeSlackClient(false);
    __setStakeholderSlackClient(() => fake);
    const store = new StakeholderStore(new D1Db(env.DB));
    await store.subscribe("U_ALICE");
    await store.subscribe("U_BOB");
    await inviteStakeholdersToChannel(env as any, "C_INC");
    __setStakeholderSlackClient(undefined);
    expect(fake.invited).toHaveLength(1);
    expect(fake.invited[0]).toMatchObject({
      channel: "C_INC",
      userIds: ["U_ALICE", "U_BOB"],
    });
  });

  it("is a no-op when there are no subscribers", async () => {
    const fake = new FakeSlackClient(false);
    __setStakeholderSlackClient(() => fake);
    await inviteStakeholdersToChannel(env as any, "C_INC");
    __setStakeholderSlackClient(undefined);
    expect(fake.invited).toHaveLength(0);
  });
});

describe("Home-tab toggle via interactivity endpoint", () => {
  beforeEach(() =>
    __setStakeholderSlackClient(() => new FakeSlackClient(false)),
  );
  afterEach(async () => {
    __setStakeholderSlackClient(undefined);
    await cleanup();
  });

  it("subscribes the caller from a signed block_actions toggle (no channel)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const payload = {
      type: "block_actions",
      user: { id: "U_ALICE" },
      // no channel — this is a Home-tab action
      actions: [{ action_id: STAKEHOLDER_TOGGLE_ACTION, value: "on" }],
    };
    const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const req = new Request("https://example.com/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": await sign(raw, ts),
      },
      body: raw,
    });
    const ctx = createExecutionContext();
    const res = await handleSlackInteractivity(req, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);

    expect(
      await new StakeholderStore(new D1Db(env.DB)).isSubscribed("U_ALICE"),
    ).toBe(true);
  });
});
