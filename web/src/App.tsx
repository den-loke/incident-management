import { useEffect, useState } from "react";
import { fetchStatus, UnauthorizedError } from "@/lib/api";
import { LoginScreen } from "@/components/LoginScreen";
import { StatusPage } from "@/components/StatusPage";
import type { StatusResponse } from "@/types";

type State =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: StatusResponse };

export default function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
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

  if (state.kind === "loading") {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
        Loading…
      </div>
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
  return <StatusPage data={state.data} />;
}
