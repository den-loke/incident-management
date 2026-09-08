import type { Meta, StoryObj } from "@storybook/react";
import { StatusPageView } from "@/pages/StatusPageView";
import { IncidentDetailPage } from "@/pages/IncidentDetailPage";
import { EscalationTimeline } from "@/components/OnCallSection";
import { PostmortemSection } from "@/components/PostmortemSection";
import { AuditSection } from "@/components/AuditSection";
import { DecisionGuideSection } from "@/components/DecisionGuideSection";
import { LoginScreen } from "@/components/LoginScreen";
import {
  allOperational,
  activeIncidentState,
  emptyState,
  escalationEvents,
  escalationNames,
} from "./fixtures";

// StatusPageView renders purely from `data` — stories never touch /api/*.
// This is the Storybook harness used for screenshots.
const meta: Meta<typeof StatusPageView> = {
  title: "Pages/StatusPage",
  component: StatusPageView,
};
export default meta;

type Story = StoryObj<typeof StatusPageView>;

export const AllOperational: Story = { args: { data: allOperational } };
export const ActiveIncident: Story = { args: { data: activeIncidentState } };
export const Empty: Story = { args: { data: emptyState } };

export const Login: StoryObj<typeof LoginScreen> = {
  render: () => <LoginScreen />,
};

// Rich incident-detail page — Properties rail (timestamps & durations, roles,
// links) + activity timeline with gap markers. Renders purely from `data`.
export const IncidentDetailActive: StoryObj<typeof IncidentDetailPage> = {
  name: "IncidentDetail (active)",
  render: () => (
    <div className="p-4">
      <IncidentDetailPage id="inc_active" data={activeIncidentState} onChange={() => {}} />
    </div>
  ),
};

export const IncidentDetailResolved: StoryObj<typeof IncidentDetailPage> = {
  name: "IncidentDetail (resolved)",
  render: () => (
    <div className="p-4">
      <IncidentDetailPage id="inc_resolved" data={activeIncidentState} onChange={() => {}} />
    </div>
  ),
};

export const DecisionGuide: StoryObj<typeof DecisionGuideSection> = {
  name: "DecisionGuide",
  render: () => {
    const flow = {
      severity: [
        { severity: "sev1", label: "SEV1", headline: "Many orgs, or a Tier-1 org, blocked from transacting.", includes: ["Many customers across many orgs cannot transact (log in, pay).", "A single Tier-1 org cannot transact."], excludes: ["Only a handful of customers affected.", "A single mid-tier org affected — that is SEV2 or lower."] },
        { severity: "sev2", label: "SEV2", headline: "Significant degradation, or a moderate number of customers blocked across multiple orgs.", includes: ["Significantly degraded performance affecting transacting.", "A moderate number of customers across multiple orgs blocked.", "A single mid-tier org blocked from transacting."], excludes: ["Full, wide transaction outage — that is SEV1."] },
        { severity: "sev3", label: "SEV3", headline: "Minor / low-impact. No transaction impact; a workaround exists.", includes: ["No customer transaction impact.", "A workaround exists.", "Cosmetic / internal-only (catch-all)."], excludes: ["Anything blocking transactions — that is SEV2 or SEV1."] },
      ],
      routing: [
        { path: "internal", label: "Internal — page on-call", headline: "It's our systems / our fault.", detail: "Full response: pages on-call + both leads." },
        { path: "external", label: "External — communicate", headline: "It's an upstream or partner issue.", detail: "Communicate, don't page: Support-lead only." },
      ],
      escalation_triggers: ["Impact widened — more orgs affected.", "A Tier-1 org is now affected.", "It now meets a higher tier's bar."],
      external_comms_threshold: ["Any SEV1: publish.", "Customer-facing SEV2: publish.", "No customer transaction impact: keep internal."],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(flow), { headers: { "content-type": "application/json" } });
    return (
      <div className="max-w-3xl p-4">
        <DecisionGuideSection />
      </div>
    );
  },
};

// Audit log — append-only who-did-what, actor names resolved from user_names.
export const AuditLog: StoryObj<typeof AuditSection> = {
  name: "AuditLog",
  render: () => {
    const entries = [
      { id: "a1", at: "2026-09-02T04:44:00Z", actor: "web:U_BOB", action: "incident.resolve.confirm", target_type: "incident", target_id: "INC-42", detail: null, source: "web" },
      { id: "a2", at: "2026-09-02T04:41:00Z", actor: "web:U_ALICE", action: "incident.resolve.request", target_type: "incident", target_id: "INC-42", detail: null, source: "web" },
      { id: "a3", at: "2026-09-02T04:35:00Z", actor: "web:U_ALICE", action: "incident.severity.set", target_type: "incident", target_id: "INC-42", detail: { severity: "sev1" }, source: "web" },
      { id: "a4", at: "2026-09-02T04:30:00Z", actor: "web:U_ALICE", action: "incident.declare", target_type: "incident", target_id: "INC-42", detail: null, source: "web" },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ entries }), { headers: { "content-type": "application/json" } });
    return (
      <div className="max-w-2xl p-4">
        <AuditSection names={{ U_ALICE: "Alice Chen", U_BOB: "Bob Ng" }} />
      </div>
    );
  },
};

// Post-mortem editor — fixed sections with per-section help text + embedded
// timeline. Stubs fetch so the self-fetching section renders a fixture draft.
export const PostmortemEditor: StoryObj<typeof PostmortemSection> = {
  name: "PostmortemEditor",
  render: () => {
    const draft = {
      id: "pm_1",
      incident_id: "inc_resolved",
      status: "draft",
      summary: "Webhook delivery latency was elevated for ~45 minutes due to a backed-up queue.",
      impact: "Partner webhook callbacks delayed up to 12 minutes; no data lost.",
      root_cause: "A slow consumer held connections open, starving the delivery pool.",
      contributing_factors: "Alerting fired late; the pool size had no headroom. Learning: add pool saturation alerts.",
      action_items: [
        { id: "ai_1", description: "Add pool-saturation alert", owner: null, done: false, jira_key: null },
        { id: "ai_2", description: "Raise delivery pool size + backpressure", owner: null, done: true, jira_key: "OPS-321" },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify(draft), { headers: { "content-type": "application/json" } });
    const timeline = activeIncidentState.incidents.find((i) => i.id === "inc_resolved")!.updates;
    return (
      <div className="max-w-2xl p-4">
        <PostmortemSection incidentId="inc_resolved" timeline={timeline} />
      </div>
    );
  },
};

// Escalation timeline — grouped vertical sequence per alert with gap markers.
export const EscalationTimelineStory: StoryObj<typeof EscalationTimeline> = {
  name: "EscalationTimeline",
  render: () => (
    <div className="max-w-2xl p-4">
      <EscalationTimeline events={escalationEvents} names={escalationNames} />
    </div>
  ),
};
