import type { StatusResponse } from "@/types";

export class UnauthorizedError extends Error {}

/** Fetch the status payload. Throws UnauthorizedError on 401 so the app can show login. */
export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (res.status === 401) throw new UnauthorizedError("not signed in");
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}
