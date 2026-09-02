// Slack request signature verification (Web Crypto, HMAC-SHA256).
// See docs/ARCHITECTURE.md §4. Basestring: `v0:{timestamp}:{raw_body}`,
// signature: `v0=` + hex(HMAC_SHA256(signing_secret, basestring)).

const FIVE_MINUTES = 60 * 5;

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time string compare to avoid signature timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export interface SlackVerifyResult {
  ok: boolean;
  reason?: "missing_headers" | "stale_timestamp" | "bad_signature";
}

/**
 * Verify a Slack Events API request.
 * @param rawBody the EXACT raw request body string (do not re-serialize)
 * @param signingSecret SLACK_SIGNING_SECRET
 * @param nowSeconds current unix time in seconds (injectable for tests)
 */
export async function verifySlackRequest(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SlackVerifyResult> {
  const timestamp = headers.get("X-Slack-Request-Timestamp");
  const signature = headers.get("X-Slack-Signature");
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > FIVE_MINUTES) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(basestring));
  const expected = `v0=${hex(mac)}`;

  return timingSafeEqual(expected, signature)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}
