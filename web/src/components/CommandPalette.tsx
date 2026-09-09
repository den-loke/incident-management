// ⌘K / Ctrl+K command palette. A single fixed command set (single-tenant
// stance — no configurable palette) over plumbing we already have:
//   • Navigation — every left-nav page + dynamic "Go to INC-N" for open incidents.
//   • Quick actions — Declare (opens the shared declare modal directly); Post
//     update / Change severity / Resolve jump to the incident's detail page where
//     the shared IncidentActions live (those actions need a specific incident).
// Dependency-free: no cmdk library, matching the project's zero-dep hash router.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { navigate } from "@/lib/router";
import { NAV } from "@/components/AppShell";
import { SEVERITY_LABEL, INCIDENT_LABEL, type StatusResponse } from "@/types";

type CommandGroup = "Navigation" | "Incidents" | "Actions";

interface Command {
  id: string;
  group: CommandGroup;
  title: string;
  /** Extra words folded into the match haystack (aliases, incident names). */
  keywords?: string;
  hint?: string;
  run: () => void;
}

const OPEN_STATUSES = new Set(["investigating", "identified", "monitoring"]);

/** Short incident handle. Production ids are already "INC-42"; fall back to
 *  synthesizing "INC-<n>" from a trailing number, else the raw id. */
function incidentHandle(id: string): string {
  if (/^inc-\d+$/i.test(id)) return id.toUpperCase();
  const m = id.match(/(\d+)\s*$/);
  return m ? `INC-${m[1]}` : id;
}

function buildCommands(
  data: StatusResponse,
  onDeclare: () => void,
  close: () => void,
): Command[] {
  const cmds: Command[] = [];

  // 1) Navigation — straight from the nav registry.
  for (const item of NAV) {
    cmds.push({
      id: `nav:${item.path}`,
      group: "Navigation",
      title: `Go to ${item.label}`,
      keywords: item.path,
      run: () => {
        navigate(item.path);
        close();
      },
    });
  }

  // 2) Declare — opens the shared declare modal directly.
  cmds.push({
    id: "action:declare",
    group: "Actions",
    title: "Declare incident",
    keywords: "new create open raise",
    hint: "opens declare form",
    run: () => {
      close();
      onDeclare();
    },
  });

  // 3) Per-incident entries. Open incidents get action shortcuts (which jump to
  //    the detail page where IncidentActions lives); all incidents get "Go to".
  const openFirst = [...data.incidents].sort((a, b) => {
    const ao = OPEN_STATUSES.has(a.status) ? 0 : 1;
    const bo = OPEN_STATUSES.has(b.status) ? 0 : 1;
    return ao - bo || b.created_at.localeCompare(a.created_at);
  });

  for (const inc of openFirst) {
    const handle = incidentHandle(inc.id);
    const isOpen = OPEN_STATUSES.has(inc.status);
    const meta = `${SEVERITY_LABEL[inc.severity]} · ${INCIDENT_LABEL[inc.status]}`;
    const detailPath = `/incidents/${encodeURIComponent(inc.id)}`;

    cmds.push({
      id: `inc:${inc.id}`,
      group: "Incidents",
      title: `${handle} — ${inc.name}`,
      keywords: `${inc.id} ${inc.name} ${meta}`,
      hint: meta,
      run: () => {
        navigate(detailPath);
        close();
      },
    });

    if (isOpen) {
      for (const [verb, label] of [
        ["update", "Post update"],
        ["severity", "Change severity"],
        ["resolve", "Resolve"],
      ] as const) {
        cmds.push({
          id: `inc:${inc.id}:${verb}`,
          group: "Actions",
          title: `${label} on ${handle}`,
          keywords: `${inc.name} ${verb}`,
          hint: inc.name,
          run: () => {
            navigate(detailPath);
            close();
          },
        });
      }
    }
  }

  return cmds;
}

/** Case-insensitive subsequence match (fuzzy), like most command palettes. */
function matches(query: string, hay: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const h = hay.toLowerCase();
  let i = 0;
  for (let j = 0; j < h.length && i < q.length; j++) {
    if (h[j] === q[i]) i++;
  }
  return i === q.length;
}

export function CommandPalette({
  open,
  onClose,
  data,
  onDeclare,
}: {
  open: boolean;
  onClose: () => void;
  data: StatusResponse;
  onDeclare: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const commands = useMemo(
    () => buildCommands(data, onDeclare, onClose),
    [data, onDeclare, onClose],
  );

  const filtered = useMemo(() => {
    const q = query.trim();
    return commands.filter((c) => matches(q, `${c.title} ${c.keywords ?? ""}`));
  }, [commands, query]);

  // Reset transient state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Clamp the active index whenever the result set shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Keep the active row scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (filtered.length ? (a + 1) % filtered.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (filtered.length ? (a - 1 + filtered.length) % filtered.length : 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        filtered[active]?.run();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, active, onClose],
  );

  if (!open) return null;

  // Render in grouped order while keeping a single flat index for navigation.
  const order: CommandGroup[] = ["Actions", "Incidents", "Navigation"];
  let flat = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl bg-surface shadow-2xl ring-1 ring-black/10"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search pages, incidents, actions…"
          className="w-full bg-transparent px-4 py-3.5 text-sm outline-none placeholder:text-muted-foreground"
          aria-label="Command palette search"
        />
        <div className="h-px bg-border" />
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No results</p>
          )}
          {order.map((group) => {
            const rows = filtered.filter((c) => c.group === group);
            if (rows.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <p className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group}
                </p>
                {rows.map((c) => {
                  flat++;
                  const idx = flat;
                  const isActive = idx === active;
                  return (
                    <button
                      key={c.id}
                      data-idx={idx}
                      type="button"
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => c.run()}
                      className={[
                        "flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm",
                        isActive ? "bg-accent text-accent-foreground" : "text-foreground",
                      ].join(" ")}
                    >
                      <span className="truncate">{c.title}</span>
                      {c.hint && (
                        <span className="shrink-0 text-xs text-muted-foreground">{c.hint}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span><kbd className="font-sans">↑↓</kbd> navigate</span>
          <span><kbd className="font-sans">↵</kbd> select</span>
          <span><kbd className="font-sans">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

/** Global ⌘K / Ctrl+K listener. Returns [open, setOpen]. */
export function useCommandPalette(): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [open, setOpen];
}
