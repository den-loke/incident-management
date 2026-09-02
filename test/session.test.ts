import { describe, expect, it } from "vitest";
import {
  clearCookieHeader,
  makeSession,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
} from "../src/auth/session";

const SECRET = "test-signing-secret";

describe("session cookies", () => {
  it("signs and verifies a session round-trip", async () => {
    const session = makeSession({ user_id: "U1", team_id: "T1", name: "Ada" });
    const token = await signSession(session, SECRET);
    const parsed = await verifySession(token, SECRET);
    expect(parsed).toMatchObject({ user_id: "U1", team_id: "T1", name: "Ada" });
  });

  it("rejects a tampered payload", async () => {
    const token = await signSession(
      makeSession({ user_id: "U1", team_id: "T1", name: "Ada" }),
      SECRET,
    );
    // Flip the payload but keep the old signature.
    const forged = await signSession(
      makeSession({ user_id: "U_EVIL", team_id: "T1", name: "x" }),
      SECRET,
    );
    const spliced = `${forged.split(".")[0]}.${token.split(".")[1]}`;
    expect(await verifySession(spliced, SECRET)).toBeNull();
  });

  it("rejects a wrong secret", async () => {
    const token = await signSession(
      makeSession({ user_id: "U1", team_id: "T1", name: "Ada" }),
      SECRET,
    );
    expect(await verifySession(token, "other-secret")).toBeNull();
  });

  it("rejects an expired session", async () => {
    const now = 1_000_000;
    const session = makeSession({ user_id: "U1", team_id: "T1", name: "Ada" }, 60, now);
    const token = await signSession(session, SECRET);
    // now + 61s => past exp (now + 60)
    expect(await verifySession(token, SECRET, now + 61)).toBeNull();
    expect(await verifySession(token, SECRET, now + 59)).not.toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySession("", SECRET)).toBeNull();
    expect(await verifySession("nodot", SECRET)).toBeNull();
    expect(await verifySession(".sigonly", SECRET)).toBeNull();
  });

  it("builds and reads cookie headers", () => {
    const header = sessionCookieHeader("abc.def");
    expect(header).toContain("incident_session=abc.def");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");

    expect(clearCookieHeader()).toContain("Max-Age=0");

    expect(readCookie("incident_session=abc.def; other=1", "incident_session")).toBe(
      "abc.def",
    );
    expect(readCookie("other=1", "incident_session")).toBeNull();
    expect(readCookie(null, "incident_session")).toBeNull();
  });
});
