import { buttonVariants } from "@/components/ui/button";
import { DeclareIncidentButton } from "@/components/IncidentActions";
import { Link, useRoute } from "@/lib/router";
import { cn } from "@/lib/utils";
import type { Viewer } from "@/types";

export interface NavItem {
  path: string;
  label: string;
}

// Simpler than incident.io: seven pages, no settings (our config is hard-coded).
export const NAV: NavItem[] = [
  { path: "/", label: "Status" },
  { path: "/incidents", label: "Incidents" },
  { path: "/on-call", label: "On-call" },
  { path: "/maintenance", label: "Maintenance" },
  { path: "/follow-ups", label: "Follow-ups" },
  { path: "/insights", label: "Insights" },
  { path: "/teams", label: "Teams" },
];

/** True when `nav` should be highlighted for the current `path`. */
function isActive(path: string, nav: string): boolean {
  if (nav === "/") return path === "/";
  return path === nav || path.startsWith(`${nav}/`);
}

export function AppShell({
  viewer,
  onDeclare,
  children,
}: {
  viewer: Viewer;
  onDeclare: () => void;
  children: React.ReactNode;
}) {
  const path = useRoute();
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl gap-6 px-4 py-5 sm:px-6">
      {/* Left nav — sits on the app surface as its own panel; no side borders. */}
      <aside className="hidden w-56 shrink-0 flex-col sm:flex">
        <div className="mb-5 flex items-center gap-2 px-2">
          <span className="grid h-6 w-6 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            !
          </span>
          <span className="text-sm font-semibold tracking-tight">Incident Mgmt</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = isActive(path, item.path);
            return (
              <Link
                key={item.path}
                to={item.path}
                className={cn(
                  "relative rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-card font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                )}
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Content region */}
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 -mx-4 mb-6 flex items-center gap-3 bg-surface/80 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0">
          {/* Mobile nav: a compact select fallback under sm */}
          <MobileNav path={path} />
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <DeclareIncidentButton onDone={onDeclare} />
            <span className="hidden sm:inline">{viewer.name || viewer.user_id}</span>
            <a className={buttonVariants({ variant: "ghost", size: "sm" })} href="/auth/logout">
              Sign out
            </a>
          </div>
        </header>
        <main className="pb-16">{children}</main>
      </div>
    </div>
  );
}

function MobileNav({ path }: { path: string }) {
  return (
    <select
      className="h-8 rounded-md bg-transparent text-sm sm:hidden"
      value={NAV.find((n) => isActive(path, n.path))?.path ?? "/"}
      onChange={(e) => {
        window.location.hash = e.target.value;
      }}
    >
      {NAV.map((n) => (
        <option key={n.path} value={n.path}>
          {n.label}
        </option>
      ))}
    </select>
  );
}
