import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/form";
import * as api from "@/lib/api";
import type { OncallResponder } from "@/types";

/**
 * Engineering on-call roster editor. The order here IS the rotation order
 * (drives shift generation). Add a responder by Slack user id (+ optional phone
 * for Twilio), reorder with ↑/↓, toggle active, or remove. Changes regenerate
 * future shifts server-side.
 */
export function RosterEditor({
  responders,
  names,
  onChange,
}: {
  responders: OncallResponder[];
  names?: Record<string, string>;
  onChange: () => void;
}) {
  const [newId, setNewId] = useState("");
  const [newPhone, setNewPhone] = useState("");
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

  function move(idx: number, dir: -1 | 1) {
    const ids = responders.map((r) => r.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    run(() => api.reorderResponders(ids));
  }

  const nameOf = (r: OncallResponder) => names?.[r.id] ?? r.name ?? r.id;

  return (
    <div className="mb-3">
      <h3 className="mb-1 text-xs text-muted-foreground">Roster &amp; rotation order</h3>
      <Card>
        <CardContent className="p-0">
          {responders.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No responders yet. Add one below to start the rotation.
            </p>
          ) : (
            responders.map((r, i) => (
              <div key={r.id}>
                {i > 0 && <Separator />}
                <div className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{nameOf(r)}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {r.phone ? r.phone : "Slack-only"}
                      {r.active ? "" : " · inactive"}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="mr-1 text-xs text-muted-foreground">#{i + 1}</span>
                    <Button variant="ghost" size="sm" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</Button>
                    <Button variant="ghost" size="sm" disabled={busy || i === responders.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => api.updateResponder(r.id, { active: !r.active }))}>
                      {r.active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => api.removeResponder(r.id))}>Remove</Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          Slack user ID
          <Input className="mt-0.5 w-40" placeholder="U0123ABC456" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
        </label>
        <label className="text-xs text-muted-foreground">
          Phone (optional, E.164)
          <Input className="mt-0.5 w-40" placeholder="+61…" value={newPhone} onChange={(e) => setNewPhone(e.target.value.trim())} />
        </label>
        <Button
          size="sm"
          disabled={busy || !newId}
          onClick={() =>
            run(async () => {
              await api.addResponder(newId, newPhone || undefined);
              setNewId("");
              setNewPhone("");
            })
          }
        >
          Add responder
        </Button>
        {responders.length === 1 && <Badge variant="outline">min 1 — can’t remove the last</Badge>}
      </div>
      {err && <p className="mt-1 text-xs text-muted-foreground">Error: {err}</p>}
      <p className="mt-1 text-xs text-muted-foreground">
        Order = rotation order (weekly changeover). Name is pulled from Slack. Support is always-on — no rotation.
      </p>
    </div>
  );
}
