import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Db } from "../src/status/d1";
import {
  declareIncident,
  postIncidentUpdate,
  resolveIncident,
} from "../src/incidents/commands";
import { setSeverity } from "../src/incidents/severity";
import { claimRole } from "../src/roles/service";
import {
  __setDashboardSlackClient,
  dashboardBlocks,
  type DashboardState,
} from "../src/incidents/dashboard";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { __setControlsSlackClient } from "../src/incidents/controls";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { __setJointResolveSlackClient } from "../src/incidents/jointResolve";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

function wire(fake: FakeSlackClient) {
  __setDashboardSlackClient(() => fake);
  __setControlsSlackClient(() => fake);
  __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
  __setRolesSlackClient(() => fake);
  __setStakeholderSlackClient(() => fake);
  __setJointResolveSlackClient(() => fake);
}
function unwire() {
  __setDashboardSlackClient(undefined);
  __setControlsSlackClient(undefined);
  __resetIncidentClientOverrides();
  __setRolesSlackClient(undefined);
  __setStakeholderSlackClient(undefined);
  __setJointResolveSlackClient(undefined);
}

async function dashTs(incidentId: string): Promise<string | null> {
  const row = await new D1Db(env.DB).get<{ dashboard_ts: string | null }>(
    "SELECT dashboard_ts FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row?.dashboard_ts ?? null;
}

describe("sticky incident dashboard", () => {
  let fake: FakeSlackClient;
  beforeEach(() => {
    fake = new FakeSlackClient(false);
    wire(fake);
  });
  afterEach(async () => {
    unwire();
    for (const t of [
      "incident_resolution_requests",
      "incident_updates",
      "incident_roles",
      "incidents",
      "incident_channels",
    ]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("declare posts ONE dashboard, pins it, and stores its ts", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "Checkout down");

    const dash = fake.postedBlocks.filter((b) => b.channel === channelId);
    // Exactly one Block Kit message on the channel — the unified dashboard,
    // not a separate roles panel + controls panel.
    expect(dash).toHaveLength(1);
    const ts = dash[0].ts;

    // It is pinned.
    expect(fake.pinned.some((p) => p.channel === channelId && p.ts === ts)).toBe(true);
    // Its ts is stored for later in-place edits.
    expect(await dashTs(incidentId)).toBe(ts);
    // It carries a header naming the incident.
    const header = (dash[0].blocks as any[]).find((b) => b.type === "header");
    expect(header.text.text).toContain(incidentId);
    expect(header.text.text).toContain("Checkout down");
  });

  it("a status change edits the pinned card in place (no new panel)", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "DB latency");
    const beforePosts = fake.postedBlocks.filter((b) => b.channel === channelId).length;
    fake.updated.length = 0;

    await postIncidentUpdate(env as any, incidentId, "Found the cause", "identified");

    // No additional Block Kit panel posted…
    expect(fake.postedBlocks.filter((b) => b.channel === channelId).length).toBe(beforePosts);
    // …the pinned message was edited instead, and now shows Identified.
    const ts = await dashTs(incidentId);
    const edit = fake.updated.find((u) => u.channel === channelId && u.ts === ts);
    expect(edit).toBeTruthy();
    expect(edit!.text).toContain("Identified");
  });

  it("a severity change edits the pinned card in place", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "Payments flaky");
    fake.updated.length = 0;

    await setSeverity(env as any, incidentId, "sev1");

    const ts = await dashTs(incidentId);
    const edit = fake.updated.find((u) => u.channel === channelId && u.ts === ts);
    expect(edit).toBeTruthy();
    expect(edit!.text).toContain("SEV1");
  });

  it("a role claim edits the pinned card in place (holder shown)", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "Auth outage");
    fake.updated.length = 0;

    await claimRole(env as any, incidentId, channelId, "engineering_lead", "U_ENG");

    const ts = await dashTs(incidentId);
    const edit = fake.updated.find((u) => u.channel === channelId && u.ts === ts);
    expect(edit).toBeTruthy();
    expect(edit!.text).toContain("<@U_ENG>");
  });

  it("resolve edits the card to Resolved and drops the action buttons", async () => {
    const { incidentId, channelId } = await declareIncident(env as any, "Cache miss storm");
    fake.updated.length = 0;

    await resolveIncident(env as any, incidentId, "All good");

    const ts = await dashTs(incidentId);
    const edit = fake.updated.find((u) => u.channel === channelId && u.ts === ts);
    expect(edit).toBeTruthy();
    expect(edit!.text).toContain("Resolved");
    // No actions blocks on a resolved card.
    const hasActions = (edit!.blocks as any[]).some((b) => b.type === "actions");
    expect(hasActions).toBe(false);
  });

  it("dashboardBlocks renders roles + control buttons for an active incident", () => {
    const state: DashboardState = {
      incidentId: "INC-1",
      name: "Test",
      status: "investigating",
      severity: "sev2",
      routingPath: "internal",
      holders: { engineering_lead: "U_A" },
    };
    const blocks = dashboardBlocks(state) as any[];
    const actionBlocks = blocks.filter((b) => b.type === "actions");
    // One roles action block + one controls action block.
    expect(actionBlocks).toHaveLength(2);
    const rolesBlock = actionBlocks.find((b) => b.block_id === "inc_dash_roles");
    const controlsBlock = actionBlocks.find((b) => b.block_id === "inc_dash_controls");
    expect(rolesBlock.elements.length).toBe(2); // two roles internally
    expect(controlsBlock.elements.length).toBe(5); // five controls
  });

  it("external routing shows only the Customer Support Lead role", () => {
    const blocks = dashboardBlocks({
      incidentId: "INC-2",
      name: "Partner outage",
      status: "investigating",
      severity: "sev2",
      routingPath: "external",
      holders: {},
    }) as any[];
    const rolesBlock = blocks
      .filter((b) => b.type === "actions")
      .find((b) => b.block_id === "inc_dash_roles");
    expect(rolesBlock.elements.length).toBe(1);
  });
});
