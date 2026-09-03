// HMAC-SHA256 verification for the on-call HTTP alert source. See
// docs/SPEC_ONCALL.md §4. Header: `X-Signature: sha256=<hex>` computed over the
// EXACT raw request body, keyed on ONCALL_ALERT_SECRET. Same primitive as Slack
// signing (src/slack/verify.ts), minus the timestamp basestring — monitoring
// sources (Datadog/Grafana/Alertmanager) sign the raw body directly.

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time compare to avoid signature timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/**
 * Verify `X-Signature: sha256=<hex>` over `rawBody` keyed on `secret`.
 * Returns false when the secret is unset (endpoint effectively disabled), the
 * header is missing/malformed, or the signature does not match.
 */
export async function verifyAlertSignature(
  headers: Headers,
  rawBody: string,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) return false;
  const header = headers.get("X-Signature");
  if (!header || !header.startsWith("sha256=")) return false;
  const provided = header.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return timingSafeEqual(hex(mac), provided);
}
