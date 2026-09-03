import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ingestAlert, listOpenAlerts } from "../src/oncall/alerts";

const SECRET = "e2e-alert-secret"; // matches vitest.config.ts binding
const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${hex(mac)}`;
}

// Scoped cleanup: this file uses a unique dedup_key prefix so we can delete only
// its rows from the shared pool-wide D1.
const KEY = "test_ing_disk_full";

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_ing_%'").run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE title LIKE 'ING_%'").run();
}

describe("on-call alert ingestion (service)", () => {
  afterEach(clean);

  it("creates a new firing alert", async () => {
    const out = await ingestAlert(env as any, {
      title: "ING_new",
      dedup_key: KEY,
      severity: "sev1",
    });
    expect(out.result).toBe("created");
    if (out.result === "created") {
      expect(out.alert.status).toBe("firing");
      expect(out.alert.severity).toBe("sev1");
    }
  });

  it("dedups a repeat firing by dedup_key instead of creating a second", async () => {
    await ingestAlert(env as any, { title: "ING_flap", dedup_key: KEY });
    const second = await ingestAlert(env as any, { title: "ING_flap", dedup_key: KEY });
    expect(second.result).toBe("deduped");

    const open = (await listOpenAlerts(env as any)).filter((a) => a.dedup_key === KEY);
    expect(open.length).toBe(1);
    expect(open[0].body ?? "").toContain("re-fired");
  });

  it("auto-resolves matching open alerts on recovery", async () => {
    await ingestAlert(env as any, { title: "ING_down", dedup_key: KEY });
    const rec = await ingestAlert(env as any, { title: "ING_down", dedup_key: KEY, status: "resolved" });
    expect(rec.result).toBe("resolved");
    if (rec.result === "resolved") expect(rec.count).toBe(1);

    const open = (await listOpenAlerts(env as any)).filter((a) => a.dedup_key === KEY);
    expect(open.length).toBe(0);
  });

  it("recovery with nothing open is a noop", async () => {
    const rec = await ingestAlert(env as any, { title: "ING_ghost", dedup_key: KEY, status: "resolved" });
    expect(rec.result).toBe("noop");
  });

  it("a firing alert with no dedup_key is always new", async () => {
    const a = await ingestAlert(env as any, { title: "ING_nokey" });
    const b = await ingestAlert(env as any, { title: "ING_nokey" });
    expect(a.result).toBe("created");
    expect(b.result).toBe("created");
    // cleanup for these (no dedup_key, matched by title prefix in clean()).
  });
});

describe("POST /api/alerts (endpoint)", () => {
  afterEach(clean);

  it("rejects a missing/invalid signature with 401", async () => {
    const body = JSON.stringify({ title: "ING_unsigned", dedup_key: KEY });
    const res = await SELF.fetch("https://x/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no X-Signature
      body,
    });
    expect(res.status).toBe(401);

    const bad = await SELF.fetch("https://x/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": "sha256=deadbeef" },
      body,
    });
    expect(bad.status).toBe(401);
  });

  it("accepts a validly-signed firing alert with 201", async () => {
    const body = JSON.stringify({ title: "ING_signed", dedup_key: KEY, severity: "sev2" });
    const res = await SELF.fetch("https://x/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": await sign(body) },
      body,
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { result: string };
    expect(out.result).toBe("created");
  });

  it("dedups a repeat signed firing (200, result=deduped)", async () => {
    const body = JSON.stringify({ title: "ING_signed2", dedup_key: KEY });
    const sig = await sign(body);
    const opts = {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": sig },
      body,
    } as const;
    await SELF.fetch("https://x/api/alerts", opts);
    const res = await SELF.fetch("https://x/api/alerts", opts);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { result: string };
    expect(out.result).toBe("deduped");
  });

  it("rejects a firing alert with no title (400)", async () => {
    const body = JSON.stringify({ dedup_key: KEY });
    const res = await SELF.fetch("https://x/api/alerts", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Signature": await sign(body) },
      body,
    });
    expect(res.status).toBe(400);
  });
});
