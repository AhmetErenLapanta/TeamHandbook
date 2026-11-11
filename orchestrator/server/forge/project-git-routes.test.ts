import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { projectRoutes } from "../project-routes.js";
import { openSqliteStore } from "../store.js";
import { projectGitRoutes } from "./project-git-routes.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };

/** A local orchestrator whose owner's home holds a plain folder called notes, outside any repository. */
function machine(user: Principal = OWNER) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-project-git-")));
  dirs.push(root);
  const home = join(root, "home");
  const notes = join(home, "notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "todo.md"), "x\n");
  writeFileSync(join(notes, ".env"), "PORT=3000\n");
  vi.stubEnv("HOME", home);
  vi.stubEnv("ORCHESTRATOR_MODE", "local");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: "default", addedRepos: new Map(), localReposRoot: home };
  const app = new Hono<OrchestratorEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", projectRoutes(ctx));
  app.route("/", projectGitRoutes(ctx, home));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { project?: { facts?: { git?: string } } } };
  };
  return { root, home, notes, call };
}

describe("making a project's folder a Git repository and committing it", () => {
  it("given a plain folder opened as a project, when it is made a repository and its changes committed, then git init alone runs first, the commit takes what the person kept with their message, and a retry with the same commandId answers the same", async () => {
    const { notes, call } = machine();
    const { body: opened } = await call("POST", "/api/projects", { path: notes });
    const id = (opened.project as { id: string }).id;

    const init = await call("POST", `/api/projects/${id}/git/init`, { commandId: "init-0001" });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: notes });
    execFileSync("git", ["config", "user.email", "ada@example.invalid"], { cwd: notes });
    const preview = await call("GET", `/api/projects/${id}/git/commit`);
    const commit = await call("POST", `/api/projects/${id}/git/commit`, { commandId: "commit-0001", message: "Start notes", exclude: [".env"] });
    const retried = await call("POST", `/api/projects/${id}/git/commit`, { commandId: "commit-0001", message: "Start notes", exclude: [".env"] });
    const again = await call("POST", `/api/projects/${id}/git/init`, { commandId: "init-0002" });

    expect([init.status, init.body.project?.facts?.git]).toEqual([200, "repo"]);
    expect(preview.body).toMatchObject({ first: true, message: "Start notes", files: expect.arrayContaining([expect.objectContaining({ path: ".env", secretLike: true }), expect.objectContaining({ path: "todo.md", secretLike: false })]) });
    expect(commit.status).toBe(200);
    expect(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: notes, encoding: "utf8" }).trim()).toBe("todo.md");
    expect(retried).toEqual(commit);
    expect([again.status, again.body.error]).toEqual([409, "this folder is a Git repository already"]);
  });

  it("given a project whose folder was turned into a link out of the home since it was opened, when it is made a repository, then the folder rule refuses it and nothing is written there", async () => {
    const { root, notes, call } = machine();
    const { body: opened } = await call("POST", "/api/projects", { path: notes });
    const outside = join(root, "outside");
    mkdirSync(outside);
    rmSync(notes, { recursive: true, force: true });
    symlinkSync(outside, notes);

    const init = await call("POST", `/api/projects/${(opened.project as { id: string }).id}/git/init`, { commandId: "init-0003" });

    expect([init.status, init.body.code]).toEqual([400, "outside-home"]);
    expect(() => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: outside, stdio: "ignore" })).toThrow();
  });

  it("given a project whose folder was turned into a link to another folder of the home since it was opened, when it is made a repository or its changes read, then it is refused as moved and the other folder is untouched", async () => {
    const { home, notes, call } = machine();
    const { body: opened } = await call("POST", "/api/projects", { path: notes });
    const id = (opened.project as { id: string }).id;
    const other = join(home, "other");
    mkdirSync(other);
    rmSync(notes, { recursive: true, force: true });
    symlinkSync(other, notes);

    const init = await call("POST", `/api/projects/${id}/git/init`, { commandId: "init-0006" });
    const preview = await call("GET", `/api/projects/${id}/git/commit`);

    expect([init.status, init.body.code, init.body.error]).toEqual([409, "moved", "this folder moved or became a link since it was opened; open it again"]);
    expect(preview.status).toBe(409);
    expect(() => execFileSync("git", ["rev-parse", "--git-dir"], { cwd: other, stdio: "ignore" })).toThrow();
  });

  it("given no commandId, a member, or an orchestrator not in local mode, when a folder is to be made a repository, then each is refused before git runs", async () => {
    const owned = machine();
    const { body: opened } = await owned.call("POST", "/api/projects", { path: owned.notes });
    const id = (opened.project as { id: string }).id;
    expect((await owned.call("POST", `/api/projects/${id}/git/init`, {})).status).toBe(400);

    const member = machine({ ...OWNER, id: "usr_m", role: "member" });
    expect((await member.call("POST", "/api/projects/notes/git/init", { commandId: "init-0004" })).status).toBe(403);
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    expect((await owned.call("POST", `/api/projects/${id}/git/init`, { commandId: "init-0005" })).status).toBe(404);
  });
});

describe("cloning a repository as a project", () => {
  it("given an address that is no https or ssh one, a place that exists, a hidden place and one outside the home, when each is cloned, then each is refused before git reaches anything", async () => {
    const { root, home, notes, call } = machine();

    const local = await call("POST", "/api/projects/clone", { commandId: "clone-0001", url: "file:///srv/skills.git" });
    const taken = await call("POST", "/api/projects/clone", { commandId: "clone-0002", url: "https://github.com/acme/notes.git", into: notes });
    const hidden = await call("POST", "/api/projects/clone", { commandId: "clone-0003", url: "https://github.com/acme/skills.git", into: join(home, ".cache", "skills") });
    const outside = await call("POST", "/api/projects/clone", { commandId: "clone-0004", url: "https://github.com/acme/skills.git", into: join(root, "elsewhere", "skills") });

    expect([local.status, local.body.error]).toEqual([400, "a repository address over https or ssh, with no user or token in it"]);
    expect([taken.status, taken.body.error]).toEqual([409, `${notes} already exists; choose another place`]);
    expect([hidden.status, hidden.body.code]).toEqual([403, "hidden"]);
    expect([outside.status, outside.body.code]).toEqual([403, "outside-home"]);
  });
});
