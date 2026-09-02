import type { Meta, StoryObj } from "@storybook/react";
import { StatusPage } from "@/components/StatusPage";
import { LoginScreen } from "@/components/LoginScreen";
import {
  allOperational,
  activeIncidentState,
  emptyState,
} from "./fixtures";

// StatusPage renders purely from props; onChange is a no-op here, so stories
// never touch /api/* — this is the Storybook-style harness for screenshots.
const meta: Meta<typeof StatusPage> = {
  title: "Pages/StatusPage",
  component: StatusPage,
  args: { onChange: () => {} },
};
export default meta;

type Story = StoryObj<typeof StatusPage>;

export const AllOperational: Story = { args: { data: allOperational } };
export const ActiveIncident: Story = { args: { data: activeIncidentState } };
export const Empty: Story = { args: { data: emptyState } };

export const Login: StoryObj<typeof LoginScreen> = {
  render: () => <LoginScreen />,
};
