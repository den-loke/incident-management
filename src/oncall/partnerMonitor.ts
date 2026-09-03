/// <reference types="@cloudflare/workers-types" />
// Partner status-page monitor. See ROADMAP.md → "Alert routing" (killer use case).
//
// Poll a fixed list of upstream/partner status pages (Statuspage.io-style
// `…/api/v2/status.json`). When a partner is NOT operational, emit an
// external-ROUTED alert — which the alert-routing layer sends to comms + a
// Create-incident button (never pages on-call, since it's not ours to fix).
// When the partner recovers, auto-resolve the alert. Dedup key `partner:<id>`
// makes it fire once per outage and recover cleanly.
//
// Single-tenant / hard-coded: the watched partners are a config VAR
// (PARTNER_STATUS_FEEDS), not a management UI. Injectable fetch for tests.

import type { Env } from "../env";
import { ingestAlert } from "./alerts";
import { routeNewAlert } from "./routing";

export interface PartnerFeed {
  id: string;
  name: string;
  url: string; // Statuspage summary endpoint (…/api/v2/status.json)
}

// Statuspage status.json shape (the fields we read).
interface StatuspageStatus {
  status?: { indicator?: string; description?: string };
}

/** Test seam: override the fetch used to poll partner feeds. */
type FetchFn = (url: string) => Promise<Response>;
let fetchOverride: FetchFn | undefined;
export function __setPartnerFetch(f: FetchFn | undefined): void {
  fetchOverride = f;
}
function doFetch(url: string): Promise<Response> {
  return (fetchOverride ?? ((u: string) => fetch(u)))(url);
}

/** Parse PARTNER_STATUS_FEEDS; returns [] when unset/invalid (monitor disabled). */
export function parseFeeds(env: Env): PartnerFeed[] {
  const raw = env.PARTNER_STATUS_FEEDS;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (f): f is PartnerFeed =>
        !!f &&
        typeof (f as PartnerFeed).id === "string" &&
        typeof (f as PartnerFeed).name === "string" &&
        typeof (f as PartnerFeed).url === "string",
    );
  } catch {
    return [];
  }
}

/** One partner's dedup key — one open alert per partner at a time. */
function dedupKey(feed: PartnerFeed): string {
  return `partner:${feed.id}`;
}

/**
 * Poll one partner feed and reconcile its alert:
 *  - indicator not "none"/absent → firing external alert (create or dedup).
 *  - indicator "none" (operational) → resolve any open alert for this partner.
 * Returns what happened (for tests / logging). Network/parse failure = skip
 * (returns "error") so one bad feed never breaks the others.
 */
export async function pollPartner(
  env: Env,
  feed: PartnerFeed,
): Promise<"firing" | "recovered" | "ok" | "error"> {
  let indicator = "none";
  let description = "";
  try {
    const res = await doFetch(feed.url);
    if (!res.ok) return "error";
    const data = (await res.json()) as StatuspageStatus;
    indicator = (data.status?.indicator ?? "none").toLowerCase();
    description = data.status?.description ?? "";
  } catch {
    return "error";
  }

  const key = dedupKey(feed);
  if (indicator !== "none") {
    // Partner has an issue → external-routed alert (comms, not paging).
    const severity =
      indicator === "critical" ? "sev1" : indicator === "major" ? "sev2" : "sev3";
    const out = await ingestAlert(env, {
      title: `${feed.name}: ${description || indicator}`,
      body: `Upstream partner *${feed.name}* reports status "${indicator}".`,
      severity,
      dedup_key: key,
      source: "partner-status",
      route: "external",
      status: "firing",
    });
    // A genuinely new firing → route it (external → comms notice, no page).
    // A dedup means the alert is already open; don't re-notify.
    if (out.result === "created") {
      await routeNewAlert(env, out.alert);
    }
    return "firing";
  }

  // Operational → close any open alert for this partner (auto-resolve).
  const out = await ingestAlert(env, {
    title: `${feed.name}: operational`,
    dedup_key: key,
    source: "partner-status",
    status: "resolved",
  });
  return out.result === "resolved" ? "recovered" : "ok";
}

/** Poll every configured partner feed. No-op when the monitor is unconfigured. */
export async function pollPartnerStatus(env: Env): Promise<{ polled: number }> {
  const feeds = parseFeeds(env);
  for (const feed of feeds) {
    await pollPartner(env, feed);
  }
  return { polled: feeds.length };
}
