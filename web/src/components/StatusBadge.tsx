import { Badge } from "@/components/ui/badge";
import {
  COMPONENT_LABEL,
  INCIDENT_LABEL,
  type ComponentStatus,
  type IncidentStatus,
} from "@/types";
import { cn } from "@/lib/utils";

// Chrome stays monochrome; the STATUS DOT carries a restrained semantic hue so
// health is scannable at a glance (green ok · amber degraded · red outage · grey neutral).
const COMPONENT_DOT: Record<ComponentStatus, string> = {
  operational: "bg-ok",
  under_maintenance: "bg-info",
  degraded_performance: "bg-warn",
  partial_outage: "bg-warn",
  major_outage: "bg-bad",
};

const INCIDENT_DOT: Record<IncidentStatus, string> = {
  investigating: "bg-bad",
  identified: "bg-warn",
  monitoring: "bg-info",
  resolved: "bg-ok",
};

function isQuiet(status: ComponentStatus | IncidentStatus): boolean {
  return status === "operational" || status === "resolved";
}

export function ComponentBadge({ status }: { status: ComponentStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium">
      <span className={cn("h-1.5 w-1.5 rounded-full", COMPONENT_DOT[status])} />
      {COMPONENT_LABEL[status]}
    </Badge>
  );
}

export function IncidentBadge({ status }: { status: IncidentStatus }) {
  return (
    <Badge variant={isQuiet(status) ? "outline" : "default"} className="gap-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          isQuiet(status) ? INCIDENT_DOT[status] : "bg-current opacity-70",
        )}
      />
      {INCIDENT_LABEL[status]}
    </Badge>
  );
}
