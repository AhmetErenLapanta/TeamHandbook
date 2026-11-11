import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp, mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { openSqliteStore } from "../store.js";
import { UNKNOWN_COST } from "../tasks/types.js";
import type { TaskRecord } from "../tasks/types.js";
import { FILE_PATCH_MAX, isTestPath, readRequestChanges, readRequestFile } from "./request-diff.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];

/** A bare mirror whose `feature` branch changes, adds, removes, renames, tests and binary-writes files off `main`, plus one huge file. */
function mirror() {
  const root = mkdtempSync(join(tmpdir(), "request-diff-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "skills"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: seed, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "skills\n");
  writeFileSync(join(seed, "skills", "old.md"), "old skill\n");
  writeFileSync(join(seed, "gone.md"), "to be removed\n");
  writeFileSync(join(seed, "moved.md"), "a file that only moves, long enough that git sees the rename\n".repeat(4));
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const main = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "feature");
  writeFileSync(join(seed, "README.md"), "skills, with more\nand a second line\n");
  mkdirSync(join(seed, "tests"), { recursive: true });
  writeFileSync(join(seed, "tests", "skill.test.ts"), "expect(1).toBe(1);\n");
  writeFileSync(join(seed, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 0, 255]));
  writeFileSync(join(seed, "vendor.txt"), "x".repeat(80) + "\n".repeat(1) + "line\n".repeat(FILE_PATCH_MAX / 4));
  rmSync(join(seed, "gone.md"));
  git("mv", "moved.md", "skills/moved.md");
  git("add", "-A");
  git("commit", "-q", "-m", "feature");
  const bare = join(root, "mirror.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  return { bare, main };
}

describe("a request's changes from the orchestrator's copy", () => {
  it("given a branch that changes, adds, removes, renames and writes a binary file, when its changes are read, then each file says so, and a file's patch is read on its own", async () => {
    const { bare, main } = mirror();
    const changes = await readRequestChanges(bare, main, ["refs/heads/feature"]);
    if (typeof changes === "string") throw new Error(changes);

    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    expect(byPath["gone.md"]).toMatchObject({ status: "deleted" });
    expect(changes.omitted).toBe(0);
    expect(await readRequestFile(bare, main, ["refs/heads/feature"], "README.md")).toMatchObject({ truncated: false, note: null, patch: expect.stringContaining("+and a second line") });
  });

  it("given a request the copy does not hold yet, when its changes are read, then it says to sync rather than showing nothing", async () => {
    const { bare, main } = mirror();
    expect(await readRequestChanges(bare, main, ["refs/merge-requests/9/head"])).toContain("sync the repository");
  });
});

describe("telling a test file", () => {
  it("given paths in test folders or named as tests, when each is told, then those are tests and the rest are not", () => {
    for (const path of ["tests/a.ts", "src/__tests__/b.js", "spec/c.rb", "pkg/d_test.go", "web/e.test.tsx", "f.spec.ts"]) expect(isTestPath(path)).toBe(true);
    for (const path of ["skills/testing-guide.md", "src/contest.ts", "README.md"]) expect(isTestPath(path)).toBe(false);
  });
});

describe("a request's changes read as a list first and one file at a time", () => {
  it("given a request's changes, when they are listed, then each file comes with its status, counts, binary and test marks and no patch", async () => {
    const { bare, main } = mirror();

    const changes = await readRequestChanges(bare, main, ["refs/heads/feature"]);

    if (typeof changes === "string") throw new Error(changes);
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]));
    expect(byPath["README.md"]).toEqual({ path: "README.md", status: "modified", previousPath: null, additions: 2, deletions: 1, binary: false, test: false });
    expect(byPath["tests/skill.test.ts"]).toMatchObject({ status: "added", test: true });
    expect(byPath["logo.png"]).toMatchObject({ binary: true, additions: null });
    expect(byPath["skills/moved.md"]).toMatchObject({ status: "renamed", previousPath: "moved.md" });
    expect(changes.files.some((f) => "patch" in f)).toBe(false);
  });

  it("given one file asked for, when it is read, then a patch past the cap is cut there and says so, a binary one says so in words, and a file the request does not change is not read", async () => {
    const { bare, main } = mirror();

    const vendor = await readRequestFile(bare, main, ["refs/heads/feature"], "vendor.txt");
    const logo = await readRequestFile(bare, main, ["refs/heads/feature"], "logo.png");

    expect(vendor).toMatchObject({ truncated: true, note: "the patch passes 512 KB and is cut there" });
    expect(Buffer.byteLength((vendor as { patch: string }).patch)).toBeLessThanOrEqual(FILE_PATCH_MAX);
    expect(logo).toMatchObject({ binary: true, patch: null, note: "a binary file; its contents are not shown" });
    expect(await readRequestFile(bare, main, ["refs/heads/feature"], "skills/old.md")).toBeNull();
  });
});

