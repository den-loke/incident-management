// Read-only internal status page. Server-rendered HTML, no build step, no client
// framework — the Worker returns a complete document. Renders from the
// InternalStatusSink D1 tables (source of truth). See docs/ARCHITECTURE.md §5–6.

import { D1Db } from "../status/d1";
import { InternalStatusSink } from "../status/internalSink";
import type {
  Component,
  ComponentStatus,
  Incident,
  IncidentStatus,
  IncidentUpdate,
} from "../status/types";
import type { Env } from "../env";
import type { Session } from "../auth/session";

const COMPONENT_LABEL: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded_performance: "Degraded performance",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  under_maintenance: "Under maintenance",
};

const COMPONENT_COLOR: Record<ComponentStatus, string> = {
  operational: "#18794e",
  degraded_performance: "#bb7d00",
  partial_outage: "#cc4e00",
  major_outage: "#c62828",
  under_maintenance: "#4a5568",
};

const INCIDENT_LABEL: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

interface IncidentView extends Incident {
  updates: IncidentUpdate[];
}

/** Overall banner: worst active state across components + any open incident. */
function overall(components: Component[], hasActiveIncident: boolean): { text: string; color: string } {
  if (hasActiveIncident) return { text: "Active incident in progress", color: "#c62828" };
  const worst = components.reduce<ComponentStatus>((acc, c) => {
    const rank: Record<ComponentStatus, number> = {
      operational: 0,
      under_maintenance: 1,
      degraded_performance: 2,
      partial_outage: 3,
      major_outage: 4,
    };
    return rank[c.status] > rank[acc] ? c.status : acc;
  }, "operational");
  return worst === "operational"
    ? { text: "All systems operational", color: "#18794e" }
    : { text: COMPONENT_LABEL[worst], color: COMPONENT_COLOR[worst] };
}

/** Fetch everything the page needs from D1. */
export async function loadStatus(env: Env): Promise<{ components: Component[]; incidents: IncidentView[] }> {
  const db = new D1Db(env.DB);
  const sink = new InternalStatusSink(db);
  const components = await sink.listComponents();

  // Recent incidents: all unresolved + the most recent resolved ones.
  const incidents = await db.all<Incident>(
    `SELECT * FROM incidents
       ORDER BY (status != 'resolved') DESC, COALESCE(resolved_at, created_at) DESC
       LIMIT 25`,
  );
  const views: IncidentView[] = [];
  for (const inc of incidents) {
    const updates = await db.all<IncidentUpdate>(
      "SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC",
      [inc.id],
    );
    views.push({ ...inc, updates });
  }
  return { components, incidents: views };
}

