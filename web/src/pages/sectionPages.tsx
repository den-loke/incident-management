import { OnCallSection } from "@/components/OnCallSection";
import { FollowUpsSection } from "@/components/FollowUpsSection";
import { InsightsSection } from "@/components/InsightsSection";
import { ReportPanel } from "@/components/ReportPanel";
import { TeamsSection } from "@/components/TeamsSection";
import { MaintenanceSection } from "@/components/MaintenanceSection";
import type { StatusResponse } from "@/types";

// These sections are self-fetching (own /api call), so the pages are thin.
// A leading h1 gives each page a title; the section supplies the rest.

export function OnCallPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">On-call</h1>
      <OnCallSection />
    </div>
  );
}

export function FollowUpsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Follow-ups</h1>
      <FollowUpsSection />
    </div>
  );
}

export function InsightsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Insights</h1>
      <ReportPanel />
      <InsightsSection />
    </div>
  );
}

export function TeamsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Teams</h1>
      <TeamsSection />
    </div>
  );
}

export function MaintenancePage({ data, onChange }: { data: StatusResponse; onChange: () => void }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Maintenance</h1>
      <MaintenanceSection windows={data.maintenance} onChange={onChange} />
    </div>
  );
}
