import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { addResponder, updateResponder, removeResponder, reorderResponders, listResponders } from "../src/oncall/roster";
import { __setDirectoryFetch } from "../src/slack/directory";
import type { Env } from "../src/env";

const E = env as unknown as Env;

async function clean() {
  await env.DB.prepare("DELETE FROM oncall_shifts WHERE responder LIKE 'UROSTER%'").run();
  await env.DB.prepare("DELETE FROM oncall_responders WHERE id LIKE 'UROSTER%'").run();
  __setDirectoryFetch(null);
}

describe("on-call roster management", () => {
  afterEach(clean);

  it("adds a responder, resolving the name from Slack when omitted", async () => {
    __setDirectoryFetch(async () => ({ UROSTER001: "Ada Lovelace" }));
    const r = await addResponder(E, { id: "UROSTER001", phone: "+61400000000" });
    expect(r.name).toBe("Ada Lovelace");
    expect(r.phone).toBe("+61400000000");
    expect(r.active).toBe(1);
  });

  it("rejects a non-user id", async () => {
    await expect(addResponder(E, { id: "not-a-user" })).rejects.toThrow("invalid_user_id");
  });

  it("reorder sets sort_order = rotation order", async () => {
    __setDirectoryFetch(async () => ({ UROSTER001: "A", UROSTER002: "B", UROSTER003: "C" }));
    await addResponder(E, { id: "UROSTER001", name: "A" });
    await addResponder(E, { id: "UROSTER002", name: "B" });
    await addResponder(E, { id: "UROSTER003", name: "C" });
    await reorderResponders(E, ["UROSTER003", "UROSTER001", "UROSTER002"]);
    const ours = (await listResponders(E)).filter((r) => r.id.startsWith("UROS"));
    expect(ours.map((r) => r.id)).toEqual(["UROSTER003", "UROSTER001", "UROSTER002"]);
  });

  it("deactivate flips active; remove drops a responder while another stays active", async () => {
    await addResponder(E, { id: "UROSTER001", name: "A" });
    await addResponder(E, { id: "UROSTER002", name: "B" });
    await addResponder(E, { id: "UROSTER003", name: "C" });
    await updateResponder(E, "UROSTER002", { active: false });
    const b = (await listResponders(E)).find((r) => r.id === "UROSTER002")!;
    expect(b.active).toBe(0);
    // 001 + 003 still active → removing 001 is allowed
    const res = await removeResponder(E, "UROSTER001");
    expect(res.removed).toBe(true);
  });

  it("refuses to remove the last ACTIVE responder (min one)", async () => {
    await addResponder(E, { id: "UROSTER001", name: "Solo" });
    const res = await removeResponder(E, "UROSTER001");
    expect(res).toEqual({ removed: false, reason: "min_one" });
    expect((await listResponders(E)).some((r) => r.id === "UROSTER001")).toBe(true);
  });
});
