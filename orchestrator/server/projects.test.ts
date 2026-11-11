import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { listFolders, localFolderRoutes, originInConfig, originOf, projectFacts, projectFolder } from "./projects.js";
import { openSqliteStore } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A home folder with projects, a hidden folder, a Library holding the orchestrator's data, and a link out of it. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-projects-")));
  dirs.push(root);
  const home = join(root, "home");
  const outside = join(root, "elsewhere");
  const dataDir = join(home, "Library", "Application Support", "TeamHandbook Orchestrator");
  for (const dir of [join(home, "code", "shop", ".git"), join(home, "code", "notes"), join(home, "code", "skills", ".claude-plugin"), join(home, ".ssh"), join(home, "Documents", "taxes"), dataDir, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, "code", "shop", ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://ada:glpat-secret@gitlab.com/acme/shop.git\n');
  writeFileSync(join(home, "code", "shop", "package.json"), "{}");
  writeFileSync(join(home, "code", "skills", ".claude-plugin", "marketplace.json"), "{}");
  writeFileSync(join(home, "code", "notes", "todo.md"), "x");
  symlinkSync(outside, join(home, "code", "escape"));
  return { home, dataDir, outside };
}

describe("a folder holding several repositories", () => {
  it("given a folder with two working copies under it and one inside node_modules, when its facts and its parent's list are read, then it counts the two, and a repository itself carries no count", async () => {
    // given
    const { home, dataDir } = machine();
    const parent = join(home, "code", "mcp");
    for (const dir of [join(parent, "client", ".git"), join(parent, "server"), join(parent, "node_modules", "dep", ".git")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(parent, "server", ".git"), "gitdir: ../.git/worktrees/server\n");

    // when
    const facts = await projectFacts(parent, { home, dataDir });
    const listed = await listFolders(join(home, "code"), undefined, { home, dataDir });

    // then
    expect(facts).toMatchObject({ git: "none", repos: 2 });
    if ("refused" in listed) throw new Error(listed.message);
    expect(listed.folders.find((f) => f.name === "mcp")).toMatchObject({ git: "none", repos: 2 });
    expect(listed.folders.find((f) => f.name === "shop")).not.toHaveProperty("repos");
  });

  it("given a code root holding two working copies, when the folders are suggested, then that root is offered first, with its count, beside the repositories in it", async () => {
    // given
    const { home, dataDir } = machine();
    mkdirSync(join(home, "code", "web", ".git"), { recursive: true });

    // when
    const listed = await listFolders(undefined, undefined, { home, dataDir });

    // then
    if ("refused" in listed) throw new Error(listed.message);
    expect(listed.suggestions[0]).toMatchObject({ name: "code", path: join(home, "code"), git: "none", repos: 2 });
  });
});

describe("which folder a project opens on", () => {
  it("given folders inside the home, the home itself, a hidden one, Library, one around the data, a link out and a file, when each is checked, then only the folders of the person's own pass", async () => {
    // given
    const { home, dataDir, outside } = machine();
    const where = { home, dataDir };
    const code = async (path: string) => {
      const checked = await projectFolder(path, where);
      return "refused" in checked ? checked.refused : "ok";
    };

    // when
    const answers = {
      project: await code(join(home, "code", "shop")),
      home: await code(home),
      hidden: await code(join(home, ".ssh")),
      library: await code(join(home, "Library")),
      aroundData: await code(join(home, "Library", "Application Support")),
      insideData: await code(dataDir),
      link: await code(join(home, "code", "escape")),
      outside: await code(outside),
      file: await code(join(home, "code", "notes", "todo.md")),
      relative: await code("code/shop"),
      missing: await code(join(home, "code", "gone")),
    };

    // then
    expect(answers).toEqual({ project: "ok", home: "home-itself", hidden: "hidden", library: "library", aroundData: "library", insideData: "library", link: "outside-home", outside: "outside-home", file: "not-a-folder", relative: "not-absolute", missing: "not-found" });
    expect(await projectFolder(home, where, true)).toEqual({ real: home });
  });

  it("given the orchestrator's data inside an ordinary folder of the home, when that folder or one around it is checked, then it is refused as the orchestrator's own", async () => {
    const { home } = machine();
    const dataDir = join(home, "work", "orchestrator-data");
    mkdirSync(dataDir, { recursive: true });
    expect(await projectFolder(join(home, "work"), { home, dataDir })).toMatchObject({ refused: "data-dir" });
    expect(await projectFolder(dataDir, { home, dataDir })).toMatchObject({ refused: "data-dir" });
  });
});

describe("what a project's folder is", () => {
  it("given a repository with an origin, a folder with no git, a team skills folder and a worktree pointing into a repository, when their facts are read, then git, origin, name and kind come from the files alone", async () => {
    // given
    const { home, dataDir } = machine();
    const main = join(home, "code", "main-repo");
    mkdirSync(join(main, ".git", "worktrees", "side"), { recursive: true });
    writeFileSync(join(main, ".git", "config"), "[core]\n\tbare = false\n");
    writeFileSync(join(main, ".git", "worktrees", "side", "commondir"), "../..\n");
    const side = join(home, "code", "side");
    mkdirSync(side);
    writeFileSync(join(side, ".git"), `gitdir: ${join(main, ".git", "worktrees", "side")}\n`);

    // when
    const facts = await Promise.all(["shop", "notes", "skills", "side"].map((name) => projectFacts(join(home, "code", name), { home, dataDir })));

    // then
    expect(facts).toEqual([
      { git: "origin", origin: { forge: "gitlab", web: "https://gitlab.com/acme/shop" }, name: "shop", kind: "code", empty: false },
      { git: "none", origin: null, name: "notes", kind: "code", empty: false },
      { git: "none", origin: null, name: "skills", kind: "skills", empty: false },
      { git: "repo", origin: null, name: "side", kind: "code", empty: false },
    ]);
  });

  it("given a bare repository with nothing pushed and one a clone pushed to, when their facts are read, then both are git repositories and only the first is empty", async () => {
    // given
    const { home, dataDir } = machine();
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
    const bare = (name: string) => {
      const dir = join(home, "code", name);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "--bare", "-b", "main");
      return dir;
    };
    const unused = bare("unused.git");
    const shared = bare("shared.git");
    const clone = join(home, "code", "clone");
    mkdirSync(clone);
    git(clone, "init", "-q", "-b", "main");
    writeFileSync(join(clone, "a.md"), "a\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "first");
    git(shared, "fetch", "-q", clone, "main:main");

    // when
    const facts = await Promise.all([unused, shared].map((dir) => projectFacts(dir, { home, dataDir })));

    // then
    expect(facts.map((f) => [f.git, f.empty])).toEqual([["repo", true], ["repo", false]]);
  });

  it("given a repository just made with git init, one with a commit, and one whose branch is in packed refs, when their facts are read, then only the first is empty", async () => {
    // given
    const { home, dataDir } = machine();
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd });
    const made = (name: string) => {
      const dir = join(home, "code", name);
      mkdirSync(dir, { recursive: true });
      git(dir, "init", "-q", "-b", "main");
      return dir;
    };
    const fresh = made("fresh");
    const done = made("done");
    writeFileSync(join(done, "a.md"), "a\n");
    git(done, "add", ".");
    git(done, "commit", "-qm", "first");
    const packed = made("packed");
    writeFileSync(join(packed, "a.md"), "a\n");
    git(packed, "add", ".");
    git(packed, "commit", "-qm", "first");
    git(packed, "pack-refs", "--all");

    // when
    const empty = await Promise.all([fresh, done, packed].map(async (dir) => (await projectFacts(dir, { home, dataDir })).empty));

    // then
    expect(empty).toEqual([true, false, false]);
  });

  it("given origins written over https with a token, over ssh, on another forge and as nothing a page links to, when they are read, then the address shown carries neither user nor token", () => {
    expect(originOf("https://ada:glpat-secret@gitlab.com/acme/shop.git")).toEqual({ forge: "gitlab", web: "https://gitlab.com/acme/shop" });
    expect(originOf("git@github.com:acme/shop.git")).toEqual({ forge: "github", web: "https://github.com/acme/shop" });
    expect(originOf("ssh://git@git.example.invalid:2222/acme/shop.git")).toEqual({ forge: "other", web: "https://git.example.invalid/acme/shop" });
    expect(originOf("/srv/git/shop.git")).toBeNull();
    expect(originInConfig('[remote "upstream"]\n\turl = https://x.invalid/u\n[remote "origin"]\n\turl = "https://x.invalid/o"\n')).toBe("https://x.invalid/o");
  });
});

