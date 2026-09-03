import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/form";
import * as api from "@/lib/api";
import type { FollowUp, HistoryIncident } from "@/types";
import { SEVERITY_LABEL, ROUTING_PATH_LABEL, INCIDENT_LABEL } from "@/types";

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function FollowUps() {
  const [items, setItems] = useState<FollowUp[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback((open: boolean) => {
    api.fetchFollowUps(open).then(setItems).catch((e) => setErr(String((e as Error).message)));
  }, []);
  useEffect(() => load(onlyOpen), [load, onlyOpen]);

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs text-muted-foreground">
          Follow-ups {onlyOpen ? "(outstanding)" : "(all)"}
        </h3>
        <Select className="h-7 w-auto text-xs" value={onlyOpen ? "open" : "all"} onChange={(e) => setOnlyOpen(e.target.value === "open")}>
          <option value="open">Outstanding</option>
          <option value="all">All</option>
        </Select>
      </div>
      <Card>
        <CardContent className="p-0">
          {err ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Error: {err}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{onlyOpen ? "No outstanding follow-ups. 🎉" : "No action items yet."}</p>
          ) : (
            items.map((f, i) => (
              <div key={f.id}>
                {i > 0 && <Separator />}
                <div className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className={f.done ? "line-through text-muted-foreground" : ""}>{f.description}</span>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {f.incident_name}
                      {f.owner ? ` · @${f.owner}` : ""}
                      {f.jira_key ? ` · ${f.jira_key}` : ""}
                    </div>
                  </div>
                  <Badge variant={f.done ? "outline" : "default"}>{f.done ? "Done" : "Open"}</Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function History() {
  const [items, setItems] = useState<HistoryIncident[]>([]);
  const [severity, setSeverity] = useState("");
  const [path, setPath] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback((sev: string, rp: string) => {
    api.fetchHistory({ severity: sev || undefined, routing_path: rp || undefined })
      .then(setItems).catch((e) => setErr(String((e as Error).message)));
  }, []);
  useEffect(() => load(severity, path), [load, severity, path]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-xs text-muted-foreground">Incident history</h3>
        <div className="flex gap-2">
          <Select className="h-7 w-auto text-xs" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All severities</option>
            <option value="sev1">SEV1</option>
            <option value="sev2">SEV2</option>
            <option value="sev3">SEV3</option>
          </Select>
          <Select className="h-7 w-auto text-xs" value={path} onChange={(e) => setPath(e.target.value)}>
            <option value="">All paths</option>
            <option value="internal">Internal</option>
            <option value="external">External</option>
          </Select>
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {err ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">Error: {err}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No incidents match.</p>
          ) : (
            items.map((h, i) => (
              <div key={h.id}>
                {i > 0 && <Separator />}
                <div className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="truncate">{h.name}</span>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {h.status === "resolved" && h.resolved_at ? `resolved ${fmt(h.resolved_at)}` : `opened ${fmt(h.created_at)}`}
                      {h.has_postmortem ? " · post-mortem" : ""}
                      {h.open_action_items > 0 ? ` · ${h.open_action_items} open action(s)` : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge variant="outline">{SEVERITY_LABEL[h.severity]}</Badge>
                    <Badge variant="outline">{ROUTING_PATH_LABEL[h.routing_path]}</Badge>
                    <Badge variant={h.status === "resolved" ? "outline" : "default"}>{INCIDENT_LABEL[h.status]}</Badge>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function FollowUpsSection() {
  return (
    <section className="mb-8">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Follow-ups &amp; history</h2>
      <FollowUps />
      <History />
    </section>
  );
}
