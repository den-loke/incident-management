import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/form";
import { buttonVariants } from "@/components/ui/button";
import * as api from "@/lib/api";
import type { Report } from "@/lib/api";

const PERIODS: { value: string; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

function humanizeSeconds(s: number | null): string {
  if (s === null) return "—";
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

export function ReportPanel() {
  const [period, setPeriod] = useState("30d");
  const [report, setReport] = useState<Report | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api
      .getReport(period)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setErr(String((e as Error).message)));
    return () => {
      cancelled = true;
    };
  }, [period]);

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Reporting
        </h2>
        <div className="flex items-center gap-2">
          <Select
            className="h-8 w-auto"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={api.reportCsvUrl(period)}
          >
            Export CSV
          </a>
        </div>
      </div>

      {err && <p className="text-sm text-muted-foreground">Error: {err}</p>}
      {!report && !err ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : report ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Metric label="Opened" value={report.opened} />
          <Metric label="Resolved" value={report.resolved} />
          <Metric label="Open now" value={report.open_now} />
          <Metric label="MTTR" value={humanizeSeconds(report.mttr_seconds)} />
          <Metric label="MTTA (proxy)" value={humanizeSeconds(report.mtta_seconds)} />
          <Metric label="Action-item backlog" value={report.open_action_items} />
        </div>
      ) : null}
    </section>
  );
}
