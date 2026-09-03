/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";
import { verifySlackRequest } from "./slack/verify";
import { routeSlackEvent } from "./router";
import { handleSlackInteractivity } from "./slack/interactivity";
import { handleSlackCommand } from "./slack/commands";
import {
  getSession,
  handleCallback,
  handleLogin,
  handleLogout,
} from "./auth/oidc";
import { loadStatus } from "./ui/statusPage";
import {
  declareIncident,
  postIncidentUpdate,
} from "./incidents/commands";
import { requestResolve, confirmResolve } from "./incidents/jointResolve";
import { setSeverity } from "./incidents/severity";
import {
  INCIDENT_STATUSES,
  isIncidentSeverity,
  isRoutingPath,
  type IncidentStatus,
} from "./status/types";
import { D1Db } from "./status/d1";
import { PostmortemStore } from "./postmortem/store";
import { generatePostmortemDraft } from "./postmortem/service";
import { buildReport, periodWindow, reportToCsv } from "./reporting/service";
import { runOncallScheduled } from "./oncall/cron";
import { verifyAlertSignature } from "./oncall/alertVerify";
import { ingestAlert } from "./oncall/alerts";
import { ackAlert, promoteAlertToIncident } from "./oncall/escalation";
import { routeNewAlert } from "./oncall/routing";
import { setOverride } from "./oncall/rotation";
import {
  scheduleMaintenance,
  listMaintenance,
  cancelMaintenance,
} from "./maintenance/service";
import { buildOncallSection } from "./oncall/webApi";
import { handleTwilioSms, handleTwilioVoice } from "./oncall/twilioWebhook";
import { applyReaction } from "./incidents/suggestions";

export { Incident } from "./incident";
export { IncidentCounter } from "./counter";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Parse a JSON request body, tolerating empty/invalid bodies. */
async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const v = await request.json();
    return typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isIncidentStatus(v: unknown): v is IncidentStatus {
  return (
    typeof v === "string" &&
    (INCIDENT_STATUSES as readonly string[]).includes(v)
  );
}

/** Coerce an unknown JSON field to a trimmed string (empty when absent). */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Look up the Slack channel that owns an incident (for posting panels). */
async function incidentChannel(env: Env, incidentId: string): Promise<string | null> {
  const row = await new D1Db(env.DB).get<{ channel: string }>(
    "SELECT channel FROM incident_channels WHERE incident_id = ?",
    [incidentId],
  );
  return row?.channel ?? null;
}

