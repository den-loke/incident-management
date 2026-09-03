import { useCallback, useEffect, useState } from "react";
import { fetchStatus, UnauthorizedError } from "@/lib/api";
import { LoginScreen } from "@/components/LoginScreen";
import { AppShell } from "@/components/AppShell";
import { useRoute, matchRoute } from "@/lib/router";
import { StatusPageView } from "@/pages/StatusPageView";
import { IncidentsListPage } from "@/pages/IncidentsListPage";
import { IncidentDetailPage } from "@/pages/IncidentDetailPage";
import {
  OnCallPage,
  FollowUpsPage,
  InsightsPage,
  TeamsPage,
  MaintenancePage,
} from "@/pages/sectionPages";
import type { StatusResponse } from "@/types";

type State =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: StatusResponse };

function Routed({ data, onChange }: { data: StatusResponse; onChange: () => void }) {
  const path = useRoute();

  const detail = matchRoute(path, "/incidents/:id");
  if (detail) return <IncidentDetailPage id={detail.id} data={data} onChange={onChange} />;

  switch (path) {
    case "/incidents":
      return <IncidentsListPage data={data} />;
    case "/on-call":
      return <OnCallPage />;
    case "/maintenance":
      return <MaintenancePage data={data} onChange={onChange} />;
    case "/follow-ups":
      return <FollowUpsPage />;
    case "/insights":
      return <InsightsPage />;
    case "/teams":
      return <TeamsPage />;
    case "/":
      return <StatusPageView data={data} />;
    default:
      return <StatusPageView data={data} />;
  }
}

export default function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(() => {
    let cancelled = false;
    fetchStatus()
      .then((data) => !cancelled && setState({ kind: "ready", data }))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) setState({ kind: "login" });
        else setState({ kind: "error", message: String(err?.message ?? err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  if (state.kind === "loading") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>
    );
  }
  if (state.kind === "login") return <LoginScreen />;
  if (state.kind === "error") {
    return (
      <div className="grid min-h-screen place-items-center px-4 text-center text-sm text-muted-foreground">
        <div>
          <p className="mb-2 font-medium text-foreground">Couldn’t load status</p>
          <p>{state.message}</p>
        </div>
      </div>
    );
  }
  return (
    <AppShell viewer={state.data.viewer} onDeclare={load}>
      <Routed data={state.data} onChange={load} />
    </AppShell>
  );
}
