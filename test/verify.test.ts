import { describe, expect, it } from "vitest";
import { verifySlackRequest } from "../src/slack/verify";

const SECRET = "test-signing-secret";

const encoder = new TextEncoder();

// Produce a genuine Slack-style signature for a body+timestamp.
async function sign(rawBody: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${rawBody}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

function headers(timestamp: string, signature: string): Headers {
  return new Headers({
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": signature,
  });
}

describe("verifySlackRequest", () => {
  const now = 1_700_000_000;
  const ts = String(now);
  const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });

  it("accepts a validly signed request", async () => {
    const sig = await sign(body, ts);
    const res = await verifySlackRequest(headers(ts, sig), body, SECRET, now);
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(body, ts);
    const res = await verifySlackRequest(
      headers(ts, sig),
      body + "tampered",
      SECRET,
      now,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bad_signature");
  });

  it("rejects a stale timestamp (> 5 min)", async () => {
    const sig = await sign(body, ts);
    const res = await verifySlackRequest(
      headers(ts, sig),
      body,
      SECRET,
      now + 6 * 60,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("stale_timestamp");
  });

  it("rejects missing headers", async () => {
    const res = await verifySlackRequest(new Headers(), body, SECRET, now);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing_headers");
  });
});
