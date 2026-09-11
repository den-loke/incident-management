import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIncidentContext,
  renderContext,
  fallbackAnswer,
  answerMention,
  FakeIncidentAnswerer,
  __setIncidentAnswerer,
  type IncidentContext,
} from "../src/incidents/answerer";
import { declareIncident, postIncidentUpdate } from "../src/incidents/commands";
import { setSeverity } from "../src/incidents/severity";
import { claimRole } from "../src/roles/service";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import { __setRolesSlackClient } from "../src/roles/service";
import { __setControlsSlackClient } from "../src/incidents/controls";
import { __setStakeholderSlackClient } from "../src/stakeholders/service";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

describe("incident answerer", () => {
  const created: string[] = [];
  beforeEach(() => {
    const fake = new FakeSlackClient(false);
    __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
    __setRolesSlackClient(() => fake);
    __setControlsSlackClient(() => fake);
    __setStakeholderSlackClient(() => fake);
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    __setRolesSlackClient(undefined);
    __setControlsSlackClient(undefined);
    __setStakeholderSlackClient(undefined);
    __setIncidentAnswerer(undefined);
    for (const id of created.splice(0)) {
      await env.DB.prepare("DELETE FROM incident_updates WHERE incident_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM incident_roles WHERE incident_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM incident_channels WHERE incident_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(id).run();
    }
  });

  async function declare(name: string) {
    const r = await declareIncident(env as any, name);
    created.push(r.incidentId);
    return r;
  }

  it("buildIncidentContext reflects real incident state", async () => {
    const { incidentId, channelId } = await declare("Checkout down");
    await setSeverity(env as any, incidentId, "sev1");
    await claimRole(env as any, incidentId, channelId, "engineering_lead", "U_ENG");
    await postIncidentUpdate(env as any, incidentId, "found the bad deploy", "identified");

    const ctx = await buildIncidentContext(env as any, incidentId);
    expect(ctx).toBeTruthy();
    expect(ctx!.name).toBe("Checkout down");
    expect(ctx!.severity).toContain("SEV1");
    expect(ctx!.status).toBe("identified");
    expect(ctx!.roles.some((r) => r.holder === "U_ENG")).toBe(true);
    expect(ctx!.timeline.some((t) => t.body.includes("found the bad deploy"))).toBe(true);
  });

  it("buildIncidentContext returns null for an unknown incident", async () => {
    expect(await buildIncidentContext(env as any, "INC-nope")).toBeNull();
  });

  it("renderContext includes the grounded facts", () => {
    const ctx: IncidentContext = {
      incidentId: "INC-9",
      name: "DB latency",
      status: "monitoring",
      severity: "SEV2",
      routingPath: "internal",
      createdAt: "2026-09-11T00:00:00.000Z",
      resolvedAt: null,
      roles: [{ role: "Engineering Lead", holder: "U_A" }],
      onCall: "Alice",
      durations: { total_seconds: 3600, time_to_identify_seconds: 600, time_to_resolve_seconds: null },
      timeline: [{ at: "2026-09-11T00:05:00.000Z", status: "investigating", body: "looking" }],
    };
    const text = renderContext(ctx);
    expect(text).toContain("INC-9");
    expect(text).toContain("DB latency");
    expect(text).toContain("SEV2");
    expect(text).toContain("<@U_A>");
    expect(text).toContain("Alice");
    expect(text).toContain("looking");
    expect(text).toContain("1h 0m"); // total duration formatted
  });

  it("fallbackAnswer is grounded in status/severity/roles", () => {
    const ctx: IncidentContext = {
      incidentId: "INC-3",
      name: "Auth outage",
      status: "investigating",
      severity: "SEV1",
      routingPath: "internal",
      createdAt: "x",
      resolvedAt: null,
      roles: [{ role: "Engineering Lead", holder: "U_ENG" }],
      onCall: null,
      durations: { total_seconds: null, time_to_identify_seconds: null, time_to_resolve_seconds: null },
      timeline: [],
    };
    const a = fallbackAnswer(ctx);
    expect(a).toContain("INC-3");
    expect(a).toContain("investigating");
    expect(a).toContain("SEV1");
    expect(a).toContain("<@U_ENG>");
  });

  it("answerMention answers via the injected answerer", async () => {
    const { incidentId } = await declare("Payments flaky");
    const fake = new FakeIncidentAnswerer();
    __setIncidentAnswerer(() => fake);
    const reply = await answerMention(env as any, incidentId, "how bad is it?");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].question).toBe("how bad is it?");
    expect(reply).toContain(incidentId);
  });

  it("answerMention handles an unknown incident gracefully", async () => {
    const reply = await answerMention(env as any, "INC-nope", "status?");
    expect(reply.toLowerCase()).toContain("couldn't find");
  });
});
