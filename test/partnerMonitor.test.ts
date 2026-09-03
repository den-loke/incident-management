import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseFeeds,
  pollPartner,
  pollPartnerStatus,
  __setPartnerFetch,
  type PartnerFeed,
} from "../src/oncall/partnerMonitor";
import { __setNotifierSlackClient } from "../src/oncall/notifier";
import { FakeSlackClient } from "../src/clients/fakeSlack";

const FEED: PartnerFeed = { id: "acme_pos", name: "Acme POS", url: "https://acme.example/api/v2/status.json" };
const KEY = "partner:acme_pos";
const FALLBACK = "C_partner_fallback";

function stubStatus(indicator: string, description = "") {
  __setPartnerFetch(async () =>
    new Response(JSON.stringify({ status: { indicator, description } }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

async function openForKey(): Promise<number> {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM oncall_alerts WHERE dedup_key = ? AND status IN ('firing','ack')",
  ).bind(KEY).first<{ n: number }>();
  return r?.n ?? 0;
}

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key = ?").bind(KEY).run();
}

describe("partner monitor — config", () => {
  it("parseFeeds returns [] when unset or invalid, parses a valid array", () => {
    expect(parseFeeds({} as any)).toEqual([]);
    expect(parseFeeds({ PARTNER_STATUS_FEEDS: "not json" } as any)).toEqual([]);
    expect(parseFeeds({ PARTNER_STATUS_FEEDS: JSON.stringify([FEED]) } as any)).toEqual([FEED]);
  });

  it("pollPartnerStatus is a no-op when unconfigured", async () => {
    expect(await pollPartnerStatus({ ...(env as any), PARTNER_STATUS_FEEDS: undefined })).toEqual({ polled: 0 });
  });
});

describe("partner monitor — polling", () => {
  let fake: FakeSlackClient;
  beforeEach(async () => {
    await clean();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    fake = new FakeSlackClient(false);
    __setNotifierSlackClient(() => fake);
  });
  afterEach(async () => {
    __setPartnerFetch(undefined);
    __setNotifierSlackClient(undefined);
    delete (env as any).ONCALL_FALLBACK_CHANNEL;
    await clean();
  });

  it("opens an external alert when a partner is not operational (+ comms notice, no page)", async () => {
    stubStatus("major", "Partial outage");
    expect(await pollPartner(env as any, FEED)).toBe("firing");
    expect(await openForKey()).toBe(1);
    const row = await env.DB.prepare("SELECT route, severity FROM oncall_alerts WHERE dedup_key = ?")
      .bind(KEY).first<{ route: string; severity: string }>();
    expect(row?.route).toBe("external");
    expect(row?.severity).toBe("sev2"); // major → sev2
    // Comms notice posted to the fallback channel; NO escalation ladder.
    expect(fake.postedBlocks.some((b) => b.channel === FALLBACK && b.text.includes("Upstream alert"))).toBe(true);
    const esc = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM oncall_escalations e JOIN oncall_alerts a ON a.id=e.alert_id WHERE a.dedup_key = ?",
    ).bind(KEY).first<{ n: number }>();
    expect(esc?.n ?? 0).toBe(0);
  });

  it("dedups a still-firing partner (one open alert, notice only once)", async () => {
    stubStatus("major", "Partial outage");
    await pollPartner(env as any, FEED);
    const notices1 = fake.postedBlocks.filter((b) => b.channel === FALLBACK).length;
    await pollPartner(env as any, FEED); // still down
    expect(await openForKey()).toBe(1);
    expect(fake.postedBlocks.filter((b) => b.channel === FALLBACK).length).toBe(notices1); // no re-notify
  });

  it("auto-resolves when the partner recovers", async () => {
    stubStatus("critical", "Full outage");
    await pollPartner(env as any, FEED);
    expect(await openForKey()).toBe(1);
    stubStatus("none");
    expect(await pollPartner(env as any, FEED)).toBe("recovered");
    expect(await openForKey()).toBe(0);
  });

  it("operational with nothing open is a no-op", async () => {
    stubStatus("none");
    expect(await pollPartner(env as any, FEED)).toBe("ok");
    expect(await openForKey()).toBe(0);
  });

  it("a feed HTTP error is skipped (no alert, no throw)", async () => {
    __setPartnerFetch(async () => new Response("nope", { status: 500 }));
    expect(await pollPartner(env as any, FEED)).toBe("error");
    expect(await openForKey()).toBe(0);
  });
});