describe("a request's changes over the API", () => {
  it("given a teammate's merge request the mirror holds under GitLab's ref for its number, when its file list and one file are asked for, then the list carries no patch, the file its patch, and a file it does not change is not found", async () => {
    const { bare, main } = mirror();
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(mkdtempSync(join(tmpdir(), "request-diff-api-")), "data"), tenant: "acme" };
    mkdirSync(join(ctx.dataDir, "mirrors", "acme"), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", bare, mirrorDir(ctx, "skills")]);
    execFileSync("git", ["update-ref", "refs/merge-requests/4/head", "refs/heads/feature"], { cwd: mirrorDir(ctx, "skills") });
    await ctx.store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: "https://gitlab.example.invalid/acme/skills.git" });
    await ctx.store.recordSync("acme", "skills", { head: main });
    await ctx.store.setForgeConfig("acme", { repoId: "skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/skills" });
    const app = createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-1", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [], restrictedTeams: [] });
      await next();
    });

    const list = (await (await app.request("/api/repos/skills/requests/4/changes")).json()) as { changes: { files: { path: string }[] } };
    const file = await app.request("/api/repos/skills/requests/4/changes/tests/skill.test.ts");

    expect(list.changes.files.map((f) => f.path)).toContain("tests/skill.test.ts");
    expect(((await file.json()) as { file: { patch: string } }).file.patch).toContain("+expect(1).toBe(1);");
    expect((await app.request("/api/repos/skills/requests/4/changes/skills/old.md")).status).toBe(404);
    const outside = createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-2", name: "Ola", email: "ola@example.invalid", role: "member", ownedTeams: [], restrictedTeams: ["Payments"] });
      await next();
    });
    const image = `/api/repos/skills/media?request=4&src=${encodeURIComponent("https://elsewhere.example.invalid/x.png")}`;
    expect((await app.request(image)).status).toBe(422);
    expect((await outside.request(image)).status).toBe(404);
    expect((await app.request(image.replace("request=4&", ""))).status).toBe(404);
    expect((await outside.request("/api/repos/skills/requests/4/changes")).status).toBe(404);
  });

  it("given a request on a repository read by path, when its changes are asked for, then they are read from the person's own repository as their runner left it, with no copy of the orchestrator's", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-diff-local-"));
    const own = join(root, "skills");
    mkdirSync(own);
    const git = (...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: own, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(own, "README.md"), "skills\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("checkout", "-q", "-b", "handbook/retry");
    writeFileSync(join(own, "retry.md"), "# Retry\n");
    git("add", ".");
    git("commit", "-q", "-m", "retry");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "solo" };
    await ctx.store.upsertRepo({ tenant: "solo", id: "skills", team: "Me", name: "skills", url: own });
    await ctx.store.saveRequest({ tenant: "solo", repoId: "skills", number: 1, url: "local://requests/skills/1", branch: "handbook/retry", headSha: head, title: "Add retry", status: "open", provider: "local", createdAt: "2026-11-03T00:00:00.000Z", createdBy: "me@example.invalid" });
    const app = createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-1", name: "Me", email: "me@example.invalid", role: "owner", ownedTeams: [] });
      await next();
    });

    const res = await app.request("/api/repos/skills/requests/1/changes");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { changes: { head: string; files: { path: string }[] } }).changes).toMatchObject({ head, files: [{ path: "retry.md", status: "added" }] });
  });

  it("given a request on a repository read by path, when its status is asked for, then it is read from the repository: mergeable while its branch merges cleanly, a conflict once the base moves under it, with no CI, review or comment", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-status-local-"));
    const own = join(root, "skills");
    mkdirSync(own);
    const git = (...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: own, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(own, "README.md"), "skills\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("checkout", "-q", "-b", "handbook/retry");
    writeFileSync(join(own, "README.md"), "skills, with retry\n");
    git("commit", "-q", "-am", "retry");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "solo" };
    await ctx.store.upsertRepo({ tenant: "solo", id: "skills", team: "Me", name: "skills", url: own });
    await ctx.store.saveRequest({ tenant: "solo", repoId: "skills", number: 1, url: "local://requests/skills/1", branch: "handbook/retry", headSha: head, title: "Add retry", status: "open", provider: "local", createdAt: "2026-11-03T00:00:00.000Z", createdBy: "me@example.invalid" });
    const app = createApp(ctx, async (c, next) => {
      c.set("user", { id: "u-1", name: "Me", email: "me@example.invalid", role: "owner", ownedTeams: [] });
      await next();
    });
    const status = async () => ((await (await app.request("/api/repos/skills/requests/1/status")).json()) as { status: { source: string; capabilities: unknown; comments: unknown[]; detail: { headSha: string; mergeability: { state: string }; checks: { state: string }; review: { decision: string } } } }).status;

    const clean = await status();
    writeFileSync(join(own, "README.md"), "skills, changed on main\n");
    git("commit", "-q", "-am", "main moves");
    const conflicting = await status();

    expect(clean).toMatchObject({ source: "local", capabilities: null, comments: [], detail: { headSha: head, mergeability: { state: "mergeable" }, checks: { state: "no-ci" }, review: { decision: "none" } } });
    expect(conflicting.detail.mergeability.state).toBe("conflict");
  });

  it("given a team kept to its own people, when someone outside it asks for its request's changes, a file or its status, then no such request exists for them, while the person who opened it reads it all", async () => {
    const root = mkdtempSync(join(tmpdir(), "request-restricted-"));
    const own = join(root, "skills");
    mkdirSync(own);
    const git = (...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd: own, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(own, "README.md"), "skills\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("checkout", "-q", "-b", "handbook/retry");
    writeFileSync(join(own, "retry.md"), "# Retry\n");
    git("add", ".");
    git("commit", "-q", "-m", "retry");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "acme" };
    await ctx.store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: own });
    await ctx.store.saveRequest({ tenant: "acme", repoId: "skills", number: 1, url: "local://requests/skills/1", branch: "handbook/retry", headSha: head, title: "Add retry", status: "open", provider: "local", createdAt: "2026-11-03T00:00:00.000Z", createdBy: "pat@example.invalid" });
    const as = (email: string) =>
      createApp(ctx, async (c, next) => {
        c.set("user", { id: email, name: email, email, role: "member", ownedTeams: [], restrictedTeams: ["Payments"] });
        await next();
      });
    const paths = ["/api/repos/skills/requests/1/changes", "/api/repos/skills/requests/1/changes/retry.md", "/api/repos/skills/requests/1/status"];

    const outside = await Promise.all(paths.map(async (path) => (await as("max@example.invalid").request(path)).status));
    const opener = await Promise.all(paths.map(async (path) => (await as("pat@example.invalid").request(path)).status));

    expect(outside).toEqual([404, 404, 404]);
    expect(opener).toEqual([200, 200, 200]);
  });

  it("given a request a task opened, when a member of its open team who does not read the task asks for its changes, a file, its status, its description or an image in it, then each is unknown to them, while the task's starter and the team's owner read them, and a request no task opened stays open to the team", async () => {
    const { bare, main } = mirror();
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(mkdtempSync(join(tmpdir(), "request-task-")), "data"), tenant: "acme" };
    mkdirSync(join(ctx.dataDir, "mirrors", "acme"), { recursive: true });
    execFileSync("git", ["clone", "-q", "--bare", bare, mirrorDir(ctx, "skills")]);
    for (const n of [6, 7]) execFileSync("git", ["update-ref", `refs/merge-requests/${n}/head`, "refs/heads/feature"], { cwd: mirrorDir(ctx, "skills") });
    await ctx.store.upsertRepo({ tenant: "acme", id: "skills", team: "Payments", name: "skills", url: "https://gitlab.example.invalid/acme/skills.git" });
    await ctx.store.recordSync("acme", "skills", { head: main });
    await ctx.store.setForgeConfig("acme", { repoId: "skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/skills" });
    const request = (number: number) => ({ tenant: "acme", repoId: "skills", number, url: `https://gitlab.example.invalid/acme/skills/-/merge_requests/${number}`, branch: "feature", headSha: "f".repeat(40), title: "Add retry", status: "open" as const, provider: "gitlab" as const, createdAt: "2026-11-03T00:00:00.000Z", createdBy: "pat@example.invalid" });
    await ctx.store.saveRequest(request(6));
    await ctx.store.saveRequest(request(7));
    const task: TaskRecord = { tenant: "acme", id: "tsk_request6", repoId: "skills", team: "Payments", title: "Add retry", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: "pat@example.invalid", createdAt: "2026-11-03T00:00:00.000Z", startedAt: null, finishedAt: null, baseSha: main, tests: null, cost: UNKNOWN_COST, requestNumber: 6, error: null };
    await ctx.store.createTask(task);
    const as = (email: string, ownedTeams: string[] = []) =>
      createApp(ctx, async (c, next) => {
        c.set("user", { id: email, name: email, email, role: "member", ownedTeams, restrictedTeams: [] });
        await next();
      });
    const image = (n: number) => `/api/repos/skills/media?${new URLSearchParams({ request: String(n), src: "https://elsewhere.example.invalid/x.png" })}`;
    const reads = (app: ReturnType<typeof as>, n: number) => Promise.all([`/api/repos/skills/requests/${n}/changes`, `/api/repos/skills/requests/${n}/changes/README.md`, `/api/repos/skills/requests/${n}/description`, image(n)].map(async (path) => (await app.request(path)).status));

    expect(await reads(as("max@example.invalid"), 6)).toEqual([404, 404, 404, 404]);
    expect((await as("max@example.invalid").request("/api/repos/skills/requests/6/status")).status).toBe(404);
    expect(await reads(as("pat@example.invalid"), 6)).toEqual([200, 200, 200, 422]);
    expect(await reads(as("owner@example.invalid", ["Payments"]), 6)).toEqual([200, 200, 200, 422]);
    expect(await reads(as("max@example.invalid"), 7)).toEqual([200, 200, 200, 422]);
  });
});

