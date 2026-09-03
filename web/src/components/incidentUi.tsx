import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { IncidentBadge } from "@/components/StatusBadge";
import { IncidentActions } from "@/components/IncidentActions";
import { PostmortemSection } from "@/components/PostmortemSection";
import { PostIncidentFlowSection } from "@/components/PostIncidentFlowSection";
import type { Component, Incident } from "@/types";
import { ROLE_LABEL, SEVERITY_LABEL, ROUTING_PATH_LABEL, type IncidentRole, type RoleAssignment } from "@/types";

const ROLE_ORDER: IncidentRole[] = ["engineering_lead", "customer_support_lead"];

export function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SEVERITY_RANK: Record<Component["status"], number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
};

export function overallLine(components: Component[], hasActive: boolean): string {
  if (hasActive) return "Active incident in progress";
  const worst = components.reduce<Component["status"]>(
    (acc, c) => (SEVERITY_RANK[c.status] > SEVERITY_RANK[acc] ? c.status : acc),
    "operational",
  );
  return worst === "operational" ? "All systems operational" : "Degraded service";
}

export function RolesLine({ roles }: { roles: RoleAssignment[] }) {
  const byRole = new Map(roles.map((r) => [r.role, r.slack_user_id]));
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {ROLE_ORDER.map((role) => (
        <span key={role}>
          {ROLE_LABEL[role]}:{" "}
          <span className="text-foreground">
            {byRole.has(role) ? `@${byRole.get(role)}` : "unassigned"}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Full incident card — header, roles, timeline, and (active) live actions or
 * (resolved) post-incident flow + post-mortem. Used on the incident detail page.
 * `compact` (list view) hides the timeline body and post-incident detail.
 */
export function IncidentCard({
  incident,
  onChange,
  compact = false,
}: {
  incident: Incident;
  onChange: () => void;
  compact?: boolean;
}) {
  const active = incident.status !== "resolved";
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
        <div className="space-y-1">
          <CardTitle className="text-base">{incident.name}</CardTitle>
          <p className="text-xs text-muted-foreground">
            Opened {fmt(incident.created_at)}
            {incident.resolved_at ? ` · Resolved ${fmt(incident.resolved_at)}` : ""}
          </p>
          {incident.channel ? (
            <a
              href={`https://slack.com/app_redirect?channel=${incident.channel}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs underline underline-offset-2 hover:no-underline"
            >
              Open in Slack ↗
            </a>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{SEVERITY_LABEL[incident.severity]}</Badge>
          <Badge variant="outline">{ROUTING_PATH_LABEL[incident.routing_path]}</Badge>
          <IncidentBadge status={incident.status} />
        </div>
      </CardHeader>
      {!compact && (
        <CardContent>
          <RolesLine roles={incident.roles} />
          {incident.updates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No updates yet.</p>
          ) : (
            <ol className="space-y-3 pl-1">
              {incident.updates.map((u) => (
                <li key={u.id} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <IncidentBadge status={u.status} />
                    <time className="text-xs text-muted-foreground">{fmt(u.created_at)}</time>
                  </div>
                  <p className="text-sm">{u.body}</p>
                </li>
              ))}
            </ol>
          )}
          {active && (
            <div className="mt-4">
              <IncidentActions
                incidentId={incident.id}
                severity={incident.severity}
                pending={
                  incident.pending_resolution
                    ? { requested_by: incident.pending_resolution.requested_by, note: incident.pending_resolution.note }
                    : null
                }
                onDone={onChange}
              />
            </div>
          )}
          {!active && (
            <>
              <div className="my-4">
                <Separator />
              </div>
              <PostIncidentFlowSection incidentId={incident.id} />
              <PostmortemSection incidentId={incident.id} />
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
