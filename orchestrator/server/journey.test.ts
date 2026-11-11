import { describe, expect, it } from "vitest";
import type { AccountError } from "./accounts.js";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { recordEvent } from "./events.js";
import { journey } from "./journey.js";
import { openSqliteStore } from "./store.js";

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9));

async function organization() {
  const store = openSqliteStore(":memory:");
  const ctx = { store, tenant: "acme" };
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code-for-tests", { code: "code-for-tests", email: "ada@example.invalid", name: "Ada", password: "correct horse battery" }));
  const pat = await principalOf(store, await createUser(store, "acme", new Set(["Payments"]), { email: "pat@example.invalid", name: "Pat", role: "member" }, owner));
  const max = await principalOf(store, await createUser(store, "acme", new Set(["Payments"]), { email: "max@example.invalid", name: "Max", role: "member" }, owner));
  return { store, ctx, owner, pat, max };
}

describe("who is where", () => {
  it("given an organization that connected GitHub, invited people, and whose teammate opened and merged a request, when its owner reads who is where, then each step names who took it first and when, and each person stands at the furthest thing they did", async () => {
    // given
    const { store, ctx, owner, pat, max } = await organization();
    await recordEvent(ctx, owner, "org.created", { detail: "acme" }, at(1));
    await recordEvent(ctx, owner, "forge.connected", { subject: "forge:github", detail: "connected GitHub" }, at(2));
    await recordEvent(ctx, owner, "forge.connected", { subject: "forge:gitlab", detail: "connected GitLab" }, at(5));
    await recordEvent(ctx, owner, "invite.sent", { detail: "pat" }, at(2));
    await recordEvent(ctx, pat, "account.joined", { detail: "joined" }, at(3));
    await recordEvent(ctx, pat, "request.opened", { detail: "#1" }, at(4));
    await recordEvent(ctx, owner, "request.merged", { detail: "#1" }, at(4));
    await recordEvent(ctx, max, "account.signin", { detail: "signed in" }, at(3));
    await recordEvent(ctx, max, "account.signin", { detail: "signed in" }, at(6));
    await store.saveInvite({ tenant: "acme", id: "inv_1", email: "lee@example.invalid", role: "member", teams: [], tokenHash: "h1", invitedBy: "ada@example.invalid", createdAt: at(2).toISOString(), expiresAt: at(9).toISOString() });
    await store.saveInvite({ tenant: "acme", id: "inv_2", email: "old@example.invalid", role: "member", teams: [], tokenHash: "h2", invitedBy: "ada@example.invalid", createdAt: at(1).toISOString(), expiresAt: at(3).toISOString() });

    // when
    const read = await journey(ctx, owner, at(7));

    // then
    expect(read.milestones).toEqual([
      { id: "org", done: true, at: at(1).toISOString(), by: "Ada" },
      { id: "forge", done: true, at: at(2).toISOString(), by: "Ada" },
      { id: "repo", done: false, at: null, by: null },
      { id: "invited", done: true, at: at(2).toISOString(), by: "Ada" },
      { id: "joined", done: true, at: at(3).toISOString(), by: "Pat" },
      { id: "tracker", done: false, at: null, by: null },
      { id: "task", done: false, at: null, by: null },
      { id: "request", done: true, at: at(4).toISOString(), by: "Pat" },
      { id: "merged", done: true, at: at(4).toISOString(), by: "Ada" },
    ]);
    expect(read.people.map((p) => [p.name, p.stage, p.lastSeen])).toEqual([
      ["Ada", "merged a request", null],
      ["Max", "joined", at(6).toISOString()],
      ["Pat", "opened a request", null],
    ]);
    const patRow = read.people.find((p) => p.name === "Pat")!;
    expect([patRow.joinedAt, patRow.firstTaskAt, patRow.firstRequestAt]).toEqual([at(3).toISOString(), null, at(4).toISOString()]);
    expect(Object.keys(patRow).sort()).toEqual(["email", "firstRequestAt", "firstTaskAt", "id", "joinedAt", "lastSeen", "name", "role", "since", "stage"]);
    expect(read.invited).toEqual([{ email: "lee@example.invalid", at: at(2).toISOString(), expiresAt: at(9).toISOString() }]);
  });

  it("given an organization whose repository the configuration lists and whose teammates were added by hand, when who is where is read, then both steps are done with no time, since the log never saw them", async () => {
    // given
    const { store, ctx, owner } = await organization();
    await store.upsertRepo({ tenant: "acme", id: "payments-skills", team: "Payments", name: "payments-skills", url: "https://git.example.invalid/acme/payments-skills.git" });

    // when
    const read = await journey(ctx, owner, at(7));

    // then
    expect(read.milestones.filter((m) => m.id === "repo" || m.id === "joined")).toEqual([
      { id: "repo", done: true, at: null, by: null },
      { id: "joined", done: true, at: null, by: null },
    ]);
    expect(read.milestones.find((m) => m.id === "task")?.done).toBe(false);
  });

  it("given a member and a key, when each reads who is where, then both are refused", async () => {
    // given
    const { ctx, owner, pat } = await organization();

    // when
    const tries = [journey(ctx, pat), journey(ctx, { ...owner, key: { id: "k1" } } as typeof owner)];

    // then
    expect(await Promise.all(tries.map((t) => t.then(() => null, (e: AccountError) => e.status)))).toEqual([403, 403]);
  });

  it("given a log longer than one page, when the first request is read, then it is the oldest one, not the oldest on the newest page", async () => {
    // given
    const { ctx, owner } = await organization();
    for (let n = 0; n < 520; n++) await recordEvent(ctx, owner, "request.opened", { detail: `#${n}` }, new Date(at(1).getTime() + n * 60_000));

    // when
    const read = await journey(ctx, owner, at(7));

    // then
    expect(read.milestones.find((m) => m.id === "request")?.at).toBe(at(1).toISOString());
  });
});