async function handleSlackEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Read the raw body ONCE — signature verification needs the exact bytes.
  const rawBody = await request.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  // Slack Events API URL-verification handshake. Answer it BEFORE signature
  // verification: it is a side-effect-free ownership check Slack sends when you
  // save the Request URL, and gating it on the signing secret creates a
  // chicken-and-egg failure (the URL can't verify until the secret is set, and
  // Slack reports only "didn't respond with the challenge"). Echoing the
  // challenge here is safe — no state is touched.
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: string }).type === "url_verification"
  ) {
    const challenge = (payload as { challenge?: string }).challenge ?? "";
    return json({ challenge });
  }

  // Every real event MUST be signature-verified before it touches any state.
  const result = await verifySlackRequest(
    request.headers,
    rawBody,
    env.SLACK_SIGNING_SECRET,
  );
  if (!result.ok) return json({ error: result.reason }, 401);

  // Ack within 3s; route the event to the right Incident DO asynchronously.
  // Slack retries on non-2xx, so dispatch failures are re-delivered.
  // Intercept reaction_added → emoji accept/reject on a tracked app suggestion.
  const envelope = payload as {
    event?: {
      type?: string;
      user?: string;
      reaction?: string;
      item?: { type?: string; channel?: string; ts?: string };
    };
  };
  const ev = envelope.event;
  if (ev?.type === "reaction_added" && ev.item?.type === "message") {
    const { channel, ts } = ev.item;
    if (channel && ts && ev.user && ev.reaction) {
      ctx.waitUntil(applyReaction(env, channel, ts, ev.reaction, ev.user));
    }
    return json({ ok: true });
  }

  ctx.waitUntil(
    routeSlackEvent(payload as Parameters<typeof routeSlackEvent>[0], env),
  );
  return json({ ok: true });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "ok" });
    }

    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvents(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/slack/interactivity") {
      return handleSlackInteractivity(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/slack/commands") {
      return handleSlackCommand(request, env, ctx);
    }

    // --- Dashboard auth routes (OIDC). Not HMAC-gated. ---
    if (request.method === "GET" && url.pathname === "/auth/login") {
      return handleLogin(url, env);
    }
    if (request.method === "GET" && url.pathname === "/auth/callback") {
      return handleCallback(request, url, env);
    }
    if (request.method === "GET" && url.pathname === "/auth/logout") {
      return handleLogout(url);
    }

    // --- Status JSON for the SPA, gated behind a Slack session. ---
    if (request.method === "GET" && url.pathname === "/api/status") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const data = await loadStatus(env, session);
      return json(data);
    }

    // --- On-call alert ingestion (public, HMAC-verified). See docs/SPEC_ONCALL.md §4.
    // Not session-gated — monitoring sources sign the raw body with ONCALL_ALERT_SECRET.
    if (request.method === "POST" && url.pathname === "/api/alerts") {
      const raw = await request.text();
      const ok = await verifyAlertSignature(request.headers, raw, env.ONCALL_ALERT_SECRET);
      if (!ok) return json({ error: "bad_signature" }, 401);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";
      const status = parsed?.status === "resolved" ? "resolved" : "firing";
      if (status === "firing" && !title) return json({ error: "title_required" }, 400);
      const outcome = await ingestAlert(env, {
        title,
        body: typeof parsed?.body === "string" ? parsed.body : undefined,
        severity: typeof parsed?.severity === "string" ? parsed.severity : undefined,
        dedup_key: typeof parsed?.dedup_key === "string" ? parsed.dedup_key : undefined,
        status,
        route: parsed?.route === "external" ? "external" : "internal",
      });
      // A genuinely new firing alert is ROUTED: internal → page on-call; external
      // (upstream/partner) → post a comms notice, don't page. See oncall/routing.ts.
      if (outcome.result === "created") {
        ctx.waitUntil(routeNewAlert(env, outcome.alert));
      }
      return json(outcome, outcome.result === "created" ? 201 : 200);
    }

    // --- Inbound Twilio phone-ack webhooks (public, X-Twilio-Signature-verified).
    // See docs/SPEC_ONCALL.md §3a. SMS reply Y/ACK or voice press-1 acks the alert,
    // resolving to the same oncall_ack path as the Slack button.
    if (request.method === "POST" && url.pathname === "/api/twilio/sms") {
      return handleTwilioSms(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/twilio/voice") {
      return handleTwilioVoice(request, env);
    }

    // --- On-call web section (read + actions), gated behind a Slack session.
    // Actions reuse the SAME functions the Slack buttons drive. See §6.
    if (request.method === "GET" && url.pathname === "/api/oncall") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      return json(await buildOncallSection(env));
    }

    const ackMatch = url.pathname.match(/^\/api\/oncall\/alerts\/([^/]+)\/ack$/);
    if (request.method === "POST" && ackMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const out = await ackAlert(env, decodeURIComponent(ackMatch[1]), `web:${session.user_id}`);
      return json(out);
    }

    const promoteMatch = url.pathname.match(/^\/api\/oncall\/alerts\/([^/]+)\/promote$/);
    if (request.method === "POST" && promoteMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const res = await promoteAlertToIncident(env, decodeURIComponent(promoteMatch[1]));
      return res ? json(res) : json({ error: "not_found" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/api/oncall/overrides") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      const responder = typeof body?.responder === "string" ? body.responder.trim() : "";
      const startsAt = typeof body?.starts_at === "string" ? body.starts_at : "";
      const endsAt = typeof body?.ends_at === "string" ? body.ends_at : "";
      if (!responder || !startsAt || !endsAt) {
        return json({ error: "responder_starts_ends_required" }, 400);
      }
      if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) {
        return json({ error: "invalid_dates" }, 400);
      }
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        return json({ error: "end_before_start" }, 400);
      }
      const id = await setOverride(env, responder, startsAt, endsAt);
      return json({ id }, 201);
    }

    // --- Scheduled maintenance (session-gated). See ROADMAP "Scheduled maintenance". ---
    if (request.method === "GET" && url.pathname === "/api/maintenance") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      return json({ windows: await listMaintenance(env) });
    }

    if (request.method === "POST" && url.pathname === "/api/maintenance") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      const startsAt = typeof body?.starts_at === "string" ? body.starts_at : "";
      const endsAt = typeof body?.ends_at === "string" ? body.ends_at : "";
      if (!title || !startsAt || !endsAt) {
        return json({ error: "title_starts_ends_required" }, 400);
      }
      if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) {
        return json({ error: "invalid_dates" }, 400);
      }
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        return json({ error: "end_before_start" }, 400);
      }
      const components = Array.isArray(body?.components)
        ? (body.components as unknown[]).filter((c): c is string => typeof c === "string")
        : [];
      const w = await scheduleMaintenance(env, {
        title,
        body: typeof body?.body === "string" ? body.body : undefined,
        components,
        starts_at: startsAt,
        ends_at: endsAt,
      });
      return json(w, 201);
    }

    const maintCancelMatch = url.pathname.match(/^\/api\/maintenance\/([^/]+)\/cancel$/);
    if (request.method === "POST" && maintCancelMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const ok = await cancelMaintenance(env, decodeURIComponent(maintCancelMatch[1]));
      return ok ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    // --- Incident management (write), gated behind a Slack session. ---
    // These reuse the SAME Incident DO command path as Slack (declareIncident /
    // postIncidentUpdate / resolveIncident), so web and Slack never diverge.
    if (request.method === "POST" && url.pathname === "/api/incidents") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return json({ error: "name_required" }, 400);
      const note = typeof body?.body === "string" ? body.body : undefined;
      const severity = isIncidentSeverity(body?.severity) ? body.severity : undefined;
      const routingPath = isRoutingPath(body?.routing_path) ? body.routing_path : undefined;
      const result = await declareIncident(env, name, note, severity, routingPath);
      return json(result, 201);
    }

    const severityMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/severity$/);
    if (request.method === "PUT" && severityMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      if (!isIncidentSeverity(body?.severity)) {
        return json({ error: "invalid_severity" }, 400);
      }
      const ok = await setSeverity(env, decodeURIComponent(severityMatch[1]), body.severity);
      return ok ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    const updateMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/updates$/);
    if (request.method === "POST" && updateMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      const text = typeof body?.body === "string" ? body.body.trim() : "";
      if (!text) return json({ error: "body_required" }, 400);
      const status = isIncidentStatus(body?.status) ? body.status : undefined;
      await postIncidentUpdate(env, decodeURIComponent(updateMatch[1]), text, status);
      return json({ ok: true });
    }

    const resolveMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
    if (request.method === "POST" && resolveMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const body = await readJson(request);
      const note = typeof body?.body === "string" ? body.body : undefined;
      const incidentId = decodeURIComponent(resolveMatch[1]);
      // Joint sign-off: this REQUESTS resolution; a different person confirms.
      const channel = await incidentChannel(env, incidentId);
      const req = await requestResolve(
        env,
        incidentId,
        channel ?? "",
        `web:${session.user_id}`,
        note,
      );
      return json(req);
    }

    const resolveConfirmMatch = url.pathname.match(
      /^\/api\/incidents\/([^/]+)\/resolve\/confirm$/,
    );
    if (request.method === "POST" && resolveConfirmMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const outcome = await confirmResolve(
        env,
        decodeURIComponent(resolveConfirmMatch[1]),
        `web:${session.user_id}`,
      );
      if (!outcome.ok) {
        const status = outcome.reason === "same_person" ? 409 : 404;
        return json({ error: outcome.reason }, status);
      }
      return json({ ok: true });
    }

    // --- Reporting (session-gated). GET /api/reports?period=7d|30d|90d|all&format=csv ---
    if (request.method === "GET" && url.pathname === "/api/reports") {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const period = url.searchParams.get("period") ?? "30d";
      const { from, to } = periodWindow(period);
      const report = await buildReport(new D1Db(env.DB), from, to);
      if (url.searchParams.get("format") === "csv") {
        return new Response(reportToCsv(report), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="incident-report-${period}.csv"`,
          },
        });
      }
      return json(report);
    }
    const pmMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/postmortem$/);
    if (pmMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const incidentId = decodeURIComponent(pmMatch[1]);
      const store = new PostmortemStore(new D1Db(env.DB));

      if (request.method === "GET") {
        const pm = await store.get(incidentId);
        return pm ? json(pm) : json({ error: "not_found" }, 404);
      }
      // POST => (re)generate the AI draft from the timeline.
      if (request.method === "POST") {
        const pm = await generatePostmortemDraft(env, incidentId);
        return pm ? json(pm) : json({ error: "incident_not_found" }, 404);
      }
      // PUT => save human edits.
      if (request.method === "PUT") {
        const b = await readJson(request);
        const pm = await store.saveDraft(incidentId, {
          summary: str(b?.summary),
          impact: str(b?.impact),
          root_cause: str(b?.root_cause),
          contributing_factors: str(b?.contributing_factors),
          action_items: Array.isArray(b?.action_items)
            ? (b.action_items as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
        });
        return json(pm);
      }
    }

    const pmPublishMatch = url.pathname.match(
      /^\/api\/incidents\/([^/]+)\/postmortem\/publish$/,
    );
    if (request.method === "POST" && pmPublishMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const incidentId = decodeURIComponent(pmPublishMatch[1]);
      const store = new PostmortemStore(new D1Db(env.DB));
      await store.publish(incidentId);
      // Export action items to Jira on publish (best-effort; no-op if unconfigured).
      ctx.waitUntil(
        (async () => {
          try {
            const { exportActionItemsToJira } = await import("./postmortem/jiraExport");
            await exportActionItemsToJira(env, incidentId);
          } catch {
            /* non-fatal */
          }
        })(),
      );
      return json({ ok: true });
    }

    const aiMatch = url.pathname.match(
      /^\/api\/postmortem-action-items\/([^/]+)$/,
    );
    if (request.method === "POST" && aiMatch) {
      const session = await getSession(request, env);
      if (!session) return json({ error: "unauthorized" }, 401);
      const b = await readJson(request);
      const store = new PostmortemStore(new D1Db(env.DB));
      await store.setActionItemDone(decodeURIComponent(aiMatch[1]), b?.done === true);
      return json({ ok: true });
    }

    // --- Static SPA assets (built from web/ into ../public). ---
    // The SPA calls /api/status; a 401 there drives it to render the login screen.
    // ASSETS with not_found_handling:"single-page-application" serves index.html
    // for unknown paths so client routing works.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runOncallScheduled(event, env));
  },
} satisfies ExportedHandler<Env>;
