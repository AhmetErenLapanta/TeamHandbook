import type { MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import { createApp } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { machineAsksOf } from "../machine-folders.js";
import { openSqliteStore } from "../store.js";
import type { DetectedVerification } from "../../shared/verification.js";
import { storePrincipals } from "../test-fixtures.js";

const MAX: Principal = { id: "usr_max", name: "Max Example", email: "max@example.invalid", role: "member", ownedTeams: [] };
const LEE: Principal = { id: "usr_lee", name: "Lee Example", email: "lee@example.invalid", role: "member", ownedTeams: [] };
const ADA: Principal = { id: "usr_ada", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const CHECK = { source: "package.json scripts.test", command: "npm test", digest: "c".repeat(64) };

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function maxsFolder(): Promise<OrchestratorContext> {
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme" };
  await storePrincipals(ctx, MAX, LEE, ADA);
  await ctx.store.insertMachine({ tenant: ctx.tenant, id: "mch_max", userId: MAX.id, name: "max-laptop", platform: "darwin", publicKey: "k", agents: [], createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt: null, revokedAt: null, tokenHash: "h" }, null);
  await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "notes", team: "Personal", name: "notes", url: "machine:mch_max:~/notes" });
  return ctx;
}

const asked = (ctx: OrchestratorContext, user: Principal, method: "GET" | "PUT" | "DELETE") =>
  createApp(ctx, as(user)).request("/api/projects/notes/verification", method === "PUT" ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ checks: [CHECK], setup: null }) } : { method });

const read = (digest: string): DetectedVerification => ({ setup: null, checks: [{ kind: "test", command: CHECK.command, runs: "scripts.test: vitest run", source: CHECK.source, network: false, long: false, digest }] });

/** Max's machine polling, answering each ask of the folder's checks with what `files` names now; as a runner does, it polls again after the ask that woke it. */
function maxsMachine(ctx: OrchestratorContext, files: { now: DetectedVerification }): void {
  const asks = machineAsksOf(ctx);
  const poll = () => {
    const open = asks.polling("mch_max");
    open.signal.addEventListener("abort", () => queueMicrotask(() => {
      for (const ask of open.take().checks) asks.answer("mch_max", "checks", ask.nonce, { detected: files.now });
      open.end();
      poll();
    }), { once: true });
  };
  poll();
}

describe("the checks of a folder on a person's machine", () => {
  it.each<[string, Principal]>([
    ["an admin", ADA],
    ["another member", LEE],
    ["the machine's person by a key", { ...MAX, key: { id: "k1", owner: { kind: "user", id: MAX.id }, scopes: {}, expiresAt: null } } as unknown as Principal],
  ])("given %s, when they read, approve or take back the folder's checks, then the project is not found", async (_who, user) => {
    // given
    const ctx = await maxsFolder();

    // when
    const answers = await Promise.all((["GET", "PUT", "DELETE"] as const).map((method) => asked(ctx, user, method)));

    // then
    expect(answers.map((answer) => answer.status)).toEqual([404, 404, 404]);
  });

  it("given the machine's person and their machine not connected, when they read and approve the folder's checks, then the page says why and nothing is approved", async () => {
    // given
    const ctx = await maxsFolder();

    // when
    const shown = await asked(ctx, MAX, "GET");
    const approve = await asked(ctx, MAX, "PUT");

    // then
    expect(await shown.json()).toMatchObject({ detected: null, unread: expect.stringContaining("max-laptop is not connected now"), approved: null });
    expect([approve.status, (await approve.json()).code]).toEqual([409, "unread"]);
  });

  it("given the machine's person, a member, and their machine reading the folder, when they approve what it read, then the approval holds the machine's reading, and once the folder changed an approval of the old one is refused", async () => {
    // given
    const ctx = await maxsFolder();
    const files = { now: read(CHECK.digest) };
    maxsMachine(ctx, files);

    // when
    const shown = await (await asked(ctx, MAX, "GET")).json();
    const approve = await asked(ctx, MAX, "PUT");
    files.now = read("d".repeat(64));
    const stale = await asked(ctx, MAX, "PUT");
    const forget = await asked(ctx, MAX, "DELETE");

    // then
    expect(shown).toMatchObject({ detected: read(CHECK.digest), unread: null });
    expect(approve.status).toBe(200);
    expect((await approve.json()).approved).toMatchObject({ checks: [{ command: "npm test", digest: CHECK.digest }], by: MAX.name });
    expect([stale.status, (await stale.json()).code]).toEqual([409, "changed"]);
    expect([forget.status, (await forget.json()).approved]).toEqual([200, null]);
  });
});
