import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeSlackEvent } from "../src/router";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import {
  __setJointResolveSlackClient,
  confirmResolve,
  getResolutionRequest,
} from "../src/incidents/jointResolve";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";

let slack: FakeSlackClient;

beforeEach(() => {
  slack = new FakeSlackClient();
  __setIncidentClientOverrides({
    slack: () => slack,
    summarizer: () => new FakeSummarizer(),
  });
  __setJointResolveSlackClient(() => slack);
  __setStakeholderSlackClient(() => slack);
});
afterEach(() => {
  __resetIncidentClientOverrides();
  __setJointResolveSlackClient(undefined);
  __setStakeholderSlackClient(undefined);
});

function callbackEvent(event: Record<string, unknown>) {
  return { type: "event_callback", event } as Parameters<
    typeof routeSlackEvent
  >[0];
}

describe("routeSlackEvent", () => {
  it("publishes the Home tab on app_home_opened", async () => {
    const res = await routeSlackEvent(
      callbackEvent({ type: "app_home_opened", user: "U_ALICE", tab: "home" }),
      env as any,
    );
    expect(res.action).toBe("home-published");
    expect(slack.publishedViews).toHaveLength(1);
    expect(slack.publishedViews[0].userId).toBe("U_ALICE");
  });

  it("does not publish for a non-home tab open", async () => {
    const res = await routeSlackEvent(
      callbackEvent({
        type: "app_home_opened",
        user: "U_ALICE",
        tab: "messages",
      }),
      env as any,
    );
    expect(res.action).toBe("home-published");
    expect(slack.publishedViews).toHaveLength(0);
  });

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

  it("requests resolution on a resolve trigger, then a different person confirms", async () => {
    const declared = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_ORIGIN_RESOLVE",
        user: "U1",
        text: "declare API latency spike",
      }),
      env,
    );
    const incidentChannel = declared.channelId!;

    const requested = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: incidentChannel,
        user: "U2",
        text: "/incident resolve root cause was a bad deploy",
      }),
      env,
    );

    // Joint sign-off: the trigger REQUESTS resolution (does not resolve yet).
    expect(requested.action).toBe("resolve-requested");
    expect(requested.incidentId).toBe(declared.incidentId);
    const pending = await getResolutionRequest(env, declared.incidentId!);
    expect(pending?.requested_by).toBe("U2");
    expect(pending?.note).toContain("root cause was a bad deploy");

    // A DIFFERENT person confirms -> actually resolves (final note posted).
    const outcome = await confirmResolve(env, declared.incidentId!, "U3");
    expect(outcome.ok).toBe(true);
    const finalPost = slack.posted.at(-1);
    expect(finalPost?.text).toContain("root cause was a bad deploy");
  });

  it("refuses confirm by the same person who requested", async () => {
    const declared = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_ORIGIN_RESOLVE_SAME",
        user: "U1",
        text: "declare Same-person guard",
      }),
      env,
    );
    await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: declared.channelId!,
        user: "U2",
        text: "resolve",
      }),
      env,
    );
    const outcome = await confirmResolve(env, declared.incidentId!, "U2");
    expect(outcome).toEqual({ ok: false, reason: "same_person" });
  });

  it("treats a bare 'resolve' with no note as a resolve trigger (request)", async () => {
    const declared = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_ORIGIN_RESOLVE2",
        user: "U1",
        text: "declare Cache stampede",
      }),
      env,
    );

    const requested = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: declared.channelId!,
        user: "U2",
        text: "resolve",
      }),
      env,
    );

    expect(requested.action).toBe("resolve-requested");
  });

  it("does not treat a resolve-like word in an unmapped channel as a trigger", async () => {
    const res = await routeSlackEvent(
      callbackEvent({
        type: "message",
        channel: "C_RANDOM_RESOLVE",
        user: "U9",
        text: "resolve this later maybe",
      }),
      env,
    );
    // Unmapped channel -> ignored, resolve trigger only fires inside an
    // incident's own channel.
    expect(res.action).toBe("ignored");
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
