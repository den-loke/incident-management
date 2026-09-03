// Verify inbound Twilio webhook requests (SMS/voice ack). See docs/SPEC_ONCALL.md §3a.
//
// Twilio signs a form-POST with HMAC-SHA1 over the full request URL followed by
// each POST parameter's key and value concatenated, in ALPHABETICAL order by
// key, base64-encoded, in the `X-Twilio-Signature` header. Keyed on the account
// auth token (ONCALL_TWILIO_AUTH_TOKEN). This is Twilio's documented scheme:
// https://www.twilio.com/docs/usage/security#validating-requests
//
// Returns false when the token is unset (endpoint effectively disabled), the
// header is missing, or the signature does not match — never throws.

const encoder = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Verify `X-Twilio-Signature` for a form-encoded webhook.
 *
 * @param url    the exact public URL Twilio POSTed to (scheme+host+path+query)
 * @param params the parsed POST body params
 * @param header the X-Twilio-Signature header value
 * @param token  ONCALL_TWILIO_AUTH_TOKEN (undefined = disabled → false)
 */
export async function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string | null,
  token: string | undefined,
): Promise<boolean> {
  if (!token || !header) return false;

  // Base string: URL + each param key+value concatenated, keys sorted asc.
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return timingSafeEqual(base64(mac), header);
}
