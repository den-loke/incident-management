// Tiny dependency-free hash router. Hash routing (#/path) needs no server-side
// deep-link fallback — the fragment never reaches the Worker, so the SPA is
// always served from "/" and the client picks the page. Deliberately minimal:
// no route params library, no context — just a hook over `location.hash`.

import { useEffect, useState } from "react";

/** Current path from the hash, e.g. "#/on-call" → "/on-call". Defaults to "/". */
function currentPath(): string {
  const h = window.location.hash.replace(/^#/, "");
  return h && h.startsWith("/") ? h : "/";
}

/** Navigate to an in-app path (updates the hash; the hook re-renders). */
export function navigate(path: string): void {
  const next = path.startsWith("/") ? path : `/${path}`;
  if (currentPath() !== next) window.location.hash = next;
}

/** Subscribe to the current route path. Re-renders on hashchange. */
export function useRoute(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onHash = () => setPath(currentPath());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return path;
}

/**
 * Match a route path against a pattern with `:param` segments.
 * Returns the extracted params, or null if no match.
 * e.g. matchRoute("/incidents/abc", "/incidents/:id") → { id: "abc" }
 */
export function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const pSeg = pattern.split("/").filter(Boolean);
  const aSeg = path.split("/").filter(Boolean);
  if (pSeg.length !== aSeg.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSeg.length; i++) {
    if (pSeg[i].startsWith(":")) params[pSeg[i].slice(1)] = decodeURIComponent(aSeg[i]);
    else if (pSeg[i] !== aSeg[i]) return null;
  }
  return params;
}

/** An in-app link that drives the hash router (plain <a href="#/…">). */
export function Link({
  to,
  className,
  children,
  onClick,
}: {
  to: string;
  className?: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <a
      href={`#${to.startsWith("/") ? to : `/${to}`}`}
      className={className}
      onClick={onClick}
    >
      {children}
    </a>
  );
}
