import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestAlert } from "../src/oncall/alerts";
import { promoteAlertToIncident } from "../src/oncall/escalation";
import { __setNotifierSlackClient } from "../src/oncall/notifier";
import {
  __setIncidentClientOverrides,
  __resetIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";

const KEY = "test_bridge_alert";
const FALLBACK = "C_bridge_fallback";

async function clean() {
  await env.DB.prepare(
    "DELETE FROM oncall_escalations WHERE alert_id IN (SELECT id FROM oncall_alerts WHERE dedup_key LIKE 'test_bridge_%')",
  ).run();
  await env.DB.prepare(
    "DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_bridge_%'",
  ).run();
  // The promotion declares a real incident; clean its rows too (title-scoped).
  await env.DB.prepare(
    "DELETE FROM incident_channels WHERE incident_id IN (SELECT id FROM incidents WHERE name LIKE 'BR_%')",
  ).run();
  await env.DB.prepare("DELETE FROM incident_updates WHERE incident_id IN (SELECT id FROM incidents WHERE name LIKE 'BR_%')").run();
  await env.DB.prepare("DELETE FROM incidents WHERE name LIKE 'BR_%'").run();
}

describe("alert → incident bridge (slice 5)", () => {
  let fake: FakeSlackClient;

  beforeEach(async () => {
    await clean();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    fake = new FakeSlackClient(false);
    __setNotifierSlackClient(() => fake);
    __setIncidentClientOverrides({ slack: () => fake, summarizer: () => new FakeSummarizer() });
  });

  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    __resetIncidentClientOverrides();
    delete (env as any).ONCALL_FALLBACK_CHANNEL;
    await clean();
  });

  it("promotes an alert: declares an incident, links it, posts a back-link into the paging channel", async () => {
    const out = await ingestAlert(env as any, { title: "BR_disk", dedup_key: KEY, severity: "sev1" });
    if (out.result !== "created") throw new Error("expected created");

    const res = await promoteAlertToIncident(env as any, out.alert.id);
    expect(res).not.toBeNull();
    const incidentId = res!.incidentId;

    // Alert is linked to the new incident.
    const linked = await env.DB.prepare("SELECT incident_id FROM oncall_alerts WHERE id = ?")
      .bind(out.alert.id).first<{ incident_id: string }>();
    expect(linked?.incident_id).toBe(incidentId);

    // A back-link was posted into the paging (fallback) channel, referencing the
    // incident channel via a <#...> mention.
    const notice = fake.posted.find((p) => p.channel === FALLBACK && p.text.includes("promoted to incident"));
    expect(notice).toBeTruthy();
    expect(notice!.text).toMatch(/<#C_/);
  });

  it("is idempotent: promoting an already-linked alert returns the same incident and posts nothing new", async () => {
    const out = await ingestAlert(env as any, { title: "BR_flap", dedup_key: KEY });
    if (out.result !== "created") throw new Error("expected created");

    const first = await promoteAlertToIncident(env as any, out.alert.id);
    const postsAfterFirst = fake.posted.length;
    const second = await promoteAlertToIncident(env as any, out.alert.id);

    expect(second?.incidentId).toBe(first?.incidentId);
    expect(fake.posted.length).toBe(postsAfterFirst); // no duplicate notice / channel
  });

  it("returns null for an unknown alert id", async () => {
    const res = await promoteAlertToIncident(env as any, "alert_does_not_exist");
    expect(res).toBeNull();
  });
});
