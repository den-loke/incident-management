import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/form";
import * as api from "@/lib/api";
import type { MaintenanceWindow } from "@/types";
import { MAINTENANCE_LABEL } from "@/types";

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

function ScheduleDialog({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [components, setComponents] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = title.trim() && startsAt && endsAt && new Date(endsAt) > new Date(startsAt);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.scheduleMaintenance({
        title: title.trim(),
        body: body.trim() || undefined,
        components: components.split(",").map((s) => s.trim()).filter(Boolean),
        starts_at: new Date(startsAt).toISOString(),
        ends_at: new Date(endsAt).toISOString(),
      });
      setOpen(false);
      setTitle("");
      setBody("");
      setStartsAt("");
      setEndsAt("");
      setComponents("");
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Schedule maintenance
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Schedule maintenance">
        {err && <p className="mb-3 text-sm text-muted-foreground">Error: {err}</p>}
        <div className="space-y-3">
          <Input autoFocus placeholder="Title (e.g. DB upgrade)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Textarea placeholder="Details (optional)" value={body} onChange={(e) => setBody(e.target.value)} />
          <Input placeholder="Affected component ids (comma-separated, optional)" value={components} onChange={(e) => setComponents(e.target.value)} />
          <label className="block text-xs text-muted-foreground">
            Starts
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </label>
          <label className="block text-xs text-muted-foreground">
            Ends
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={busy || !valid}>{busy ? "Scheduling…" : "Schedule"}</Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function MaintenanceSection({
  windows,
  onChange,
}: {
  windows: MaintenanceWindow[];
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const visible = windows.filter((w) => w.status === "scheduled" || w.status === "active");

  async function cancel(id: string) {
    setBusyId(id);
    try {
      await api.cancelMaintenance(id);
      onChange();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Scheduled maintenance</h2>
        <ScheduleDialog onDone={onChange} />
      </div>
      <Card>
        <CardContent className="p-0">
          {visible.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">No maintenance scheduled.</p>
          ) : (
            visible.map((w, i) => (
              <div key={w.id}>
                {i > 0 && <Separator />}
                <div className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{w.title}</span>
                      <Badge variant={w.status === "active" ? "default" : "outline"}>{MAINTENANCE_LABEL[w.status]}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{fmt(w.starts_at)} → {fmt(w.ends_at)}</p>
                    {w.body ? <p className="mt-1 text-sm">{w.body}</p> : null}
                  </div>
                  <Button variant="ghost" size="sm" disabled={busyId === w.id} onClick={() => cancel(w.id)}>
                    {busyId === w.id ? "…" : "Cancel"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}
