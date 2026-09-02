import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCallback, handleLogin } from "../src/auth/oidc";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import type { Env } from "../src/env";
import type { StatusPayload } from "../src/ui/statusPage";

const SECRET = "e2e-signing-secret";
const TEAM = "T_E2E";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_TEAM_ID: TEAM,
    SLACK_CLIENT_ID: "client-id",
    SLACK_CLIENT_SECRET: "client-secret",
    ...overrides,
  } as Env;
}

async function seedIncident() {
  await env.DB.prepare("INSERT INTO components (id, name, status) VALUES (?, ?, ?)")
    .bind("cmp_api", "API", "major_outage")
    .run();
  await env.DB.prepare(
    "INSERT INTO incidents (id, name, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("inc_1", "Checkout 500s", "investigating", "2026-09-02T01:00:00Z", null)
    .run();
  await env.DB.prepare(
    "INSERT INTO incident_updates (id, incident_id, body, status, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("iu_1", "inc_1", "Investigating elevated 500s.", "investigating", "2026-09-02T01:01:00Z")
    .run();
}

describe("dashboard auth gating", () => {
  it("returns 401 from /api/status when unauthenticated", async () => {
    const res = await SELF.fetch("https://example.com/api/status");
    expect(res.status).toBe(401);
  });

  it("login redirects to Slack authorize with the right params", () => {
    const res = handleLogin(new URL("https://dash.example.com/auth/login"), baseEnv());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(loc.origin + loc.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(loc.searchParams.get("client_id")).toBe("client-id");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://dash.example.com/auth/callback");
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(res.headers.get("Set-Cookie")).toContain("incident_oidc_state=");
  });

  it("bypass mode short-circuits callback to a valid session cookie", async () => {
    const bypassEnv = baseEnv({ AUTH_MODE: "bypass" });
    const url = new URL("https://dash.example.com/auth/callback");
    const res = await handleCallback(new Request(url.toString()), url, bypassEnv);
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")!).toContain(`${SESSION_COOKIE}=`);
  });
});

describe("status API", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM incident_updates").run();
    await env.DB.prepare("DELETE FROM incidents").run();
    await env.DB.prepare("DELETE FROM components").run();
  });

  it("returns the status payload for an authenticated user", async () => {
    await seedIncident();
    const session = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
    const cookie = `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;

    const res = await SELF.fetch("https://example.com/api/status", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusPayload;
    expect(body.viewer).toMatchObject({ user_id: "U1", name: "Den" });
    expect(body.components.find((c) => c.name === "API")?.status).toBe("major_outage");
    const inc = body.incidents.find((i) => i.id === "inc_1");
    expect(inc?.name).toBe("Checkout 500s");
    expect(inc?.updates[0]?.body).toContain("Investigating elevated 500s.");
  });

  it("returns empty arrays when nothing is seeded", async () => {
    const session = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
    const cookie = `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;
    const res = await SELF.fetch("https://example.com/api/status", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatusPayload;
    expect(body.components).toEqual([]);
    expect(body.incidents).toEqual([]);
  });
});
