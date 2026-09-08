import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/api";
import type { AuditEntry } from "@/lib/api";
import { fmt } from "@/components/incidentUi";
import { uname } from "@/lib/utils";

// Human labels for the audit action verbs (hard-coded — the action set is fixed).
const ACTION_LABEL: Record<string, string> = {
  "incident.declare": "Declared incident",
  "incident.update.post": "Posted update",
  "incident.severity.set": "Changed severity",
  "incident.resolve.request": "Requested resolve",
  "incident.resolve.confirm": "Confirmed resolve",
};

/** Render the actor: "web:U123" → the person's name; "system" stays as-is. */
function actorLabel(actor: string, names?: Record<string, string>): string {
  const m = actor.match(/^web:(.+)$/);
  if (m) return uname(m[1], names).replace(/^@/, "");
  if (actor === "system") return "System";
  return uname(actor, names).replace(/^@/, "");
}

export function AuditSection({ names }: { names?: Record<string, string> }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .fetchAudit(200)
      .then(setEntries)
      .catch((e) => setErr(String((e as Error).message)));
  }, []);

  if (err) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          Couldn’t load the audit log: {err}
        </CardContent>
      </Card>
    );
  }
  if (!entries) return <p className="text-sm text-muted-foreground">Loading audit log…</p>;

  return (
    <Card>
      <CardContent className="p-0">
        {entries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No audit entries yet.</p>
        ) : (
          entries.map((e, i) => (
            <div key={e.id}>
              {i > 0 && <Separator />}
              <div className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                  {e.target_id ? (
                    <span className="text-muted-foreground"> · {e.target_id}</span>
                  ) : null}
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {actorLabel(e.actor, names)} · {fmt(e.at)}
                    <Badge variant="outline" className="ml-2">{e.source}</Badge>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
