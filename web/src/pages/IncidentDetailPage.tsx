import {
  fmt,
  deriveDurations,
  gapLabel,
} from "@/components/incidentUi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { IncidentBadge } from "@/components/StatusBadge";
import { IncidentActions } from "@/components/IncidentActions";
import { PostmortemSection } from "@/components/PostmortemSection";
import { PostIncidentFlowSection } from "@/components/PostIncidentFlowSection";
import { Link } from "@/lib/router";
import { uname, renderMentions } from "@/lib/utils";
import type { ReactNode } from "react";
import {
  ROLE_LABEL,
  SEVERITY_LABEL,
  ROUTING_PATH_LABEL,
  type Incident,
  type IncidentRole,
  type StatusResponse,
} from "@/types";

const ROLE_ORDER: IncidentRole[] = ["engineering_lead", "customer_support_lead"];

/** A labelled value row in the Properties rail. */
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}

/** Round initials chip standing in for an avatar (no image source available). */
function Initials({ name }: { name: string }) {
  const initials = name
    .replace(/^@/, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">
      {initials || "?"}
    </span>
  );
}

function PropertiesRail({
  incident,
  names,
}: {
  incident: Incident;
  names?: Record<string, string>;
}) {
  const d = deriveDurations(incident);
  const byRole = new Map(incident.roles.map((r) => [r.role, r.slack_user_id]));
  const slackUrl = incident.channel
    ? `https://slack.com/app_redirect?channel=${incident.channel}`
    : null;

  return (
    <Card className="lg:sticky lg:top-4 h-fit">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Properties</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Timestamps & durations */}
        <div>
          <Prop label="Declared">{fmt(incident.created_at)}</Prop>
          {incident.identified_at ? (
            <Prop label="Identified">{fmt(incident.identified_at)}</Prop>
          ) : null}
          {incident.resolved_at ? (
            <Prop label="Resolved">{fmt(incident.resolved_at)}</Prop>
          ) : null}
          {incident.last_updated_at ? (
            <Prop label="Last updated">{fmt(incident.last_updated_at)}</Prop>
          ) : null}
        </div>
        <Separator />
        <div>
          <Prop label={incident.resolved_at ? "Incident duration" : "Open for"}>
            {d.total}
          </Prop>
          <Prop label="Time to identify">{d.timeToIdentify ?? "—"}</Prop>
          <Prop label="Time to resolve">{d.timeToResolve ?? "—"}</Prop>
        </div>
        <Separator />
        {/* Roles */}
        <div className="space-y-1">
          {ROLE_ORDER.map((role) => {
            const uid = byRole.get(role);
            return (
              <div key={role} className="flex items-center justify-between gap-4 py-1 text-sm">
                <span className="text-muted-foreground">{ROLE_LABEL[role]}</span>
                {uid ? (
                  <span className="flex items-center gap-1.5 font-medium">
                    <Initials name={uname(uid, names)} />
                    {uname(uid, names)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">unassigned</span>
                )}
              </div>
            );
          })}
        </div>
        {/* Links */}
        {slackUrl ? (
          <>
            <Separator />
            <div className="space-y-1 text-sm">
              <a
                href={slackUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:no-underline"
              >
                Slack channel ↗
              </a>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ActivityTimeline({
  incident,
  names,
}: {
  incident: Incident;
  names?: Record<string, string>;
}) {
  // Newest-first, as the API returns them.
  const updates = incident.updates;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {updates.length === 0 ? (
          <p className="text-sm text-muted-foreground">No updates yet.</p>
        ) : (
          <ol className="space-y-4">
            {updates.map((u, i) => {
              // updates[i-1] is NEWER (list is newest-first); a large gap between
              // this update and the newer one gets a "N later…" marker above the
              // newer one — so render the marker before the newer sibling.
              const newer = updates[i - 1];
              const gap = newer ? gapLabel(newer.created_at, u.created_at) : null;
              return (
                <li key={u.id} className="space-y-1">
                  {gap ? (
                    <p className="pb-1 text-xs italic text-muted-foreground">
                      ⏱ {gap}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <IncidentBadge status={u.status} />
                    <time className="text-xs text-muted-foreground">
                      {fmt(u.created_at)}
                    </time>
                  </div>
                  <p className="text-sm">{renderMentions(u.body, names)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

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
      {!incident ? (
        <p className="text-sm text-muted-foreground">
          Incident not found. It may have been removed, or the link is stale.
        </p>
      ) : (
        <>
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h1 className="text-xl font-semibold">{incident.name}</h1>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{SEVERITY_LABEL[incident.severity]}</Badge>
              <Badge variant="outline">{ROUTING_PATH_LABEL[incident.routing_path]}</Badge>
              <IncidentBadge status={incident.status} />
            </div>
          </div>

          {/* Two-column: timeline (main) + properties rail (side). */}
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="space-y-4">
              <ActivityTimeline incident={incident} names={data.user_names} />
              {incident.status !== "resolved" ? (
                <Card>
                  <CardContent className="pt-6">
                    <IncidentActions
                      incidentId={incident.id}
                      severity={incident.severity}
                      pending={
                        incident.pending_resolution
                          ? {
                              requested_by: incident.pending_resolution.requested_by,
                              note: incident.pending_resolution.note,
                            }
                          : null
                      }
                      onDone={onChange}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="pt-6">
                    <PostIncidentFlowSection incidentId={incident.id} />
                    <PostmortemSection incidentId={incident.id} />
                  </CardContent>
                </Card>
              )}
            </div>
            <PropertiesRail incident={incident} names={data.user_names} />
          </div>
        </>
      )}
    </div>
  );
}