export function renderStatusPage(
  data: { components: Component[]; incidents: IncidentView[] },
  session: Session,
): string {
  const active = data.incidents.filter((i) => i.status !== "resolved");
  const banner = overall(data.components, active.length > 0);

  const componentRows = data.components.length
    ? data.components
        .map(
          (c) => `<li class="row">
            <span>${esc(c.name)}</span>
            <span class="pill" style="background:${COMPONENT_COLOR[c.status]}">${COMPONENT_LABEL[c.status]}</span>
          </li>`,
        )
        .join("")
    : `<li class="row muted">No components configured yet.</li>`;

  const incidentBlocks = data.incidents.length
    ? data.incidents
        .map((inc) => {
          const updates = inc.updates
            .map(
              (u) => `<li class="update">
                <div class="update-head">
                  <span class="pill sm" style="background:${COMPONENT_COLOR[u.status === "resolved" ? "operational" : "partial_outage"]}">${INCIDENT_LABEL[u.status]}</span>
                  <time>${fmt(u.created_at)}</time>
                </div>
                <p>${esc(u.body)}</p>
              </li>`,
            )
            .join("");
          const state = inc.status === "resolved" ? "resolved" : "active";
          return `<article class="incident ${state}">
            <header>
              <h3>${esc(inc.name)}</h3>
              <span class="pill">${INCIDENT_LABEL[inc.status]}</span>
            </header>
            <div class="meta">Opened ${fmt(inc.created_at)}${inc.resolved_at ? ` · Resolved ${fmt(inc.resolved_at)}` : ""}</div>
            <ul class="updates">${updates || '<li class="muted">No updates yet.</li>'}</ul>
          </article>`;
        })
        .join("")
    : `<p class="muted">No incidents recorded.</p>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Incident Status</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #16181d; background: #f6f7f9; }
  .wrap { max-width: 56rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
  header.top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  header.top h1 { font-size: 1.15rem; margin: 0; }
  .who { font-size: .82rem; color: #5b6472; }
  .who a { color: #2563eb; text-decoration: none; margin-left: .6rem; }
  .banner { border-radius: 10px; padding: 1rem 1.25rem; color: #fff; font-weight: 600; font-size: 1.05rem; margin-bottom: 1.75rem; }
  section h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; margin: 1.75rem 0 .6rem; }
  ul.components { list-style: none; margin: 0; padding: 0; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
  .row { display: flex; justify-content: space-between; align-items: center; padding: .8rem 1rem; border-top: 1px solid #f0f1f3; }
  .row:first-child { border-top: 0; }
  .pill { color: #fff; font-size: .72rem; font-weight: 600; padding: .2rem .55rem; border-radius: 999px; white-space: nowrap; }
  .pill.sm { font-size: .68rem; }
  .incident { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .incident.active { border-left: 4px solid #c62828; }
  .incident.resolved { opacity: .82; }
  .incident header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; }
  .incident h3 { font-size: 1rem; margin: 0; }
  .incident .meta { font-size: .78rem; color: #6b7280; margin: .35rem 0 .75rem; }
  ul.updates { list-style: none; margin: 0; padding: 0; border-left: 2px solid #eceef1; }
  .update { padding: .1rem 0 .8rem 1rem; position: relative; }
  .update-head { display: flex; gap: .6rem; align-items: center; }
  .update time { font-size: .74rem; color: #8a929e; }
  .update p { margin: .3rem 0 0; }
  .muted { color: #9aa1ad; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e8ec; background: #0f1115; }
    ul.components, .incident { background: #171a20; border-color: #262a31; }
    .row { border-color: #21252c; }
    .incident h3, header.top h1 { color: #f1f3f5; }
    ul.updates { border-color: #2a2f37; }
  }
</style></head>
<body><div class="wrap">
  <header class="top">
    <h1>Incident Status</h1>
    <div class="who">${esc(session.name || session.user_id)}<a href="/auth/logout">Sign out</a></div>
  </header>
  <div class="banner" style="background:${banner.color}">${banner.text}</div>
  <section>
    <h2>Components</h2>
    <ul class="components">${componentRows}</ul>
  </section>
  <section>
    <h2>Incidents</h2>
    ${incidentBlocks}
  </section>
</div></body></html>`;
}

export function renderLoginPage(): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Incident Status</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f6f7f9; color: #16181d; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 2.25rem 2.5rem; text-align: center; max-width: 22rem; }
  h1 { font-size: 1.2rem; margin: 0 0 .4rem; }
  p { color: #6b7280; margin: 0 0 1.5rem; }
  a.btn { display: inline-block; background: #4a154b; color: #fff; text-decoration: none; font-weight: 600; padding: .7rem 1.3rem; border-radius: 8px; }
  @media (prefers-color-scheme: dark) { body { background: #0f1115; color: #e6e8ec; } .card { background: #171a20; border-color: #262a31; } h1 { color: #f1f3f5; } }
</style></head>
<body><div class="card">
  <h1>Incident Status</h1>
  <p>This dashboard is restricted to our Slack workspace.</p>
  <a class="btn" href="/auth/login">Sign in with Slack</a>
</div></body></html>`;
}
