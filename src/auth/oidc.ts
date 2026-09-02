// "Sign in with Slack" (OpenID Connect). See docs/ARCHITECTURE.md §7.
//
// Flow:
//   GET  /auth/login    -> 302 to Slack's OIDC authorize endpoint (state cookie set)
//   GET  /auth/callback -> exchange code for an id_token (JWT), verify the workspace
//                          matches SLACK_TEAM_ID, mint a signed session cookie, 302 to /
//   GET  /auth/logout   -> clear the session cookie, 302 to /auth/login
//
// The workspace-membership check IS the authorization gate: we accept any member
// of SLACK_TEAM_ID and reject everyone else. We do not verify the id_token's RSA
// signature against Slack's JWKS here — the token is delivered over a direct
// server-to-server TLS call to slack.com in the code exchange, so its integrity
// is already assured by that channel. (A JWKS check can be added later if we ever
// accept tokens from a less-trusted path.)

import type { Env } from "../env";
import {
  SESSION_COOKIE,
  clearCookieHeader,
  makeSession,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
  type Session,
} from "./session";

const SLACK_AUTHORIZE = "https://slack.com/openid/connect/authorize";
const SLACK_TOKEN = "https://slack.com/api/openid.connect.token";
const OIDC_SCOPES = "openid profile";
const STATE_COOKIE = "incident_oidc_state";

function isBypass(env: Env): boolean {
  return env.AUTH_MODE === "bypass";
}

/** The stub session used when AUTH_MODE=bypass (E2E / local no-Slack dev). */
export function bypassSession(env: Env): Session {
  return makeSession({
    user_id: "U_E2E_USER",
    team_id: env.SLACK_TEAM_ID || "T_DEV",
    name: "E2E User",
  });
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

/** Decode a JWT payload WITHOUT signature verification (see module note). */
function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    return JSON.parse(atob(b64 + pad)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function redirectUri(url: URL): string {
  return `${url.origin}/auth/callback`;
}

// --- Route handlers -------------------------------------------------------

export function handleLogin(url: URL, env: Env): Response {
  // In bypass mode there is nothing to authorize against — go straight in.
  if (isBypass(env)) return redirect(`${url.origin}/`);

  const state = crypto.randomUUID();
  const authorize = new URL(SLACK_AUTHORIZE);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", OIDC_SCOPES);
  authorize.searchParams.set("client_id", env.SLACK_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri(url));
  authorize.searchParams.set("state", state);
  if (env.SLACK_TEAM_ID) authorize.searchParams.set("team", env.SLACK_TEAM_ID);

  const stateCookie = [
    `${STATE_COOKIE}=${state}`,
    "Path=/auth",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=600",
  ].join("; ");

  return redirect(authorize.toString(), { "Set-Cookie": stateCookie });
}

export async function handleCallback(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (isBypass(env)) {
    const cookie = sessionCookieHeader(await signSession(bypassSession(env), env.SLACK_SIGNING_SECRET));
    return redirect(`${url.origin}/`, { "Set-Cookie": cookie });
  }

  const err = url.searchParams.get("error");
  if (err) return htmlError(`Slack denied the sign-in request (${err}).`, 403);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = readCookie(request.headers.get("Cookie"), STATE_COOKIE);
  if (!code) return htmlError("Missing authorization code.", 400);
  if (!state || !expectedState || state !== expectedState) {
    return htmlError("Invalid OAuth state. Please try signing in again.", 400);
  }

  // Exchange the code for tokens (server-to-server, over TLS to slack.com).
  const body = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    client_secret: env.SLACK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(url),
  });
  const tokenResp = await fetch(SLACK_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const token = (await tokenResp.json()) as {
    ok?: boolean;
    error?: string;
    id_token?: string;
  };
  if (!token.ok || !token.id_token) {
    return htmlError(`Slack token exchange failed (${token.error ?? "unknown"}).`, 502);
  }

  const claims = decodeJwtPayload(token.id_token);
  if (!claims) return htmlError("Could not read the Slack identity token.", 502);

  const teamId =
    (claims["https://slack.com/team_id"] as string | undefined) ??
    (claims["team_id"] as string | undefined) ??
    "";
  const userId =
    (claims["https://slack.com/user_id"] as string | undefined) ??
    (claims["sub"] as string | undefined) ??
    "";
  const name = (claims["name"] as string | undefined) ?? userId;

  // The single-workspace allow-list. Membership in SLACK_TEAM_ID is the gate.
  if (!teamId || teamId !== env.SLACK_TEAM_ID) {
    return htmlError(
      "This dashboard is restricted to a single Slack workspace, and your account is not a member of it.",
      403,
    );
  }

  const session = makeSession({ user_id: userId, team_id: teamId, name });
  const cookie = sessionCookieHeader(await signSession(session, env.SLACK_SIGNING_SECRET));
  // Clear the transient state cookie too.
  const clearState = `${STATE_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  const headers = new Headers({ Location: `${url.origin}/` });
  headers.append("Set-Cookie", cookie);
  headers.append("Set-Cookie", clearState);
  return new Response(null, { status: 302, headers });
}

export function handleLogout(url: URL): Response {
  return redirect(`${url.origin}/auth/login`, { "Set-Cookie": clearCookieHeader() });
}

/**
 * Resolve the current session for a dashboard request, or null if unauthenticated.
 * In bypass mode a stub session is always returned.
 */
export async function getSession(request: Request, env: Env): Promise<Session | null> {
  if (isBypass(env)) return bypassSession(env);
  const raw = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!raw) return null;
  return verifySession(raw, env.SLACK_SIGNING_SECRET);
}

function htmlError(message: string, status: number): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
<body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#111">
<h1 style="font-size:1.25rem">Sign-in error</h1>
<p>${message}</p>
<p><a href="/auth/login">Try again</a></p>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
