import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
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

describe("the checks of a repository inside a folder of several", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Ada Example", "-c", "user.email=ada@example.invalid", ...args], { cwd, stdio: "pipe" });
  const repo = (folder: string, name: string, test: string) => {
    const dir = join(folder, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test } }));
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
  };

  /** A folder holding two repositories, `api` and `web`, opened as a project on an orchestrator whose person is an admin. */
  async function ofSeveral(): Promise<{ ctx: OrchestratorContext; folder: string }> {
    const folder = mkdtempSync(join(tmpdir(), "orchestrator-several-"));
    dirs.push(folder);
    repo(folder, "api", "vitest run");
    repo(folder, "web", "jest");
    mkdirSync(join(folder, "notes"));
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme" };
    await storePrincipals(ctx, ADA, LEE);
    await ctx.store.upsertRepo({ tenant: ctx.tenant, id: "work", team: "Personal", name: "work", url: folder });
    return { ctx, folder };
  }

  const call = (ctx: OrchestratorContext, user: Principal, method: "GET" | "PUT" | "DELETE", repoPath: string, body?: unknown) =>
    createApp(ctx, as(user)).request(`/api/projects/work/verification?repo=${encodeURIComponent(repoPath)}`, body ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { method });
  const choice = (shown: { detected: DetectedVerification }) => ({ checks: shown.detected.checks.slice(0, 1).map(({ source, command, digest }) => ({ source, command, digest })), setup: null });

  it("given a folder of two repositories, when each is read and approved, then each repository has its own checks and approval and the other is not approved by it", async () => {
    // given
    const { ctx } = await ofSeveral();

    // when
    const api = await (await call(ctx, ADA, "GET", "api")).json();
    const web = await (await call(ctx, ADA, "GET", "web")).json();
    const approve = await call(ctx, ADA, "PUT", "api", choice(api));
    const afterApi = await (await call(ctx, ADA, "GET", "api")).json();
    const afterWeb = await (await call(ctx, ADA, "GET", "web")).json();
    const project = await (await createApp(ctx, as(ADA)).request("/api/projects/work/verification")).json();

    // then
    expect(api.detected.checks[0]).toMatchObject({ command: "npm test", runs: "scripts.test: vitest run" });
    expect(web.detected.checks[0]).toMatchObject({ runs: "scripts.test: jest" });
    expect(approve.status).toBe(200);
    expect(afterApi.approved).toMatchObject({ checks: [{ command: "npm test" }], by: ADA.name });
    expect(afterWeb.approved).toBeNull();
    expect(project.approved).toBeNull();
  });

  it("given an approved repository whose test script changed in its next commit, when its checks are read, then the approval says it changed and taking it back leaves the other repository's alone", async () => {
    // given
    const { ctx, folder } = await ofSeveral();
    for (const name of ["api", "web"]) await call(ctx, ADA, "PUT", name, choice(await (await call(ctx, ADA, "GET", name)).json()));
    writeFileSync(join(folder, "api", "package.json"), JSON.stringify({ scripts: { test: "node send.js" } }));
    git(join(folder, "api"), "commit", "-qam", "change the test");

    // when
    const api = await (await call(ctx, ADA, "GET", "api")).json();
    const forget = await call(ctx, ADA, "DELETE", "api");
    const web = await (await call(ctx, ADA, "GET", "web")).json();

    // then
    expect(api.changed).toEqual(["package.json scripts.test"]);
    expect((await forget.json()).approved).toBeNull();
    expect(web.approved).toMatchObject({ checks: [{ command: "npm test" }] });
  });

  it("given an uncommitted edit of a repository's test script, when its checks are read, then they are the last commit's, as a task's copy has them", async () => {
    // given
    const { ctx, folder } = await ofSeveral();
    writeFileSync(join(folder, "api", "package.json"), JSON.stringify({ scripts: { test: "rm -rf data" } }));

    // when
    const api = await (await call(ctx, ADA, "GET", "api")).json();

    // then
    expect(api.detected.checks[0].runs).toBe("scripts.test: vitest run");
  });

  it.each<[string, string]>([
    ["a path out of the folder", "../api"],
    ["an absolute path", "/etc"],
    ["a folder that is no repository", "notes"],
    ["a path the folder does not hold", "gone"],
  ])("given %s, when its checks are read or approved, then it is no repository of the folder and nothing is kept", async (_case, path) => {
    // given
    const { ctx } = await ofSeveral();

    // when
    const read = await call(ctx, ADA, "GET", path);
    const approve = await call(ctx, ADA, "PUT", path, { checks: [CHECK], setup: null });

    // then
    expect([read.status, approve.status]).toEqual(path.startsWith("/") || path.startsWith("..") ? [404, 404] : [200, 409]);
    if (read.status === 200) expect(await read.json()).toMatchObject({ detected: null, unread: expect.stringContaining("not one of this folder's") });
  });

  it("given a link in the folder to a repository outside it, when its checks are read, then the link is no repository of the folder", async () => {
    // given
    const { ctx, folder } = await ofSeveral();
    const outside = mkdtempSync(join(tmpdir(), "orchestrator-outside-"));
    dirs.push(outside);
    repo(outside, "stolen", "echo secret");
    symlinkSync(join(outside, "stolen"), join(folder, "linked"));

    // when
    const read = await call(ctx, ADA, "GET", "linked");

    // then
    expect(await read.json()).toMatchObject({ detected: null, unread: expect.stringContaining("not one of this folder's") });
  });

  it("given a member, when they approve a repository of the folder, then it is refused as for the project", async () => {
    // given
    const { ctx } = await ofSeveral();
    const api = await (await call(ctx, ADA, "GET", "api")).json();

    // when
    const put = await call(ctx, LEE, "PUT", "api", choice(api));

    // then
    expect(put.status).toBe(403);
  });
});
