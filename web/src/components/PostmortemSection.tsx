import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/form";
import { Separator } from "@/components/ui/separator";
import * as api from "@/lib/api";
import type { Postmortem } from "@/lib/api";
import type { IncidentUpdate } from "@/types";
import { fmt } from "@/components/incidentUi";
import { renderMentions } from "@/lib/utils";

// Fixed post-incident sections with static per-section guidance (single-tenant:
// hard-coded, NOT a section builder). The AI draft populates them; a human edits
// per section. Help text mirrors incident.io's inline prompts.
const FIELDS: { key: keyof api.PostmortemEdit; label: string; help: string }[] = [
  { key: "summary", label: "Summary", help: "What happened, in a few sentences a stakeholder can read. The timeline below is the detailed record." },
  { key: "impact", label: "Impact", help: "Who and what was affected — customers, systems, duration, scope." },
  { key: "root_cause", label: "Root cause", help: "The underlying cause. What actually broke, and why it broke now." },
  { key: "contributing_factors", label: "Contributing factors & learnings", help: "What made it worse or harder to resolve, and what we take away — including residual risk." },
];

export function PostmortemSection({
  incidentId,
  timeline,
}: {
  incidentId: string;
  /** Incident updates, embedded read-only beneath the Summary section. */
  timeline?: IncidentUpdate[];
}) {
  const [pm, setPm] = useState<Postmortem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<api.PostmortemEdit | null>(null);

  useEffect(() => {
    api
      .getPostmortem(incidentId)
      .then(setPm)
      .catch((e) => setErr(String((e as Error).message)))
      .finally(() => setLoaded(true));
  }, [incidentId]);

  function beginEdit(from: Postmortem) {
    setEdit({
      summary: from.summary,
      impact: from.impact,
      root_cause: from.root_cause,
      contributing_factors: from.contributing_factors,
      action_items: from.action_items.map((a) => a.description),
    });
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading post-mortem…</p>;

  if (!pm) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">No post-mortem yet.</p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => run(async () => setPm(await api.generatePostmortem(incidentId)))}
        >
          {busy ? "Generating…" : "Generate draft"}
        </Button>
        {err && <p className="text-sm text-muted-foreground">Error: {err}</p>}
      </div>
    );
  }

  const published = pm.status === "published";
  const editing = edit !== null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Post-mortem
        </h4>
        <Badge variant={published ? "default" : "outline"}>
          {published ? "Published" : "Draft"}
        </Badge>
      </div>

      {FIELDS.map((f) => (
        <div key={f.key} className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">{f.label}</div>
          <p className="text-[11px] leading-snug text-muted-foreground/80">{f.help}</p>
          {editing ? (
            <Textarea
              value={edit![f.key] as string}
              onChange={(e) => setEdit({ ...edit!, [f.key]: e.target.value })}
            />
          ) : (
            <p className="text-sm whitespace-pre-wrap">{(pm[f.key] as string) || "—"}</p>
          )}
          {f.key === "summary" && timeline && timeline.length > 0 ? (
            <details className="mt-1 rounded-md bg-muted/40 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Incident timeline ({timeline.length})
              </summary>
              <ol className="mt-2 space-y-1.5">
                {timeline.map((u) => (
                  <li key={u.id} className="text-xs">
                    <time className="text-muted-foreground">{fmt(u.created_at)}</time>{" "}
                    <span className="text-muted-foreground">· {u.status}</span>
                    <div className="text-foreground">{renderMentions(u.body)}</div>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </div>
      ))}

      <Separator />

      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">Action items</div>
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          Concrete follow-ups to prevent recurrence or reduce impact. Each can be exported to Jira.
        </p>
        {editing ? (
          <ActionItemEditor
            items={edit!.action_items}
            onChange={(items) => setEdit({ ...edit!, action_items: items })}
          />
        ) : pm.action_items.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-1">
            {pm.action_items.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={a.done}
                  disabled={busy}
                  onChange={(e) =>
                    run(async () => {
                      await api.toggleActionItem(a.id, e.target.checked);
                      setPm(await api.getPostmortem(incidentId));
                    })
                  }
                />
                <span className={a.done ? "line-through text-muted-foreground" : ""}>
                  {a.description}
                </span>
                {a.jira_key && (
                  <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {a.jira_key}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {err && <p className="text-sm text-muted-foreground">Error: {err}</p>}

      {!published && (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const saved = await api.savePostmortem(incidentId, edit!);
                    setPm(saved);
                    setEdit(null);
                  })
                }
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEdit(null)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => beginEdit(pm)}>
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(async () => setPm(await api.generatePostmortem(incidentId)))}
              >
                {busy ? "Regenerating…" : "Regenerate"}
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.publishPostmortem(incidentId);
                    setPm(await api.getPostmortem(incidentId));
                  })
                }
              >
                Publish
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActionItemEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex gap-2">
          <Input
            value={it}
            onChange={(e) => {
              const next = [...items];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...items, ""])}>
        Add action item
      </Button>
    </div>
  );
}
