import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { PostIncidentFlow } from "@/lib/api";

function mark(state: api.ChecklistState): string {
  return state === "done" ? "✓" : state === "blocked" ? "✕" : "○";
}

export function PostIncidentFlowSection({ incidentId }: { incidentId: string }) {
  const [flow, setFlow] = useState<PostIncidentFlow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .getPostIncidentFlow(incidentId)
      .then(setFlow)
      .catch(() => setFlow(null))
      .finally(() => setLoaded(true));
  }, [incidentId]);

  if (!loaded || !flow) return null;

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-xs text-muted-foreground">Post-incident flow</h4>
        <Badge variant="outline">{flow.complete ? "Complete" : "In progress"}</Badge>
      </div>
      <ul className="space-y-1 text-sm">
        {flow.items.map((c) => (
          <li key={c.key} className="flex items-start gap-2">
            <span
              className={
                c.state === "done"
                  ? "text-foreground"
                  : "text-muted-foreground"
              }
              aria-hidden
            >
              {mark(c.state)}
            </span>
            <span className={c.state === "done" ? "" : "text-muted-foreground"}>
              {c.label}
              <span className="ml-1 text-xs opacity-70">— {c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
