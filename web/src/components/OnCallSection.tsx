import { useCallback, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/form";
import * as api from "@/lib/api";
import type { OncallSection, OncallOpenAlert, OncallEscalationPath, OncallEscalationEvent } from "@/types";
import { RosterEditor } from "@/components/RosterEditor";
import { uname } from "@/lib/utils";

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AlertStatusBadge({ status }: { status: OncallOpenAlert["status"] }) {
  const label = status === "firing" ? "Firing" : status === "ack" ? "Acked" : "Resolved";
  return <Badge variant={status === "firing" ? "default" : "outline"}>{label}</Badge>;
}

function AlertRow({ alert, onChange, names }: { alert: OncallOpenAlert; onChange: () => void; names?: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{alert.title}</span>
            {alert.severity ? <Badge variant="outline">{alert.severity.toUpperCase()}</Badge> : null}
            <AlertStatusBadge status={alert.status} />
          </div>
          <p className="text-xs text-muted-foreground">Received {fmt(alert.received_at)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {alert.status === "firing" && (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => api.ackAlert(alert.id))}>
              {busy ? "…" : "Ack"}
            </Button>
          )}
          {alert.incident_id ? (
            <span className="text-xs text-muted-foreground">Incident linked</span>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => run(() => api.promoteAlert(alert.id))}>
              Create incident
            </Button>
          )}
        </div>
      </div>
      {alert.trail.length > 0 && (
        <ol className="mt-2 space-y-0.5 pl-1 text-xs text-muted-foreground">
          {alert.trail.map((t, i) => (
            <li key={i}>
              L{t.level} · {t.channel} · {fmt(t.fired_at)}
              {t.acked_at ? ` · acked by ${t.acked_by ? uname(t.acked_by, names) : "someone"}` : " · unacked"}
            </li>
          ))}
        </ol>
      )}
      {err && <p className="mt-1 text-xs text-muted-foreground">Error: {err}</p>}
    </div>
  );
}

function OverrideDialog({
  section,
  onDone,
}: {
  section: OncallSection;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [responder, setResponder] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const first = section.responders[0]?.id ?? "";

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      // datetime-local yields local wall-clock without a zone; convert to ISO.
      await api.setOncallOverride(
        responder || first,
        new Date(startsAt).toISOString(),
        new Date(endsAt).toISOString(),
      );
      setOpen(false);
      setStartsAt("");
      setEndsAt("");
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  const valid = (responder || first) && startsAt && endsAt && new Date(endsAt) > new Date(startsAt);

  return (
    <>
      <Button variant="outline" size="sm" disabled={section.responders.length === 0} onClick={() => setOpen(true)}>
        Override
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title="On-call override">
        {err && <p className="mb-3 text-sm text-muted-foreground">Error: {err}</p>}
        <div className="space-y-3">
          <Select value={responder || first} onChange={(e) => setResponder(e.target.value)}>
            {section.responders.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} {r.active ? "" : "(inactive)"}
              </option>
            ))}
          </Select>
          <label className="block text-xs text-muted-foreground">
            Starts
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Ends
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy || !valid}>
              {busy ? "Saving…" : "Set override"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function EscalationPathDiagram({ path }: { path: OncallEscalationPath }) {
  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs text-muted-foreground">
        Escalation path <span className="opacity-70">(fixed · read-only)</span>
      </h3>
      <Card>
        <CardContent className="p-0">
          {path.steps.map((s, i) => (
            <div key={s.level}>
              {i > 0 && <Separator />}
              <div className="px-4 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.title}</span>
                  {s.wait_minutes && s.wait_minutes > 0 ? (
                    <Badge variant="outline">wait {s.wait_minutes}m</Badge>
                  ) : s.wait_minutes === null ? (
                    <Badge variant="outline">terminal</Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>
                {i < path.steps.length - 1 && <div className="mt-1 text-xs text-muted-foreground">↓</div>}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
      <p className="mt-1 text-xs text-muted-foreground">
        Unacked levels escalate every {path.ack_timeout_minutes} minutes. Any responder can ack to stop the ladder.
      </p>
    </div>
  );
}

function EscalationsLog({ events, names }: { events: OncallEscalationEvent[]; names?: Record<string, string> }) {
  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs text-muted-foreground">Escalations</h3>
      <Card>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No escalations yet.</p>
          ) : (
            events.map((e, i) => (
              <div key={e.id}>
                {i > 0 && <Separator />}
                <div className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="truncate">{e.alert_title}</span>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      L{e.level} · {e.channel} · {fmt(e.fired_at)}
                      {e.acked_at ? ` · acked by ${e.acked_by ? uname(e.acked_by, names) : "someone"}` : " · unacked"}
                      {e.incident_id ? " · incident linked" : ""}
                    </div>
                  </div>
                  <Badge variant={e.alert_status === "firing" ? "default" : "outline"}>
                    {e.alert_status === "firing" ? "Firing" : e.alert_status === "ack" ? "Acked" : "Resolved"}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function OnCallSection() {
  const [section, setSection] = useState<OncallSection | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .fetchOncall()
      .then(setSection)
      .catch((e) => setErr(String((e as Error).message)));
  }, []);

  useEffect(() => load(), [load]);

  if (err) {
    return (
      <section className="mb-8">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">On-call</h2>
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">Couldn’t load on-call: {err}</CardContent>
        </Card>
      </section>
    );
  }
  if (!section) return null;

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          On-call <span className="opacity-70">(Engineering roster)</span>
        </h2>
        <OverrideDialog section={section} onDone={load} />
      </div>

      <Card className="mb-3">
        <CardContent className="flex flex-wrap gap-x-8 gap-y-1 py-4 text-sm">
          <span>
            Now: <span className="font-medium">{section.now ? section.now.name : "nobody scheduled"}</span>
          </span>
          {section.next ? (
            <span className="text-muted-foreground">Next: {section.next.name}</span>
          ) : null}
          <span className="text-muted-foreground">Support is always-on — no rotation.</span>
        </CardContent>
      </Card>

      <RosterEditor responders={section.responders} names={section.user_names} onChange={load} />

      {section.upcoming.length > 0 && (
        <Card className="mb-3">
          <CardContent className="p-0">
            <div className="px-4 pt-3 text-xs text-muted-foreground">Rotation &amp; overrides</div>
            {section.upcoming.map((s, i) => (
              <div key={`${s.responder}-${s.starts_at}`}>
                {i > 0 && <Separator />}
                <div className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>
                    {s.responder_name ?? s.responder}
                    {s.is_override ? <Badge variant="outline" className="ml-2">override</Badge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {fmt(s.starts_at)} → {fmt(s.ends_at)}
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <h3 className="mb-1 text-xs text-muted-foreground">Open alerts</h3>
      <Card>
        <CardContent className="p-0">
          {section.open_alerts.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No open alerts.</p>
          ) : (
            section.open_alerts.map((a, i) => (
              <div key={a.id}>
                {i > 0 && <Separator />}
                <AlertRow alert={a} onChange={load} names={section.user_names} />
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="mt-3">
        <EscalationsLog events={section.escalation_events} names={section.user_names} />
        <EscalationPathDiagram path={section.path} />
      </div>
    </section>
  );
}
