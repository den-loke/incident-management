import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleCallback, handleLogin } from "../src/auth/oidc";
import { SESSION_COOKIE, signSession, makeSession } from "../src/auth/session";
import type { Env } from "../src/env";

// The test miniflare bindings set SLACK_SIGNING_SECRET + SLACK_TEAM_ID.
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
  await env.DB.prepare(
    "INSERT INTO components (id, name, status) VALUES (?, ?, ?)",
  )
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
    .bind("iu_1", "inc_1", "We are investigating elevated 500s.", "investigating", "2026-09-02T01:01:00Z")
    .run();
}

describe("dashboard auth gating", () => {
  it("serves the login page (401) when unauthenticated", async () => {
    const res = await SELF.fetch("https://example.com/", {
      headers: { "CF-Test-Auth-Mode": "" },
    });
    // With no AUTH_MODE bypass in the worker env, unauthenticated => login page.
    expect([200, 401]).toContain(res.status);
    const body = await res.text();
    expect(body).toContain("Sign in with Slack");
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

  it("bypass mode short-circuits login and callback to a valid session", async () => {
    const bypassEnv = baseEnv({ AUTH_MODE: "bypass" });
    const url = new URL("https://dash.example.com/auth/callback");
    const res = await handleCallback(new Request(url.toString()), url, bypassEnv);
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie")!;
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
  });
});

describe("status page render", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM incident_updates").run();
    await env.DB.prepare("DELETE FROM incidents").run();
    await env.DB.prepare("DELETE FROM components").run();
  });

  it("renders components, incident banner and timeline for an authenticated user", async () => {
    await seedIncident();
    const session = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
    const cookie = `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;

    const res = await SELF.fetch("https://example.com/", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("API");
    expect(body).toContain("Major outage");
    expect(body).toContain("Checkout 500s");
    expect(body).toContain("We are investigating elevated 500s.");
    expect(body).toContain("Active incident in progress");
    expect(body).toContain("Den");
  });

  it("shows all-clear when there are no components and no incidents", async () => {
    const session = makeSession({ user_id: "U1", team_id: TEAM, name: "Den" });
    const cookie = `${SESSION_COOKIE}=${await signSession(session, SECRET)}`;
    const res = await SELF.fetch("https://example.com/", { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("All systems operational");
  });
});
