/// <reference types="@cloudflare/workers-types" />
// Inbound Twilio webhooks for phone ack. See docs/SPEC_ONCALL.md §3a.
//
//   POST /api/twilio/sms   — responder replies Y/ACK to a paging SMS.
//   POST /api/twilio/voice — responder presses 1 on a paging call (Gather).
//
// Both are signature-validated with ONCALL_TWILIO_AUTH_TOKEN (Twilio's
// X-Twilio-Signature) and resolve to the SAME oncall_ack path as the Slack
// button — only the entry point differs. Ack source is uniform.

import type { Env } from "../env";
import { verifyTwilioSignature } from "./twilioVerify";
import { ackAlertByPhone, ackAlertByProviderSid } from "./escalation";

const ACK_WORDS = new Set(["y", "yes", "ack", "ok", "1"]);

function twimlMessage(text: string): Response {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text}</Message></Response>`;
  return new Response(body, { headers: { "content-type": "text/xml" } });
}

function twimlSay(text: string): Response {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${text}</Say></Response>`;
  return new Response(body, { headers: { "content-type": "text/xml" } });
}

async function parseAndVerify(
  request: Request,
  env: Env,
): Promise<Record<string, string> | null> {
  const raw = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  const url = request.url; // Twilio signs the exact public URL it POSTed to.
  const ok = await verifyTwilioSignature(
    url,
    params,
    request.headers.get("X-Twilio-Signature"),
    env.ONCALL_TWILIO_AUTH_TOKEN,
  );
  return ok ? params : null;
}

/** SMS ack: `Body` is the reply text, `From` the sender's E.164 number. */
export async function handleTwilioSms(request: Request, env: Env): Promise<Response> {
  const params = await parseAndVerify(request, env);
  if (!params) return new Response("forbidden", { status: 403 });

  const body = (params.Body ?? "").trim().toLowerCase();
  const from = params.From ?? "";
  if (!ACK_WORDS.has(body)) {
    return twimlMessage("Reply Y or ACK to acknowledge the alert.");
  }
  const out = await ackAlertByPhone(env, from);
  return twimlMessage(
    out.result === "acked" ? "Acknowledged. Escalation stopped." : "No open alert to acknowledge.",
  );
}

/** Voice ack: `Digits` from the Gather, `CallSid` correlates to the escalation row. */
export async function handleTwilioVoice(request: Request, env: Env): Promise<Response> {
  const params = await parseAndVerify(request, env);
  if (!params) return new Response("forbidden", { status: 403 });

  const digits = params.Digits ?? "";
  const callSid = params.CallSid ?? "";
  if (digits !== "1") {
    return twimlSay("No acknowledgement received. Goodbye.");
  }
  const out = callSid
    ? await ackAlertByProviderSid(env, callSid)
    : { result: "ignored" as const };
  return twimlSay(
    out.result === "acked"
      ? "Acknowledged. Escalation stopped. Goodbye."
      : "No open alert to acknowledge. Goodbye.",
  );
}
