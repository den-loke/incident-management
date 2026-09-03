import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { routeSlackEvent, __setRouterSlackClient } from "../src/router";
import { ruleClassify, stripMention, __setIntentClassifier, FakeIntentClassifier } from "../src/incidents/intent";
import { declareIncident } from "../src/incidents/commands";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import { __setJointResolveSlackClient, getResolutionRequest } from "../src/incidents/jointResolve";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setControlsSlackClient } from "../src/incidents/controls";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";

describe("intent — ruleClassify", () => {
  it("stripMention removes a leading bot mention", () => {
    expect(stripMention("<@U_BOT> update please")).toBe("update please");
  });
  it("update please → update", () => {
    expect(ruleClassify("<@U_BOT> update please").action).toBe("update");
  });
  it("set status to identified → status", () => {
    const i = ruleClassify("<@U_BOT> set status to identified");
    expect(i.action).toBe("status");
    expect(i.status).toBe("identified");
  });
  it("this is sev1 → severity", () => {
    const i = ruleClassify("<@U_BOT> this is sev1");
    expect(i.action).toBe("severity");
    expect(i.severity).toBe("sev1");
  });
  it("escalate to @alice → escalate with target", () => {
    const i = ruleClassify("<@U_BOT> escalate to <@U_ALICE> need help");
    expect(i.action).toBe("escalate");
    expect(i.target).toBe("U_ALICE");
  });
  it("what's the summary? → summarize", () => {
    expect(ruleClassify("<@U_BOT> what's the summary?").action).toBe("summarize");
  });
  it("resolve → resolve", () => {
    expect(ruleClassify("<@U_BOT> resolve please").action).toBe("resolve");
  });
  it("gibberish → unknown", () => {
    expect(ruleClassify("<@U_BOT> asdfghjkl").action).toBe("unknown");
  });
});

describe("conversational control — router dispatch", () => {
  let slack: FakeSlackClient;
  beforeEach(() => {
    slack = new FakeSlackClient();
    __setIncidentClientOverrides({ slack: () => slack, summarizer: () => new FakeSummarizer() });
    __setRouterSlackClient(() => slack);
    __setJointResolveSlackClient(() => slack);
    __setStakeholderSlackClient(() => slack);
    __setRolesSlackClient(() => slack);
    __setControlsSlackClient(() => slack);
    __setIntentClassifier(() => new FakeIntentClassifier());
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setRouterSlackClient(undefined);
    __setJointResolveSlackClient(undefined);
    __setStakeholderSlackClient(undefined);
    __setRolesSlackClient(undefined);
    __setControlsSlackClient(undefined);
    __setIntentClassifier(undefined);
    for (const t of ["incident_resolution_requests", "incident_updates", "incident_roles", "incident_channels", "incidents"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  function mention(channel: string, text: string, user = "U_DEN") {
    return { type: "event_callback", event: { type: "app_mention", channel, user, text } } as Parameters<typeof routeSlackEvent>[0];
  }

  async function declareInChannel(name: string) {
    const { incidentId, channelId } = await declareIncident(env as any, name);
    return { incidentId, channelId };
  }

  it("@bot update please → posts an update", async () => {
    const { incidentId, channelId } = await declareInChannel("CV update");
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> update please"), env as any);
    expect(res.action).toBe("mention-actioned");
    expect(res.intent).toBe("update");
    const updates = await new D1Db(env.DB).all<{ body: string }>(
      "SELECT body FROM incident_updates WHERE incident_id = ?",
      [incidentId],
    );
    expect(updates.some((u) => u.body.includes("U_DEN"))).toBe(true);
  });

  it("@bot set status to identified → advances status", async () => {
    const { incidentId, channelId } = await declareInChannel("CV status");
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> set status to identified"), env as any);
    expect(res.intent).toBe("status");
    const row = await new D1Db(env.DB).get<{ status: string }>("SELECT status FROM incidents WHERE id = ?", [incidentId]);
    expect(row?.status).toBe("identified");
  });

  it("@bot this is sev1 → changes severity", async () => {
    const { incidentId, channelId } = await declareInChannel("CV sev");
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> this is sev1"), env as any);
    expect(res.intent).toBe("severity");
    const row = await new D1Db(env.DB).get<{ severity: string }>("SELECT severity FROM incidents WHERE id = ?", [incidentId]);
    expect(row?.severity).toBe("sev1");
  });

  it("@bot escalate to @alice → DMs the target + notes in-channel", async () => {
    const { channelId } = await declareInChannel("CV escalate");
    slack.posted.length = 0;
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> escalate to <@U_ALICE> need eyes"), env as any);
    expect(res.intent).toBe("escalate");
    expect(slack.posted.some((p) => p.channel === "U_ALICE")).toBe(true);
    expect(slack.posted.some((p) => p.channel === channelId && p.text.includes("<@U_ALICE>"))).toBe(true);
  });

  it("@bot resolve → requests joint resolution", async () => {
    const { incidentId, channelId } = await declareInChannel("CV resolve");
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> resolve please"), env as any);
    expect(res.intent).toBe("resolve");
    const req = await getResolutionRequest(env as any, incidentId);
    expect(req?.requested_by).toBe("U_DEN");
  });

  it("@bot summarize → posts an on-demand summary", async () => {
    const { channelId } = await declareInChannel("CV summary");
    const postsBefore = slack.posted.length;
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> what's the summary?"), env as any);
    expect(res.intent).toBe("summarize");
    expect(slack.posted.length).toBeGreaterThan(postsBefore); // a summary was posted
  });

  it("@bot gibberish → posts a help reply, no action", async () => {
    const { channelId } = await declareInChannel("CV unknown");
    slack.posted.length = 0;
    const res = await routeSlackEvent(mention(channelId, "<@U_BOT> asdfghjkl"), env as any);
    expect(res.intent).toBe("unknown");
    expect(slack.posted.some((p) => p.channel === channelId && p.text.includes("didn't catch that"))).toBe(true);
  });

  it("@bot in an UNMAPPED channel is ignored", async () => {
    const res = await routeSlackEvent(mention("C_RANDOM", "<@U_BOT> update please"), env as any);
    expect(res.action).toBe("ignored");
  });
});
