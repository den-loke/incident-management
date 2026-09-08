import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import * as api from "@/lib/api";
import type { DecisionFlow } from "@/lib/api";

const SEV_VARIANT: Record<string, "default" | "outline"> = {
  sev1: "default",
  sev2: "outline",
  sev3: "outline",
};

/**
 * Read-only decision guide — LOKE's hard-coded criteria for severity, routing,
 * mid-incident escalation, and external comms. Explanatory reference (like the
 * escalation-path diagram); NOT a builder. Fetches GET /api/decision-flow.
 */
export function DecisionGuideSection() {
  const [flow, setFlow] = useState<DecisionFlow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.fetchDecisionFlow().then(setFlow).catch((e) => setErr(String((e as Error).message)));
  }, []);

  if (err) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          Couldn’t load the decision guide: {err}
        </CardContent>
      </Card>
    );
  }
  if (!flow) return <p className="text-sm text-muted-foreground">Loading decision guide…</p>;

  return (
    <div className="space-y-4">
      {/* Severity */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Picking a severity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {flow.severity.map((c, i) => (
            <div key={c.severity}>
              {i > 0 && <Separator className="mb-3" />}
              <div className="mb-1 flex items-center gap-2">
                <Badge variant={SEV_VARIANT[c.severity] ?? "outline"}>{c.label}</Badge>
                <span className="text-sm font-medium">{c.headline}</span>
              </div>
              <ul className="ml-1 list-disc pl-4 text-sm text-muted-foreground">
                {c.includes.map((x, j) => (
                  <li key={j}>{x}</li>
                ))}
              </ul>
              {c.excludes.length > 0 ? (
                <p className="mt-1 pl-1 text-xs text-muted-foreground">
                  Not: {c.excludes.join(" ")}
                </p>
              ) : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Routing */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Page on-call, or just communicate?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {flow.routing.map((r) => (
            <div key={r.path}>
              <div className="text-sm font-medium">{r.label}</div>
              <p className="text-sm text-muted-foreground">
                <span className="text-foreground">{r.headline}</span> {r.detail}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Escalation + comms */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Escalate a running incident when…</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="ml-1 list-disc pl-4 text-sm text-muted-foreground">
              {flow.escalation_triggers.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Publish externally (status page) when…</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="ml-1 list-disc pl-4 text-sm text-muted-foreground">
              {flow.external_comms_threshold.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
