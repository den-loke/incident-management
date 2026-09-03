import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/form";
import * as api from "@/lib/api";
import { INCIDENT_LABEL, type IncidentStatus } from "@/types";

const OPEN_STATUSES: IncidentStatus[] = ["investigating", "identified", "monitoring"];

function ErrorLine({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <p className="mb-3 text-sm text-muted-foreground">Error: {msg}</p>;
}

export function DeclareIncidentButton({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("sev2");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      await api.declareIncident(name.trim(), body.trim() || undefined, severity);
      setOpen(false);
      setName("");
      setBody("");
      setSeverity("sev2");
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Declare incident
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title="Declare incident">
        <ErrorLine msg={err} />
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="Incident name (e.g. Checkout returning 500s)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="sev1">SEV1 · Major</option>
            <option value="sev2">SEV2 · Partial</option>
            <option value="sev3">SEV3 · Minor</option>
          </Select>
          <Textarea
            placeholder="First update (optional)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy || !name.trim()}>
              {busy ? "Declaring…" : "Declare"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

export function IncidentActions({
  incidentId,
  severity,
  pending,
  onDone,
}: {
  incidentId: string;
  severity: string;
  pending: { requested_by: string; note: string | null } | null;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<null | "update" | "resolve">(null);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<IncidentStatus>("monitoring");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function changeSeverity(next: string) {
    setBusy(true);
    setErr(null);
    try {
      await api.setSeverity(incidentId, next);
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setMode(null);
    setBody("");
    setErr(null);
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "update") await api.postUpdate(incidentId, body.trim(), status);
      else await api.requestResolve(incidentId, body.trim() || undefined);
      close();
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setErr(null);
    try {
      await api.confirmResolve(incidentId);
      onDone();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="h-8 w-auto"
          value={severity}
          disabled={busy}
          onChange={(e) => changeSeverity(e.target.value)}
        >
          <option value="sev1">SEV1 · Major</option>
          <option value="sev2">SEV2 · Partial</option>
          <option value="sev3">SEV3 · Minor</option>
        </Select>
        <Button variant="outline" size="sm" onClick={() => setMode("update")}>
          Post update
        </Button>
        {pending ? (
          <>
            <span className="text-xs text-muted-foreground">
              Resolve requested by @{pending.requested_by} — a different person confirms.
            </span>
            <Button size="sm" onClick={confirm} disabled={busy}>
              {busy ? "Confirming…" : "Confirm resolve"}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setMode("resolve")}>
            Request resolve
          </Button>
        )}
      </div>
      {err && <p className="mt-2 text-sm text-muted-foreground">Error: {err}</p>}

      <Dialog
        open={mode === "update"}
        onClose={close}
        title="Post update"
      >
        <ErrorLine msg={err} />
        <div className="space-y-3">
          <Select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)}>
            {OPEN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_LABEL[s]}
              </option>
            ))}
          </Select>
          <Textarea
            autoFocus
            placeholder="Update details"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy || !body.trim()}>
              {busy ? "Posting…" : "Post update"}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={mode === "resolve"} onClose={close} title="Request resolve">
        <ErrorLine msg={err} />
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            This requests resolution. A different person confirms to actually resolve.
          </p>
          <Textarea
            autoFocus
            placeholder="Resolution note (optional)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={busy}>
              {busy ? "Requesting…" : "Request resolve"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
