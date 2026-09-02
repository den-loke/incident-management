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
import { loadStatus, renderLoginPage, renderStatusPage } from "./ui/statusPage";

export { Incident } from "./incident";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
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

    // --- Dashboard (internal status page), gated behind a Slack session. ---
    if (request.method === "GET" && url.pathname === "/") {
      const session = await getSession(request, env);
      if (!session) return html(renderLoginPage(), 401);
      const data = await loadStatus(env);
      return html(renderStatusPage(data, session));
    }

    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
