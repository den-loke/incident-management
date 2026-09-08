import type { Meta, StoryObj } from "@storybook/react";
import { StatusPageView } from "@/pages/StatusPageView";
import { IncidentDetailPage } from "@/pages/IncidentDetailPage";
import { EscalationTimeline } from "@/components/OnCallSection";
import { PostmortemSection } from "@/components/PostmortemSection";
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
