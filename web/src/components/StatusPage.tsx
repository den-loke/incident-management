import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { buttonVariants } from "@/components/ui/button";
import { ComponentBadge, IncidentBadge } from "@/components/StatusBadge";
import { DeclareIncidentButton, IncidentActions } from "@/components/IncidentActions";
import { PostmortemSection } from "@/components/PostmortemSection";
import { ReportPanel } from "@/components/ReportPanel";
import { InsightsSection } from "@/components/InsightsSection";
import { FollowUpsSection } from "@/components/FollowUpsSection";
import { OnCallSection } from "@/components/OnCallSection";
import { TeamsSection } from "@/components/TeamsSection";
import { MaintenanceSection } from "@/components/MaintenanceSection";
import type { Component, Incident, StatusResponse } from "@/types";
import { ROLE_LABEL, type IncidentRole, type RoleAssignment } from "@/types";
import { SEVERITY_LABEL } from "@/types";
import { ROUTING_PATH_LABEL } from "@/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ROLE_ORDER: IncidentRole[] = ["engineering_lead", "customer_support_lead"];

function RolesLine({ roles }: { roles: RoleAssignment[] }) {
  const byRole = new Map(roles.map((r) => [r.role, r.slack_user_id]));
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {ROLE_ORDER.map((role) => (
        <span key={role}>
          {ROLE_LABEL[role]}:{" "}
          <span className="text-foreground">
            {byRole.has(role) ? `@${byRole.get(role)}` : "unassigned"}
          </span>
        </span>
      ))}
    </div>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const SEVERITY: Record<Component["status"], number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

function overallLine(components: Component[], hasActive: boolean): string {
  if (hasActive) return "Active incident in progress";
  const worst = components.reduce<Component["status"]>(
    (acc, c) => (SEVERITY[c.status] > SEVERITY[acc] ? c.status : acc),
    "operational",
  );
  return worst === "operational" ? "All systems operational" : "Degraded service";
}

function IncidentCard({
  incident,
  onChange,
}: {
  incident: Incident;
  onChange: () => void;
}) {
  const active = incident.status !== "resolved";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{incident.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Opened {fmt(incident.created_at)}
            {incident.resolved_at ? ` · Resolved ${fmt(incident.resolved_at)}` : ""}
          </p>
          {incident.channel ? (
            <a
              href={`https://slack.com/app_redirect?channel=${incident.channel}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline underline-offset-2 hover:no-underline"
            >
              Open in Slack ↗
            </a>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{SEVERITY_LABEL[incident.severity]}</Badge>
          <Badge variant="outline">{ROUTING_PATH_LABEL[incident.routing_path]}</Badge>
          <IncidentBadge status={incident.status} />
        </div>
      </CardHeader>
      <CardContent>
        <RolesLine roles={incident.roles} />
        {incident.updates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates yet.</p>
        ) : (
          <ol className="space-y-3 pl-1">
            {incident.updates.map((u) => (
              <li key={u.id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <IncidentBadge status={u.status} />
                  <time className="text-xs text-muted-foreground">
                    {fmt(u.created_at)}
                  </time>
                </div>
                <p className="text-sm">{u.body}</p>
              </li>
            ))}
          </ol>
        )}
        {active && (
          <div className="mt-4">
            <IncidentActions
              incidentId={incident.id}
              severity={incident.severity}
              pending={
                incident.pending_resolution
                  ? {
                      requested_by: incident.pending_resolution.requested_by,
                      note: incident.pending_resolution.note,
                    }
                  : null
              }
              onDone={onChange}
            />
          </div>
        )}
        {!active && (
          <>
            <div className="my-4">
              <Separator />
            </div>
            <PostmortemSection incidentId={incident.id} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function StatusPage({
  data,
  onChange,
}: {
  data: StatusResponse;
  onChange: () => void;
}) {
  const active = data.incidents.filter((i) => i.status !== "resolved");
  const line = overallLine(data.components, active.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Incident Status</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <DeclareIncidentButton onDone={onChange} />
          <span>{data.viewer.name || data.viewer.user_id}</span>
          <a
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            href="/auth/logout"
          >
            Sign out
          </a>
        </div>
      </header>

      <Card className="mb-8">
        <CardContent className="flex items-center gap-3 py-4">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              active.length ? "bg-foreground" : "bg-muted-foreground",
            )}
          />
          <span className="font-medium">{line}</span>
        </CardContent>
      </Card>

      <ReportPanel />

      <InsightsSection />

      <FollowUpsSection />

      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Components
        </h2>
        <Card>
          <CardContent className="p-0">
            {data.components.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No components configured yet.
              </p>
            ) : (
              data.components.map((c, i) => (
                <div key={c.id}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center justify-between px-4 py-3">
                    <span className="text-sm">{c.name}</span>
                    <ComponentBadge status={c.status} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <TeamsSection />

      <OnCallSection />

      <MaintenanceSection windows={data.maintenance} onChange={onChange} />

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Incidents
        </h2>
        {data.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No incidents recorded.</p>
        ) : (
          <div className="space-y-3">
            {data.incidents.map((inc) => (
              <IncidentCard key={inc.id} incident={inc} onChange={onChange} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