describe("the folders a person picks from", () => {
  it("given a home with projects, a hidden folder, Library, Documents holding a project and a link into it, when the home is listed and when Documents is opened, then nothing inside Documents is read until it is opened, and then its projects are", async () => {
    // given
    const { home, dataDir } = machine();
    writeFileSync(join(home, "Documents", "package.json"), "{}");
    writeFileSync(join(home, "Documents", "taxes", "package.json"), "{}");
    symlinkSync(join(home, "Documents", "taxes"), join(home, "code", "taxes-link"));

    // when
    const listed = await listFolders(undefined, undefined, { home, dataDir });
    const code = await listFolders(join(home, "code"), undefined, { home, dataDir });
    const searched = await listFolders(undefined, "sho", { home, dataDir });
    const documents = await listFolders(join(home, "Documents"), undefined, { home, dataDir });

    // then
    if ("refused" in listed || "refused" in code || "refused" in searched || "refused" in documents) throw new Error("refused");
    expect(listed.folders.map((f) => [f.name, f.markers])).toEqual([["code", []], ["Documents", []]]);
    expect(code.folders.find((f) => f.name === "taxes")?.markers).toEqual([]);
    expect(documents.folders.map((f) => [f.name, f.markers])).toEqual([["taxes", ["package.json"]]]);
    expect(listed.parent).toBeNull();
    expect(listed.suggestions.map((f) => f.name).sort()).toEqual(["shop", "skills"]);
    expect(code.folders.filter((f) => f.name !== "taxes").map((f) => [f.name, f.git, f.markers])).toEqual([
      ["notes", "none", []],
      ["shop", "repo", [".git", "package.json"]],
      ["skills", "none", [".claude-plugin"]],
    ]);
    expect(code.parent).toBe(home);
    expect(searched.matches?.map((f) => f.name)).toEqual(["shop"]);
  });

  it("given a folder with no project file opened before, one opened before that is now hidden behind a link out, and the project-looking folders, when the home is listed, then the one opened before comes first and the scan's follow, each once", async () => {
    // given
    const { home, dataDir, outside } = machine();
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir, tenant: "default" };
    await ctx.store.upsertRepo({ tenant: "default", id: "notes", team: "Mine", name: "notes", url: join(home, "code", "notes") });
    await ctx.store.upsertRepo({ tenant: "default", id: "gone", team: "Mine", name: "gone", url: outside });
    await ctx.store.upsertRepo({ tenant: "default", id: "shop", team: "Mine", name: "shop", url: join(home, "code", "shop") });
    const app = new Hono<OrchestratorEnv>();
    app.use("*", async (c, next) => {
      c.set("user", { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] });
      await next();
    });
    app.route("/", localFolderRoutes(ctx, home));
    vi.stubEnv("ORCHESTRATOR_MODE", "local");

    // when
    const listed = await (await app.request("/api/local/folders")).json();
    const inside = await (await app.request(`/api/local/folders?under=${encodeURIComponent(join(home, "code"))}`)).json();

    // then
    expect(listed.suggestions.map((f: { name: string }) => f.name).slice(0, 2).sort()).toEqual(["notes", "shop"]);
    expect(listed.suggestions.map((f: { name: string }) => f.name)).toHaveLength(3);
    expect(listed.suggestions.map((f: { name: string }) => f.name).at(-1)).toBe("skills");
    expect(inside.suggestions).toEqual([]);
    expect(inside.folders.map((f: { name: string }) => f.name)).toContain("notes");
  });

  it("given a hidden folder, one outside the home and one above it, when each is asked for, then each is refused rather than listed", async () => {
    const { home, dataDir, outside } = machine();
    for (const [under, refused] of [[join(home, ".ssh"), "hidden"], [outside, "outside-home"], [join(home, ".."), "outside-home"]] as const) {
      expect(await listFolders(under, undefined, { home, dataDir })).toMatchObject({ refused });
    }
  });

  it("given a local orchestrator's owner, an API key and a team's orchestrator, when each asks for the folders, then only the owner in local mode is answered", async () => {
    // given
    const { home, dataDir } = machine();
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir, tenant: "default" };
    const owner: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
    const as = (user: Principal) => {
      const app = new Hono<OrchestratorEnv>();
      app.use("*", async (c, next) => {
        c.set("user", user);
        await next();
      });
      app.route("/", localFolderRoutes(ctx, home));
      return app;
    };

    // when
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const local = await as(owner).request("/api/local/folders");
    const hidden = await as(owner).request(`/api/local/folders?under=${encodeURIComponent(join(home, ".ssh"))}`);
    const key = await as({ ...owner, key: { id: "key_1", owner: { kind: "user", id: "usr_a" }, scopes: { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" }, expiresAt: null } }).request("/api/local/folders");
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const team = await as(owner).request("/api/local/folders");

    // then
    expect(local.status).toBe(200);
    expect([hidden.status, (await hidden.json()).code]).toEqual([400, "hidden"]);
    expect([key.status, team.status]).toEqual([403, 404]);
  });
});
