// Signed session cookies for the dashboard. See docs/ARCHITECTURE.md §7.
//
// We do not persist sessions server-side. The session is a small JSON payload
// (Slack user_id, team_id, display name, expiry) carried in a cookie and
// tamper-proofed with an HMAC-SHA256 signature keyed on SLACK_SIGNING_SECRET
// (the same secret already present in every deployment). Format:
//
//   <base64url(json)>.<base64url(hmac(base64url(json)))>
//
// Web Crypto only — no node:crypto, works on workerd.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE = "incident_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 8; // 8h

export interface Session {
  /** Slack user id (e.g. U123). Dashboard identity == Slack identity. */
  user_id: string;
  /** Slack team/workspace id; must equal SLACK_TEAM_ID. */
  team_id: string;
  /** Display name for the UI, best-effort. */
  name: string;
  /** Unix seconds at which this session expires. */
  exp: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return b64urlEncode(new Uint8Array(mac));
}

/** Sign a session into a cookie value. */
export async function signSession(
  session: Session,
  secret: string,
): Promise<string> {
  const payload = b64urlEncode(encoder.encode(JSON.stringify(session)));
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

/** Verify + parse a cookie value. Returns null on any tamper / expiry / parse error. */
export async function verifySession(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<Session | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmac(secret, payload);
  if (!timingSafeEqual(expected, sig)) return null;

  let session: Session;
  try {
    session = JSON.parse(decoder.decode(b64urlDecode(payload))) as Session;
  } catch {
    return null;
  }
  if (
    typeof session.user_id !== "string" ||
    typeof session.team_id !== "string" ||
    typeof session.exp !== "number"
  ) {
    return null;
  }
  if (session.exp <= nowSeconds) return null;
  return session;
}

export function makeSession(
  fields: Omit<Session, "exp">,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Session {
  return { ...fields, exp: nowSeconds + ttlSeconds };
}

/** Build a Set-Cookie header value for the signed session. */
export function sessionCookieHeader(
  value: string,
  maxAgeSeconds: number = DEFAULT_TTL_SECONDS,
): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

/** Build a Set-Cookie header that clears the session. */
export function clearCookieHeader(): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");
}

/** Read a named cookie from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
