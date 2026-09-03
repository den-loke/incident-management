// Injectable Twilio client for on-call SMS/voice paging (GoAlert-style).
// The real impl calls the Twilio REST API; the fake records calls so the
// escalation ladder can run in tests and local dev with no Twilio account.
// See docs/SPEC_ONCALL.md §3a. Config-gated exactly like StatuspageSink: an
// unset ONCALL_TWILIO_* env means the notifier is never even constructed, so a
// missing/failing Twilio never breaks the always-on Slack path.

export interface SendSmsInput {
  to: string; // E.164 destination
  from: string; // Twilio sending number (E.164)
  body: string;
}

export interface PlaceCallInput {
  to: string; // E.164 destination
  from: string; // Twilio sending number (E.164)
  /** TwiML the call executes when answered (press-1-to-ack gather). */
  twiml: string;
}

export interface TwilioClient {
  /** Send an SMS; returns the Twilio Message SID. */
  sendSms(input: SendSmsInput): Promise<string>;
  /** Place a voice call; returns the Twilio Call SID. */
  placeCall(input: PlaceCallInput): Promise<string>;
}

const TWILIO_API = "https://api.twilio.com/2010-04-01";

/** Real Twilio REST client (SMS + voice), HTTP Basic auth (SID:token). */
export class RestTwilioClient implements TwilioClient {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  private authHeader(): string {
    // btoa is available in the Workers runtime.
    return `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`;
  }

  private async post(resource: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await fetch(`${TWILIO_API}/Accounts/${this.accountSid}/${resource}`, {
      method: "POST",
      headers: {
        authorization: this.authHeader(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const msg = typeof data.message === "string" ? data.message : `status ${res.status}`;
      throw new Error(`twilio ${resource} failed: ${msg}`);
    }
    return data;
  }

  async sendSms({ to, from, body }: SendSmsInput): Promise<string> {
    const data = await this.post("Messages.json", { To: to, From: from, Body: body });
    return String(data.sid ?? "");
  }

  async placeCall({ to, from, twiml }: PlaceCallInput): Promise<string> {
    const data = await this.post("Calls.json", { To: to, From: from, Twiml: twiml });
    return String(data.sid ?? "");
  }
}

/** In-memory Twilio client for tests and local no-Twilio dev. */
export class FakeTwilioClient implements TwilioClient {
  sms: (SendSmsInput & { sid: string })[] = [];
  calls: (PlaceCallInput & { sid: string })[] = [];
  private seq = 0;

  constructor(private readonly log = false) {}

  private nextSid(prefix: string): string {
    this.seq += 1;
    return `${prefix}${String(this.seq).padStart(32, "0")}`;
  }

  async sendSms(input: SendSmsInput): Promise<string> {
    const sid = this.nextSid("SM");
    this.sms.push({ ...input, sid });
    if (this.log) console.log(`[fake-twilio] sms -> ${input.to}: ${input.body}`);
    return sid;
  }

  async placeCall(input: PlaceCallInput): Promise<string> {
    const sid = this.nextSid("CA");
    this.calls.push({ ...input, sid });
    if (this.log) console.log(`[fake-twilio] call -> ${input.to}`);
    return sid;
  }
}
