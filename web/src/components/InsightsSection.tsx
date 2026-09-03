import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import * as api from "@/lib/api";
import type { Insights, InsightsBucket } from "@/types";
import { SEVERITY_LABEL, ROUTING_PATH_LABEL, type IncidentSeverity, type RoutingPath } from "@/types";

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function labelFor(kind: "severity" | "path", key: string): string {
  if (kind === "severity") return SEVERITY_LABEL[key as IncidentSeverity] ?? key;
  if (kind === "path") return ROUTING_PATH_LABEL[key as RoutingPath] ?? key;
  return key;
}

/** A minimal monochrome horizontal bar row (no chart lib). */
function Bar({ label, value, max, suffix }: { label: string; value: number; max: number; suffix?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <div className="relative h-4 flex-1 rounded bg-muted">
        <div className="absolute inset-y-0 left-0 rounded bg-foreground" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums">{value}{suffix ?? ""}</span>
    </div>
  );
}

function BucketChart({ title, kind, buckets }: { title: string; kind: "severity" | "path"; buckets: InsightsBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div>
      <h3 className="mb-1 text-xs text-muted-foreground">{title}</h3>
      {buckets.map((b) => (
        <Bar key={b.key} label={labelFor(kind, b.key)} value={b.count} max={max} />
      ))}
    </div>
  );
}

export function InsightsSection() {
  const [period, setPeriod] = useState("90d");
  const [data, setData] = useState<Insights | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback((p: string) => {
    api
      .fetchInsights(p)
      .then(setData)
      .catch((e) => setErr(String((e as Error).message)));
  }, []);

  useEffect(() => load(period), [load, period]);

  if (err) {
    return (
      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Insights</h2>
        <Card><CardContent className="py-4 text-sm text-muted-foreground">Couldn’t load insights: {err}</CardContent></Card>
      </section>
    );
  }
  if (!data) return null;

  const monthMax = Math.max(1, ...data.by_month.map((m) => Math.max(m.opened, m.resolved)));

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Insights</h2>
        <Select className="h-8 w-auto" value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="all">All time</option>
        </Select>
      </div>

      <Card className="mb-3">
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 py-4 text-sm">
          <span>Opened: <span className="font-medium">{data.total_opened}</span></span>
          <span className="text-muted-foreground">Overall MTTR: {fmtDuration(data.overall_mttr_seconds)}</span>
          <span className="text-muted-foreground">Open action items: {data.open_action_items}</span>
        </CardContent>
      </Card>

      <Card className="mb-3">
        <CardContent className="grid gap-6 py-4 sm:grid-cols-2">
          <BucketChart title="By severity" kind="severity" buckets={data.by_severity} />
          <BucketChart title="By routing path" kind="path" buckets={data.by_routing_path} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h3 className="mb-1 text-xs text-muted-foreground">Monthly trend (opened ▚ resolved)</h3>
          {data.by_month.length === 0 ? (
            <p className="text-sm text-muted-foreground">No incidents in this window.</p>
          ) : (
            data.by_month.map((m) => (
              <div key={m.month} className="py-1 text-sm">
                <div className="mb-0.5 flex justify-between text-xs text-muted-foreground">
                  <span>{m.month}</span>
                  <span className="tabular-nums">{m.opened} opened · {m.resolved} resolved</span>
                </div>
                <div className="flex gap-1">
                  <div className="h-3 rounded bg-foreground" style={{ width: `${(m.opened / monthMax) * 50}%` }} title={`${m.opened} opened`} />
                  <div className="h-3 rounded bg-muted-foreground" style={{ width: `${(m.resolved / monthMax) * 50}%` }} title={`${m.resolved} resolved`} />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
