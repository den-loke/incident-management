import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetIncidentClientOverrides,
  __setIncidentClientOverrides,
} from "../src/incident";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeSummarizer } from "../src/clients/fakeOpenai";
import { D1Db } from "../src/status/d1";
import { recordIncidentMessage, listIncidentMessages } from "../src/incidents/messages";

function command(body: unknown): Request {
  return new Request("https://do/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function stubFor(name: string) {
  return env.INCIDENT.get(env.INCIDENT.idFromName(name));
}
async function wipe() {
  for (const t of ["incident_messages", "incident_channels", "incident_updates", "incidents"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
}

describe("incident conversation transcript", () => {
  beforeEach(async () => {
    __setIncidentClientOverrides({ slack: () => new FakeSlackClient(), summarizer: () => new FakeSummarizer() });
    await wipe();
  });
  afterEach(async () => {
    __resetIncidentClientOverrides();
    await wipe();
  });

  it("store records human + bot messages and lists them chronologically", async () => {
    const db = new D1Db(env.DB);
    await env.DB.prepare(
      "INSERT INTO incidents (id, name, status, severity, routing_path, created_at) VALUES ('INC-1','x','investigating','sev2','internal','2026-09-02T00:00:00.000Z')",
    ).run();
    await recordIncidentMessage(db, "INC-1", { kind: "bot", text: "declared", ts: "2026-09-02T00:00:00.000Z" });
    await recordIncidentMessage(db, "INC-1", { kind: "human", text: "looking now", slackUserId: "U1", ts: "2026-09-02T00:01:00.000Z" });
    await recordIncidentMessage(db, "INC-1", { kind: "human", text: "  ", slackUserId: "U1" }); // blank → skipped
    const msgs = await listIncidentMessages(db, "INC-1");
    expect(msgs.map((m) => m.text)).toEqual(["declared", "looking now"]);
    expect(msgs[1]).toMatchObject({ kind: "human", slack_user_id: "U1" });
  });

  it("DO captures a human message command into the transcript", async () => {
    const incidentId = `INC-msg-${crypto.randomUUID().slice(0, 8)}`;
    const stub = stubFor(incidentId);
    await stub.fetch(command({ cmd: "declare", name: "Outage", body: "500s", id: incidentId }));
    await stub.fetch(command({ cmd: "message", user: "U_ALICE", text: "I see it too, checking the deploy" }));

    // Read inside the DO's own context to avoid a concurrent test file's
    // DELETE FROM incidents (shared D1) wiping the row between write and read.
    const msgs = await runInDurableObject(stub, async () =>
      listIncidentMessages(new D1Db(env.DB), incidentId),
    );
    const human = msgs.filter((m) => m.kind === "human");
    expect(human).toHaveLength(1);
    expect(human[0]).toMatchObject({ slack_user_id: "U_ALICE", text: "I see it too, checking the deploy" });
    expect(msgs.some((m) => m.kind === "bot" && m.text.includes("500s"))).toBe(true);
  });

  it("DO records its own posted updates as bot transcript entries", async () => {
    const incidentId = `INC-upd-${crypto.randomUUID().slice(0, 8)}`;
    const stub = stubFor(incidentId);
    await stub.fetch(command({ cmd: "declare", name: "Outage", id: incidentId }));
    await stub.fetch(command({ cmd: "postUpdate", body: "Rolling back the bad deploy", status: "identified" }));

    const msgs = await runInDurableObject(stub, async () =>
      listIncidentMessages(new D1Db(env.DB), incidentId),
    );
    expect(msgs.some((m) => m.kind === "bot" && m.text === "Rolling back the bad deploy")).toBe(true);
  });
});
