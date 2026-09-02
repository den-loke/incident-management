import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { buttonVariants } from "@/components/ui/button";
import { ComponentBadge, IncidentBadge } from "@/components/StatusBadge";
import type { Component, Incident, StatusResponse } from "@/types";
import { cn } from "@/lib/utils";

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

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{incident.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Opened {fmt(incident.created_at)}
            {incident.resolved_at ? ` · Resolved ${fmt(incident.resolved_at)}` : ""}
          </p>
        </div>
        <IncidentBadge status={incident.status} />
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

export function StatusPage({ data }: { data: StatusResponse }) {
  const active = data.incidents.filter((i) => i.status !== "resolved");
  const line = overallLine(data.components, active.length > 0);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Incident Status</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
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

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Incidents
        </h2>
        {data.incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No incidents recorded.</p>
        ) : (
          <div className="space-y-3">
            {data.incidents.map((inc) => (
              <IncidentCard key={inc.id} incident={inc} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
