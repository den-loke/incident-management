import { IncidentCard } from "@/components/incidentUi";
import { Link } from "@/lib/router";
import type { StatusResponse } from "@/types";

export function IncidentDetailPage({
  id,
  data,
  onChange,
}: {
  id: string;
  data: StatusResponse;
  onChange: () => void;
}) {
  const incident = data.incidents.find((i) => i.id === id);
  return (
    <div className="space-y-4">
      <Link to="/incidents" className="text-sm text-muted-foreground hover:text-foreground">
        ← All incidents
      </Link>
      {incident ? (
        <IncidentCard incident={incident} onChange={onChange} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Incident not found. It may have been removed, or the link is stale.
        </p>
      )}
    </div>
  );
}
