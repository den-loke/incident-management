/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env";
import { verifySlackRequest } from "./slack/verify";
import { routeSlackEvent } from "./router";
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
  resolveIncident,
} from "./incidents/commands";
import { INCIDENT_STATUSES, type IncidentStatus } from "./status/types";
import { D1Db } from "./status/d1";
import { PostmortemStore } from "./postmortem/store";
import { generatePostmortemDraft } from "./postmortem/service";

export { Incident } from "./incident";

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

async function handleSlackEvents(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Read the raw body ONCE — signature verification needs the exact bytes.
  const rawBody = await request.text();

  const result = await verifySlackRequest(
    request.headers,
    rawBody,
    env.SLACK_SIGNING_SECRET,
  );
  if (!result.ok) return json({ error: result.reason }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  // Slack Events API URL verification handshake.
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { type?: string }).type === "url_verification"
  ) {
    const challenge = (payload as { challenge?: string }).challenge ?? "";
    return json({ challenge });
  }

  // Ack within 3s; route the event to the right Incident DO asynchronously.
  // Slack retries on non-2xx, so dispatch failures are re-delivered.
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
      const result = await declareIncident(env, name, note);
      return json(result, 201);
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
      await resolveIncident(env, decodeURIComponent(resolveMatch[1]), note);
      return json({ ok: true });
    }

    // --- Post-mortems (session-gated). ---
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
      const store = new PostmortemStore(new D1Db(env.DB));
      await store.publish(decodeURIComponent(pmPublishMatch[1]));
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
} satisfies ExportedHandler<Env>;
