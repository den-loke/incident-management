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
    <div className="mx-auto flex min-h-screen max-w-6xl">
      {/* Left nav — no side borders (stance) */}
      <aside className="hidden w-52 shrink-0 flex-col px-3 py-6 sm:flex">
        <div className="mb-6 px-2">
          <span className="text-sm font-semibold tracking-tight">Incident Mgmt</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                "rounded-md px-2 py-1.5 text-sm",
                isActive(path, item.path)
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      {/* Content region */}
      <div className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <header className="mb-6 flex items-center justify-between gap-3">
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
        {children}
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
