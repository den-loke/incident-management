import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestAlert } from "../src/oncall/alerts";
import { escalateNew, sweepEscalations } from "../src/oncall/escalation";
import {
  __setNotifierSlackClient,
  __setNotifierTwilioClient,
} from "../src/oncall/notifier";
import { FakeSlackClient } from "../src/clients/fakeSlack";
import { FakeTwilioClient } from "../src/clients/twilio";
import { verifyTwilioSignature } from "../src/oncall/twilioVerify";

// Scoped, unique to this file so cleanup only touches its own rows.
const KEY = "test_twilio_alert";
const RESP = ["U_tw_a", "U_tw_b"];
const PHONE_A = "+61400000001";
const PHONE_B = "+61400000002";
const FALLBACK = "C_tw_fallback";
const TWILIO_TOKEN = "e2e-twilio-token"; // matches vitest.config.ts binding
const TWILIO_FROM = "+61400009999";

async function seedResponders() {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, ?, 1, 0)",
  ).bind(RESP[0], RESP[0], PHONE_A).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oncall_responders (id, name, phone, active, sort_order) VALUES (?, ?, ?, 1, 1)",
  ).bind(RESP[1], RESP[1], PHONE_B).run();
  // Wide override → RESP[0] is primary right now (deterministic).
  await env.DB.prepare(
    "INSERT INTO oncall_shifts (id, responder, starts_at, ends_at, is_override) VALUES (?, ?, ?, ?, 1)",
  ).bind(
    "shift_tw_test", RESP[0],
    new Date(Date.now() - 3600_000).toISOString(),
    new Date(Date.now() + 3600_000).toISOString(),
  ).run();
}

