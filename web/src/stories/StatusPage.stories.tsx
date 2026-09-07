import type { Meta, StoryObj } from "@storybook/react";
import { StatusPageView } from "@/pages/StatusPageView";
import { IncidentDetailPage } from "@/pages/IncidentDetailPage";
import { LoginScreen } from "@/components/LoginScreen";
import { allOperational, activeIncidentState, emptyState } from "./fixtures";

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
