import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mapZendeskWebhook } from "../src/oncall/zendesk";

const SECRET = "e2e-zendesk-secret"; // matches vitest.config.ts binding
const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${hex(mac)}`;
}
async function post(body: unknown, signit = true) {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signit) headers["X-Signature"] = await sign(raw);
  return SELF.fetch("https://x/api/alerts/zendesk", { method: "POST", headers, body: raw });
}

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'zendesk:zdtest-%'").run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'zendesk:T9'").run();
}

describe("Zendesk webhook mapping", () => {
  it("maps a nested ticket → external firing alert, priority→severity, dedup on id", () => {
    const r = mapZendeskWebhook({
      ticket: { id: 4242, subject: "Payments failing", description: "Card declines", priority: "urgent", status: "open" },
    })!;
    expect(r.ticketId).toBe("4242");
    expect(r.input.title).toBe("Payments failing");
    expect(r.input.severity).toBe("sev1"); // urgent → sev1
    expect(r.input.status).toBe("firing");
    expect(r.input.route).toBe("external"); // Zendesk defaults external
    expect(r.input.source).toBe("zendesk");
    expect(r.input.dedup_key).toBe("zendesk:4242");
  });

  it("accepts a flat payload and maps high→sev2", () => {
    const r = mapZendeskWebhook({ id: "T9", subject: "Slow checkout", priority: "high", status: "pending" })!;
    expect(r.input.severity).toBe("sev2");
    expect(r.input.dedup_key).toBe("zendesk:T9");
  });

  it("solved/closed status → resolved (recovery)", () => {
    const r = mapZendeskWebhook({ ticket: { id: 7, subject: "x", status: "solved" } })!;
    expect(r.input.status).toBe("resolved");
  });

  it("honours an explicit internal route override", () => {
    const r = mapZendeskWebhook({ subject: "internal thing", route: "internal" })!;
    expect(r.input.route).toBe("internal");
  });

  it("returns null for a firing signal with no subject, and a resolution with no id", () => {
    expect(mapZendeskWebhook({ ticket: { status: "open" } })).toBeNull();
    expect(mapZendeskWebhook({ ticket: { status: "solved" } })).toBeNull();
  });
});

describe("Zendesk webhook receiver route", () => {
  afterEach(clean);

  it("rejects a bad/absent signature", async () => {
    const r = await post({ ticket: { id: "zdtest-1", subject: "x", status: "open" } }, false);
    expect(r.status).toBe(401);
  });

  it("400s an unmappable payload", async () => {
    const r = await post({ ticket: { status: "open" } }); // no subject, no id
    expect(r.status).toBe(400);
  });

  it("creates a firing alert then dedups a re-fire of the same ticket", async () => {
    const first = await post({ ticket: { id: "zdtest-9", subject: "Refunds stuck", priority: "high", status: "open" } });
    expect(first.status).toBe(201);
    expect((await first.json() as { result: string }).result).toBe("created");

    const again = await post({ ticket: { id: "zdtest-9", subject: "Refunds stuck", priority: "high", status: "open" } });
    expect(again.status).toBe(200);
    expect((await again.json() as { result: string }).result).toBe("deduped");
  });

  it("a solved webhook resolves the open alert", async () => {
    await post({ ticket: { id: "zdtest-5", subject: "Login errors", status: "open" } });
    const res = await post({ ticket: { id: "zdtest-5", subject: "Login errors", status: "solved" } });
    expect(res.status).toBe(200);
    expect((await res.json() as { result: string }).result).toBe("resolved");
  });
});