async function clean() {
  await env.DB.prepare(
    "DELETE FROM oncall_escalations WHERE alert_id IN (SELECT id FROM oncall_alerts WHERE dedup_key LIKE 'test_twilio_%')",
  ).run();
  await env.DB.prepare("DELETE FROM oncall_alerts WHERE dedup_key LIKE 'test_twilio_%'").run();
  await env.DB.prepare("DELETE FROM oncall_shifts WHERE id = 'shift_tw_test'").run();
  const ph = RESP.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM oncall_responders WHERE id IN (${ph})`).bind(...RESP).run();
}

async function newAlert() {
  const out = await ingestAlert(env as any, { title: "DB down", dedup_key: KEY, severity: "sev1" });
  if (out.result !== "created") throw new Error("expected created");
  return out.alert;
}

async function backdate(alertId: string, minutesAgo: number) {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await env.DB.prepare(
    "UPDATE oncall_escalations SET fired_at = ? WHERE alert_id = ? AND level = (SELECT MAX(level) FROM oncall_escalations WHERE alert_id = ?)",
  ).bind(iso, alertId, alertId).run();
}

async function channelsFor(alertId: string, level: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT channel FROM oncall_escalations WHERE alert_id = ? AND level = ? ORDER BY channel",
  ).bind(alertId, level).all<{ channel: string }>();
  return (results ?? []).map((r) => r.channel);
}

describe("on-call Twilio notifier (slice 4)", () => {
  let fakeTwilio: FakeTwilioClient;

  beforeEach(async () => {
    await clean();
    await seedResponders();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    (env as any).ONCALL_ACK_TIMEOUT_MIN = "10";
    (env as any).ONCALL_MANAGER = "U_manager";
    (env as any).ONCALL_TWILIO_FROM = TWILIO_FROM;
    (env as any).ONCALL_TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
    __setNotifierSlackClient(() => new FakeSlackClient(false));
    fakeTwilio = new FakeTwilioClient(false);
    __setNotifierTwilioClient(() => fakeTwilio);
  });

  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    __setNotifierTwilioClient(undefined);
    delete (env as any).ONCALL_TWILIO_FROM;
    delete (env as any).ONCALL_TWILIO_AUTH_TOKEN;
    delete (env as any).ONCALL_CHANNEL_POLICY;
    await clean();
  });

  it("no-ops (Slack-only) when Twilio is unconfigured", async () => {
    __setNotifierTwilioClient(undefined); // force the real gate
    delete (env as any).ONCALL_TWILIO_FROM;
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect(await channelsFor(alert.id, 0)).toEqual(["slack"]);
    expect(fakeTwilio.sms.length).toBe(0);
  });

  it("L0 sends Slack + SMS per the default policy", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect(await channelsFor(alert.id, 0)).toEqual(["slack", "sms"]);
    expect(fakeTwilio.sms.length).toBe(1);
    expect(fakeTwilio.sms[0].to).toBe(PHONE_A);
    expect(fakeTwilio.sms[0].from).toBe(TWILIO_FROM);
    expect(fakeTwilio.calls.length).toBe(0); // no voice at L0
    // provider_sid recorded on the sms row for phone-ack correlation.
    const sid = await env.DB.prepare(
      "SELECT provider_sid FROM oncall_escalations WHERE alert_id = ? AND channel = 'sms'",
    ).bind(alert.id).first<{ provider_sid: string }>();
    expect(sid?.provider_sid).toBe(fakeTwilio.sms[0].sid);
  });

  it("L1 adds a voice call (Slack + SMS + voice)", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(1);
    expect(await channelsFor(alert.id, 1)).toEqual(["slack", "sms", "voice"]);
    expect(fakeTwilio.calls.length).toBe(1);
    expect(fakeTwilio.calls[0].to).toBe(PHONE_B); // next responder is the L1 target
  });

  it("L2 broadcast is Slack-only (no phone-blast the whole team)", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    await backdate(alert.id, 11);
    await sweepEscalations(env as any); // → L1
    await backdate(alert.id, 11);
    await sweepEscalations(env as any); // → L2
    expect(await channelsFor(alert.id, 2)).toEqual(["slack"]);
  });

  it("skips a responder with no phone (no error, Slack still fires)", async () => {
    await env.DB.prepare("UPDATE oncall_responders SET phone = NULL WHERE id = ?").bind(RESP[0]).run();
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect(await channelsFor(alert.id, 0)).toEqual(["slack"]);
    expect(fakeTwilio.sms.length).toBe(0);
  });

  it("ONCALL_CHANNEL_POLICY overrides the per-level channels", async () => {
    (env as any).ONCALL_CHANNEL_POLICY = "voice|sms|"; // L0 voice-only
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    expect(await channelsFor(alert.id, 0)).toEqual(["slack", "voice"]);
    expect(fakeTwilio.calls.length).toBe(1);
    expect(fakeTwilio.sms.length).toBe(0);
  });
});

describe("Twilio inbound ack webhooks", () => {
  let fakeTwilio: FakeTwilioClient;

  beforeEach(async () => {
    await clean();
    await seedResponders();
    (env as any).ONCALL_FALLBACK_CHANNEL = FALLBACK;
    (env as any).ONCALL_ACK_TIMEOUT_MIN = "10";
    (env as any).ONCALL_TWILIO_FROM = TWILIO_FROM;
    (env as any).ONCALL_TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
    __setNotifierSlackClient(() => new FakeSlackClient(false));
    fakeTwilio = new FakeTwilioClient(false);
    __setNotifierTwilioClient(() => fakeTwilio);
  });

  afterEach(async () => {
    __setNotifierSlackClient(undefined);
    __setNotifierTwilioClient(undefined);
    delete (env as any).ONCALL_TWILIO_FROM;
    delete (env as any).ONCALL_TWILIO_AUTH_TOKEN;
    await clean();
  });

  async function sign(url: string, params: Record<string, string>): Promise<string> {
    // Recompute Twilio's expected signature the same way verifyTwilioSignature does.
    const enc = new TextEncoder();
    let data = url;
    for (const k of Object.keys(params).sort()) data += k + params[k];
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(TWILIO_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
    let bin = "";
    for (const b of new Uint8Array(mac)) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  it("verifyTwilioSignature round-trips and rejects tampering", async () => {
    const url = "https://x/api/twilio/sms";
    const params = { From: PHONE_A, Body: "Y" };
    const sig = await sign(url, params);
    expect(await verifyTwilioSignature(url, params, sig, TWILIO_TOKEN)).toBe(true);
    expect(await verifyTwilioSignature(url, params, sig, "wrong")).toBe(false);
    expect(await verifyTwilioSignature(url, { ...params, Body: "N" }, sig, TWILIO_TOKEN)).toBe(false);
    expect(await verifyTwilioSignature(url, params, null, TWILIO_TOKEN)).toBe(false);
    expect(await verifyTwilioSignature(url, params, sig, undefined)).toBe(false);
  });

  it("SMS reply Y acks the responder's firing alert and stops the ladder", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert); // pages RESP[0] (PHONE_A)

    const url = "https://x/api/twilio/sms";
    const params = { From: PHONE_A, Body: "Y" };
    const sig = await sign(url, params);
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);

    const a = await env.DB.prepare("SELECT status FROM oncall_alerts WHERE id = ?")
      .bind(alert.id).first<{ status: string }>();
    expect(a?.status).toBe("ack");
    // Ladder stopped: a timed-out sweep escalates nothing.
    await backdate(alert.id, 11);
    expect((await sweepEscalations(env as any)).escalated).toBe(0);
  });

  it("SMS with a bad signature is rejected 403 and does not ack", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    const res = await SELF.fetch("https://x/api/twilio/sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": "bogus" },
      body: new URLSearchParams({ From: PHONE_A, Body: "Y" }).toString(),
    });
    expect(res.status).toBe(403);
    const a = await env.DB.prepare("SELECT status FROM oncall_alerts WHERE id = ?")
      .bind(alert.id).first<{ status: string }>();
    expect(a?.status).toBe("firing");
  });

  it("voice press-1 acks by CallSid (provider_sid correlation)", async () => {
    const alert = await newAlert();
    await escalateNew(env as any, alert);
    await backdate(alert.id, 11);
    await sweepEscalations(env as any); // → L1, places a voice call
    const callSid = fakeTwilio.calls[0].sid;

    const url = "https://x/api/twilio/voice";
    const params = { CallSid: callSid, Digits: "1" };
    const sig = await sign(url, params);
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: new URLSearchParams(params).toString(),
    });
    expect(res.status).toBe(200);

    const a = await env.DB.prepare("SELECT status FROM oncall_alerts WHERE id = ?")
      .bind(alert.id).first<{ status: string }>();
    expect(a?.status).toBe("ack");
  });
});
