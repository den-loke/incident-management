import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import {
  createJiraForIncident,
  linkExistingJira,
  listIncidentLinks,
  isJiraKey,
} from "../src/incidents/externalLinks";
import { __setIssueTracker, FakeIssueTracker } from "../src/clients/jira";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

async function cookie() {
  return `${SESSION_COOKIE}=${await signSession(makeSession({ user_id: "U_JIRA", team_id: TEAM, name: "Den" }), SECRET)}`;
}
async function seedIncident(id: string) {
  await env.DB.prepare(
    `INSERT INTO incidents (id, name, status, severity, routing_path, created_at) VALUES (?, ?, 'investigating', 'sev1', 'internal', ?)`,
  ).bind(id, `${id} outage`, "2026-09-02T00:00:00.000Z").run();
}

describe("incident external links (Jira)", () => {
  beforeEach(async () => {
    for (const t of ["incident_external_links", "incidents"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });
  afterEach(async () => {
    __setIssueTracker(undefined);
    for (const t of ["incident_external_links", "incidents"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("isJiraKey validates ABC-123 shape", () => {
    expect(isJiraKey("INC-42")).toBe(true);
    expect(isJiraKey("ABC-1")).toBe(true);
    expect(isJiraKey("inc-42")).toBe(false);
    expect(isJiraKey("42")).toBe(false);
    expect(isJiraKey("INC")).toBe(false);
  });

  it("createJiraForIncident creates an issue + stores the link", async () => {
    __setIssueTracker(() => new FakeIssueTracker());
    await seedIncident("INC-1");
    const out = await createJiraForIncident(env as any, "INC-1", "web:U1");
    expect(out.result).toBe("created");
    const links = await listIncidentLinks(env as any, "INC-1");
    expect(links).toHaveLength(1);
    expect(links[0].provider).toBe("jira");
    expect(links[0].external_key).toMatch(/^INC-\d+$/);
  });

  it("createJiraForIncident is unconfigured when Jira env is unset", async () => {
    __setIssueTracker(() => null);
    await seedIncident("INC-2");
    expect((await createJiraForIncident(env as any, "INC-2", "web:U1")).result).toBe("unconfigured");
  });

  it("createJiraForIncident returns not_found for an unknown incident", async () => {
    __setIssueTracker(() => new FakeIssueTracker());
    expect((await createJiraForIncident(env as any, "INC-nope", "web:U1")).result).toBe("not_found");
  });

  it("linkExistingJira records a link (idempotent) without calling Jira", async () => {
    await seedIncident("INC-3");
    const a = await linkExistingJira(env as any, "INC-3", "ops-99", "web:U1"); // lower-case → upcased
    expect(a.result).toBe("linked");
    if (a.result === "linked") expect(a.link.external_key).toBe("OPS-99");
    // Re-link the same key → idempotent (UNIQUE), still one row.
    await linkExistingJira(env as any, "INC-3", "OPS-99", "web:U1");
    expect(await listIncidentLinks(env as any, "INC-3")).toHaveLength(1);
  });

  it("linkExistingJira rejects a malformed key", async () => {
    await seedIncident("INC-4");
    expect((await linkExistingJira(env as any, "INC-4", "not a key", "web:U1")).result).toBe("invalid_key");
  });

  it("POST /api/incidents/:id/jira/link is session-gated and 400s a bad key", async () => {
    await seedIncident("INC-5");
    // unauthenticated
    expect(
      (await SELF.fetch("https://x/api/incidents/INC-5/jira/link", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "OPS-1" }),
      })).status,
    ).toBe(401);
    const c = await cookie();
    const bad = await SELF.fetch("https://x/api/incidents/INC-5/jira/link", {
      method: "POST", headers: { "content-type": "application/json", Cookie: c }, body: JSON.stringify({ key: "nope" }),
    });
    expect(bad.status).toBe(400);
    const ok = await SELF.fetch("https://x/api/incidents/INC-5/jira/link", {
      method: "POST", headers: { "content-type": "application/json", Cookie: c }, body: JSON.stringify({ key: "OPS-7" }),
    });
    expect(ok.status).toBe(201);
    expect((await listIncidentLinks(env as any, "INC-5"))[0].external_key).toBe("OPS-7");
  });

  it("POST /api/incidents/:id/jira 409s when Jira is unconfigured", async () => {
    __setIssueTracker(() => null);
    await seedIncident("INC-6");
    const c = await cookie();
    const res = await SELF.fetch("https://x/api/incidents/INC-6/jira", {
      method: "POST", headers: { "content-type": "application/json", Cookie: c }, body: "{}",
    });
    expect(res.status).toBe(409);
  });
});
