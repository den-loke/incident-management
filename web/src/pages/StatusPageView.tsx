import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ComponentBadge, IncidentBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { overallLine, fmt } from "@/components/incidentUi";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { StatusResponse } from "@/types";
import { SEVERITY_LABEL } from "@/types";

export function StatusPageView({ data }: { data: StatusResponse }) {
  const active = data.incidents.filter((i) => i.status !== "resolved");
  const line = overallLine(data.components, active.length > 0);
  const healthy = active.length === 0 && data.components.every((c) => c.status === "operational");

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold tracking-tight">Status</h1>

      <Card>
        <CardContent className="flex items-center gap-3 py-5">
          <span className="relative flex h-3 w-3">
            {!healthy && (
              <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", active.length ? "bg-bad" : "bg-warn")} />
            )}
            <span className={cn("relative inline-flex h-3 w-3 rounded-full", healthy ? "bg-ok" : active.length ? "bg-bad" : "bg-warn")} />
          </span>
          <span className="text-base font-medium">{line}</span>
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Components</h2>
        <Card>
          <CardContent className="p-0">
            {data.components.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No components configured yet.</p>
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
          Active incidents
        </h2>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active incidents. 🎉</p>
        ) : (
          <Card>
            <CardContent className="p-0">
              {active.map((inc, i) => (
                <div key={inc.id}>
                  {i > 0 && <Separator />}
                  <Link
                    to={`/incidents/${inc.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="truncate text-sm font-medium">{inc.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {SEVERITY_LABEL[inc.severity]} · opened {fmt(inc.created_at)}
                      </span>
                    </span>
                    <IncidentBadge status={inc.status} />
                  </Link>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>

      <MaintenanceSummary windows={data.maintenance} />
    </div>
  );
}

function MaintenanceSummary({ windows }: { windows: StatusResponse["maintenance"] }) {
  // Surface planned + ongoing maintenance on the status page (read-only; manage
  // on the Maintenance page). Completed/cancelled windows are hidden here.
  const upcoming = windows.filter((w) => w.status === "scheduled" || w.status === "active");
  if (upcoming.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Scheduled maintenance
      </h2>
      <Card>
        <CardContent className="p-0">
          {upcoming.map((w, i) => (
            <div key={w.id}>
              {i > 0 && <Separator />}
              <div className="flex items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{w.title}</span>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {fmt(w.starts_at)} → {fmt(w.ends_at)}
                    {w.components.length ? ` · ${w.components.length} component${w.components.length === 1 ? "" : "s"}` : ""}
                  </div>
                </div>
                <Badge variant={w.status === "active" ? "default" : "outline"}>
                  {w.status === "active" ? "In progress" : "Scheduled"}
                </Badge>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
