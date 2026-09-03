import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Regression: the Slack Events URL-verification handshake must echo the
// `challenge` WITHOUT requiring a valid signature. This failed on the first real
// deploy ("Your URL didn't respond with the value of the challenge parameter")
// because signature verification ran before the handshake. See src/index.ts.
describe("Slack events url_verification", () => {
  it("echoes the challenge with no signature headers", async () => {
    const res = await SELF.fetch("https://x/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "chal_xyz_123" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge?: string };
    expect(body.challenge).toBe("chal_xyz_123");
  });

  it("still rejects a real (non-handshake) event that is unsigned", async () => {
    const res = await SELF.fetch("https://x/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event_callback", event: { type: "message" } }),
    });
    expect(res.status).toBe(401);
  });
});
