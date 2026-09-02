import { Badge } from "@/components/ui/badge";
import {
  COMPONENT_LABEL,
  INCIDENT_LABEL,
  type ComponentStatus,
  type IncidentStatus,
} from "@/types";
import { cn } from "@/lib/utils";

// Monochrome: severity is shown by fill, not hue. Operational/resolved = outline
// (quiet); anything active = solid (loud). A leading dot reinforces it.
function isQuiet(status: ComponentStatus | IncidentStatus): boolean {
  return status === "operational" || status === "resolved";
}

export function ComponentBadge({ status }: { status: ComponentStatus }) {
  const quiet = isQuiet(status);
  return (
    <Badge variant={quiet ? "outline" : "default"} className="gap-1.5">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          quiet ? "bg-muted-foreground" : "bg-primary-foreground",
        )}
      />
      {COMPONENT_LABEL[status]}
    </Badge>
  );
}

export function IncidentBadge({ status }: { status: IncidentStatus }) {
  const quiet = isQuiet(status);
  return (
    <Badge variant={quiet ? "outline" : "default"}>{INCIDENT_LABEL[status]}</Badge>
  );
}
