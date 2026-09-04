import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { IncidentBadge } from "@/components/StatusBadge";
import { fmt } from "@/components/incidentUi";
import { Link } from "@/lib/router";
import type { Incident, StatusResponse } from "@/types";
import { SEVERITY_LABEL, ROUTING_PATH_LABEL } from "@/types";

function Row({ inc }: { inc: Incident }) {
  return (
    <Link to={`/incidents/${inc.id}`} className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-muted/50">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{inc.name}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          Opened {fmt(inc.created_at)}
          {inc.resolved_at ? ` · Resolved ${fmt(inc.resolved_at)}` : ""}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline">{SEVERITY_LABEL[inc.severity]}</Badge>
        <Badge variant="outline">{ROUTING_PATH_LABEL[inc.routing_path]}</Badge>
        <IncidentBadge status={inc.status} />
      </div>
    </Link>
  );
}

function Group({ title, items }: { title: string; items: Incident[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <Card>
        <CardContent className="p-0">
          {items.map((inc, i) => (
            <div key={inc.id}>
              {i > 0 && <Separator />}
              <Row inc={inc} />
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

export function IncidentsListPage({ data }: { data: StatusResponse }) {
  const active = data.incidents.filter((i) => i.status !== "resolved");
  const resolved = data.incidents.filter((i) => i.status === "resolved");
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold tracking-tight">Incidents</h1>
      {data.incidents.length === 0 ? (
        <p className="text-sm text-muted-foreground">No incidents recorded.</p>
      ) : (
        <>
          <Group title="Active" items={active} />
          <Group title="Resolved" items={resolved} />
        </>
      )}
    </div>
  );
}
