import type { Meta, StoryObj } from "@storybook/react";
import { StatusPageView } from "@/pages/StatusPageView";
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
