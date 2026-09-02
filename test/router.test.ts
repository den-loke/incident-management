import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeSlackEvent } from "../src/router";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

let slack: FakeSlackClient;

beforeEach(() => {
  slack = new FakeSlackClient();
  __setIncidentClientOverrides({
    slack: () => slack,
    summarizer: () => new FakeSummarizer(),
  });
});
afterEach(() => __resetIncidentClientOverrides());

function callbackEvent(event: Record<string, unknown>) {
  return { type: "event_callback", event } as Parameters<
    typeof routeSlackEvent
  >[0];
}

describe("routeSlackEvent", () => {
  it("declares a new incident on a declare trigger and records the channel map", async () => {
    const res = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_ORIGIN",
        user: "U1",
        text: "/incident declare Checkout is down",
      }),
      env,
    );

    expect(res.action).toBe("declared");
    expect(res.incidentId).toBeTruthy();
    expect(res.channelId).toBeTruthy();

    const row = await env.DB.prepare(
      "SELECT incident_id, do_id FROM incident_channels WHERE channel = ?",
    )
      .bind(res.channelId)
      .first<{ incident_id: string; do_id: string }>();
    expect(row?.incident_id).toBe(res.incidentId);
  });

  it("routes a subsequent message in the incident channel to its DO", async () => {
    const declared = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_ORIGIN2",
        user: "U1",
        text: "declare Payments degraded",
      }),
      env,
    );
    const incidentChannel = declared.channelId!;

    const routed = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: incidentChannel,
        user: "U2",
        text: "still investigating",
      }),
      env,
    );

    expect(routed.action).toBe("routed");
    expect(routed.incidentId).toBe(declared.incidentId);
  });

  it("ignores messages in unmapped channels", async () => {
    const res = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_RANDOM",
        user: "U9",
        text: "just chatting",
      }),
      env,
    );
    expect(res.action).toBe("ignored");
  });

  it("ignores bot echoes and non-message events", async () => {
    const bot = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_X",
        bot_id: "B1",
        text: "declare loop",
      }),
      env,
    );
    expect(bot.action).toBe("ignored");

    const nonMsg = await routeSlackEvent(
      callbackEvent({ type: "reaction_added", user: "U1" }),
      env,
    );
    expect(nonMsg.action).toBe("ignored");
  });
});
