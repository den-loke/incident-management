// Codified incident decision flow — LOKE's REAL criteria, hard-coded (single-tenant
// stance: not a builder). Captured from Den, 2026-09-08. Single source of truth for
// both the read-only decision-guide page and the inline declare guidance, so the two
// can never drift. See ROADMAP → "Codified decision flow".
//
// Four decisions:
//   1. Severity at declare  (SEV1 / SEV2 / SEV3)
//   2. Routing: page on-call vs communicate  (internal vs external)
//   3. When to escalate severity mid-incident
//   4. When it's "major" enough for the status page / external comms
//
// Nothing here auto-decides — severity/routing stay the declarer's choice. This is
// GUIDANCE that explains the criteria at the point of choosing, plus a reference page.

import type { IncidentSeverity, RoutingPath } from "../status/types";

export interface SeverityCriterion {
  severity: IncidentSeverity;
  label: string;
  /** One-line headline shown next to the option in the declare picker. */
  headline: string;
  /** Concrete inclusion examples. */
  includes: string[];
  /** What is explicitly NOT this severity (guards over-classifying). */
  excludes: string[];
}

export const SEVERITY_CRITERIA: SeverityCriterion[] = [
  {
    severity: "sev1",
    label: "SEV1",
    headline: "Many orgs, or a Tier-1 org, blocked from transacting.",
    includes: [
      "Many customers across many orgs cannot transact (log in, pay).",
      "A single Tier-1 org cannot transact.",
      "Core revenue path (checkout / payments / login) down at scale.",
    ],
    excludes: [
      "Only a handful of customers affected.",
      "A single mid-tier org affected — that is SEV2 or lower.",
    ],
  },
  {
    severity: "sev2",
    label: "SEV2",
    headline: "Significant degradation, or a moderate number of customers blocked across multiple orgs.",
    includes: [
      "Significantly degraded performance (slow / intermittent) affecting transacting.",
      "A moderate number of customers across multiple orgs blocked from transacting.",
      "A single mid-tier org blocked from transacting.",
    ],
    excludes: [
      "Full, wide transaction outage (many orgs / a Tier-1 org) — that is SEV1.",
      "No transaction impact and a workaround exists — that is SEV3.",
    ],
  },
  {
    severity: "sev3",
    label: "SEV3",
    headline: "Minor / low-impact. No transaction impact; a workaround exists.",
    includes: [
      "No customer transaction impact.",
      "A workaround exists.",
      "Cosmetic, internal-only, or single-user issues. (Catch-all when not SEV1/SEV2.)",
    ],
    excludes: ["Anything blocking transactions — that is SEV2 or SEV1."],
  },
];

export interface RoutingCriterion {
  path: RoutingPath;
  label: string;
  headline: string;
  detail: string;
}

export const ROUTING_CRITERIA: RoutingCriterion[] = [
  {
    path: "internal",
    label: "Internal — page on-call",
    headline: "It's our systems / our fault.",
    detail:
      "A problem in software we run. Full response: pages the on-call engineer, both leads, drives to resolution.",
  },
  {
    path: "external",
    label: "External — communicate",
    headline: "It's an upstream or partner issue.",
    detail:
      "A problem in a system we depend on but don't run. We COMMUNICATE, we don't page an engineer to fix it: Support-lead only, no on-call page. Promote to an incident if we need to keep customers informed.",
  },
];

/** Triggers that should bump a RUNNING incident up a severity level. */
export const ESCALATION_TRIGGERS: string[] = [
  "Impact widened — more orgs are now affected.",
  "A Tier-1 org is now affected when it wasn't before.",
  "The incident now meets a higher tier's bar (re-check the severity criteria).",
];

/** When an incident is major enough to publish externally (status page / comms). */
export const EXTERNAL_COMMS_THRESHOLD: string[] = [
  "Any SEV1 — many orgs or a Tier-1 org can't transact: publish.",
  "Customer-facing SEV2 (customers blocked from transacting): publish.",
  "Below that (no customer transaction impact): keep internal.",
];

export interface DecisionFlow {
  severity: SeverityCriterion[];
  routing: RoutingCriterion[];
  escalation_triggers: string[];
  external_comms_threshold: string[];
}

/** The whole decision flow as structured data (for the API + reference page). */
export function buildDecisionFlow(): DecisionFlow {
  return {
    severity: SEVERITY_CRITERIA,
    routing: ROUTING_CRITERIA,
    escalation_triggers: ESCALATION_TRIGGERS,
    external_comms_threshold: EXTERNAL_COMMS_THRESHOLD,
  };
}

/** One-line severity headline for inline pickers (Slack modal / web declare). */
export function severityHeadline(severity: IncidentSeverity): string {
  return SEVERITY_CRITERIA.find((c) => c.severity === severity)?.headline ?? "";
}
