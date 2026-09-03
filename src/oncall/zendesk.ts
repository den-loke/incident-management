/// <reference types="@cloudflare/workers-types" />
// Zendesk webhook receiver — one more alert SOURCE behind the shared alert
// pipeline. See ROADMAP → "Alerts = inbound monitoring + Zendesk webhooks".
//
// This is NOT mail ingestion. You configure a Zendesk **webhook** on a trigger
// (e.g. "ticket assigned to the Escalations group") that POSTs a JSON body to
// `/api/alerts/zendesk`. We verify a shared-secret signature and map the
// Zendesk-shaped payload → AlertInput, then reuse ingestAlert + routeNewAlert
// exactly like the generic /api/alerts source. Zendesk is one adapter; the
// alert model is unchanged. Setup lives in docs/DEPLOY.md.

import type { AlertInput, AlertRoute } from "./alerts";
import { verifyAlertSignature } from "./alertVerify";

/**
 * A minimal Zendesk webhook body. Zendesk trigger webhooks let you template the
 * JSON, so we accept a small, documented shape (docs/DEPLOY.md tells the operator
 * exactly which placeholders to put where). All fields optional except we need a
 * title source (ticket subject).
 */
export interface ZendeskWebhookBody {
  ticket?: {
    id?: number | string;
    subject?: string;
    description?: string;
    priority?: string; // low | normal | high | urgent
    status?: string; // new | open | pending | hold | solved | closed
    url?: string;
  };
  // Some operators template flat fields instead of a nested ticket object.
  id?: number | string;
  subject?: string;
  description?: string;
  priority?: string;
  status?: string;
  // Optional explicit routing override; defaults to "external" (Zendesk = customer-facing).
  route?: string;
}

/** Zendesk priority → our severity hint. urgent→sev1, high→sev2, else sev3. */
function severityFromPriority(priority: string | undefined): string | undefined {
  switch ((priority ?? "").toLowerCase()) {
    case "urgent":
      return "sev1";
    case "high":
      return "sev2";
    case "normal":
    case "low":
      return "sev3";
    default:
      return undefined;
  }
}

/**
 * A Zendesk ticket becomes "resolved" (recovery) when it reaches a terminal
 * status. Any other status is a firing/open signal.
 */
function isResolvedStatus(status: string | undefined): boolean {
  const s = (status ?? "").toLowerCase();
  return s === "solved" || s === "closed";
}

export interface ZendeskMapResult {
  input: AlertInput;
  ticketId: string | null;
}

/**
 * Map a parsed Zendesk webhook body to an AlertInput. Dedup key is the ticket id
 * (so re-fires of the same ticket fold, and a solved/closed webhook auto-resolves
 * the open alert). Returns null when there's no usable ticket subject on a
 * firing signal.
 */
export function mapZendeskWebhook(body: ZendeskWebhookBody): ZendeskMapResult | null {
  const t = body.ticket ?? {};
  const id = t.id ?? body.id;
  const ticketId = id !== undefined && id !== null ? String(id) : null;
  const subject = (t.subject ?? body.subject ?? "").trim();
  const description = t.description ?? body.description;
  const priority = t.priority ?? body.priority;
  const status = t.status ?? body.status;
  const resolved = isResolvedStatus(status);

  // A firing signal needs a subject; a resolution just needs the dedup key.
  if (!resolved && !subject) return null;
  if (resolved && !ticketId) return null;

  const route: AlertRoute = body.route === "internal" ? "internal" : "external";

  const input: AlertInput = {
    title: subject || `Zendesk ticket ${ticketId}`,
    body: description ?? (t.url ? `Zendesk: ${t.url}` : undefined),
    severity: severityFromPriority(priority),
    dedup_key: ticketId ? `zendesk:${ticketId}` : undefined,
    status: resolved ? "resolved" : "firing",
    source: "zendesk",
    route,
  };
  return { input, ticketId };
}

/** Verify a Zendesk webhook using the same X-Signature scheme, keyed on ZENDESK_WEBHOOK_SECRET. */
export function verifyZendeskSignature(
  headers: Headers,
  rawBody: string,
  secret: string | undefined,
): Promise<boolean> {
  return verifyAlertSignature(headers, rawBody, secret);
}
