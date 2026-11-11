import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workFolders } from "./work-folders.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const named = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

/** A home folder with Claude Code's own folder in it and the orchestrator's data under Library. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-work-folders-")));
  dirs.push(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const dataDir = join(home, "Library", "Application Support", "TeamHandbook Orchestrator");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(claudeDir, "projects"), { recursive: true });
  return { home, claudeDir, dataDir, ownCode: join(root, "release", "orchestrator") };
}

function folder(path: string, heading?: string) {
  mkdirSync(path, { recursive: true });
  if (heading !== undefined) writeFileSync(join(path, "CLAUDE.md"), `${heading}\n\nMore words.\n`);
}

/** A Claude Code project for a folder, its one session last written `minutesAgo` ago and unreadable, so a read of it fails the test. */
function workedIn(claudeDir: string, path: string, minutesAgo: number) {
  const project = join(claudeDir, "projects", named(path));
  mkdirSync(project, { recursive: true });
  const session = join(project, "session.jsonl");
  writeFileSync(session, '{"cwd":"elsewhere"}\n');
  chmodSync(session, 0o000);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(session, at, at);
  utimesSync(project, at, at);
}

describe("the folders a task is routed among", () => {
  it("given two folders Claude Code worked in, each with a CLAUDE.md, when the pool is read, then both come by their real paths, the last used first, each with its heading, and no session is opened", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const mcp = join(home, "Documents", "dev", "mcp-servers");
    const site = join(home, "ai-native");
    folder(mcp, "# Payments MCP servers");
    folder(site, "Notes first\n## Site work");
    workedIn(claudeDir, site, 60);
    workedIn(claudeDir, mcp, 5);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.filter((f) => f.from === "claude-code")).toMatchObject([
      { path: mcp, name: "mcp-servers", about: "Payments MCP servers" },
      { path: site, name: "ai-native", about: "Site work" },
    ]);
  });

  it("given a project name whose dashes are a slash in one place and part of a name in another, when the pool is read, then the folder that is on disk is found", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const nested = join(home, "work", "shop", "api-server");
    folder(join(home, "work", "shop-api"));
    folder(nested);
    workedIn(claudeDir, nested, 1);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => f.path)).toEqual([nested]);
  });

  it("given Claude Code's history and CLAUDE.md files in the home itself, a hidden folder, an SDK, an archive, the orchestrator's data, its own checkout and a folder gone from disk, when the pool is read, then none of them is a candidate, and a folder holding that checkout among others is", async () => {
    // given
    const { home, claudeDir, dataDir } = machine();
    const checkout = join(home, "code", "teamhandbook");
    const ownCode = join(checkout, "orchestrator");
    folder(ownCode, "# The orchestrator");
    mkdirSync(join(checkout, ".git"));
    writeFileSync(join(home, "code", "CLAUDE.md"), "# All my code\n");
    const refused = [home, join(home, ".config", "tool"), join(home, "code", "google-cloud-sdk"), join(home, "Archive", "old-shop"), join(home, "go", "src", "lib"), dataDir, checkout, ownCode];
    for (const path of refused) folder(path, "# Looks like work");
    refused.forEach((path, n) => workedIn(claudeDir, path, n + 1));
    workedIn(claudeDir, join(home, "code", "gone"), 1);
    workedIn(claudeDir, join(home, "code"), 30);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => f.path)).toEqual([join(home, "code")]);
    expect(pool[0]).toMatchObject({ about: "All my code", from: "claude-code" });
  });

  it("given folders carrying a CLAUDE.md where code is kept and one in Documents Claude Code never worked in, when the pool is read, then the first are found by their CLAUDE.md and Documents is not walked", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    folder(join(home, "code", "payments"), "# Payments API");
    folder(join(home, "Projects", "blog", "theme"), "# Blog theme");
    folder(join(home, "Documents", "private"), "# Private notes");

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => [f.name, f.about, f.from]).sort()).toEqual([["payments", "Payments API", "claude-md"], ["theme", "Blog theme", "claude-md"]]);
  });

  it("given a heading that looks like it holds a secret, one too long and one with control characters, when the pool is read, then the first gives no heading, the second is cut and the third is plain text", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    folder(join(home, "code", "keys"), "# Token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    folder(join(home, "code", "long"), `# ${"word ".repeat(40)}`);
    folder(join(home, "code", "bell"), "# Ring\u0007 the bell");

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });
    const about = Object.fromEntries(pool.map((f) => [f.name, f.about]));

    // then
    expect(about.keys).toBeNull();
    expect(about.long).toHaveLength(120);
    expect(about.long?.endsWith("…")).toBe(true);
    expect(about.bell).toBe("Ring the bell");
  });

  it("given the factory's worktrees Claude Code worked in last and a folder of the person's own, when the pool is read, then only the person's own is a candidate", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const own = join(home, "code", "shop");
    folder(own, "# Shop");
    const worktree = join(home, "Documents", "development", "factory-worktrees", "deploy");
    folder(worktree, "# A factory worktree");
    workedIn(claudeDir, own, 120);
    workedIn(claudeDir, worktree, 1);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => f.path)).toEqual([own]);
  });

  it("given another worktree of the orchestrator's own repository under a path no name rule catches, when the pool is read, then it is not a candidate, while a repository of its own beside it is", async () => {
    // given
    const { home, claudeDir, dataDir } = machine();
    const main = join(home, "code", "teamhandbook");
    const ownCode = join(main, "orchestrator");
    folder(ownCode, "# The orchestrator");
    mkdirSync(join(main, ".git", "worktrees", "other"), { recursive: true });
    writeFileSync(join(main, ".git", "worktrees", "other", "commondir"), "../..\n");
    const other = join(home, "trees", "other");
    folder(join(other, "orchestrator"), "# The same repository elsewhere");
    writeFileSync(join(other, ".git"), `gitdir: ${join(main, ".git", "worktrees", "other")}\n`);
    const mine = join(home, "code", "shop");
    folder(join(mine, ".git"), "# Shop");
    workedIn(claudeDir, join(other, "orchestrator"), 1);
    workedIn(claudeDir, other, 2);
    workedIn(claudeDir, mine, 3);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => f.path)).toEqual([mine]);
  });

  it("given one folder Claude Code kept five sessions in and a newer one with one, when the pool is read, then each says how many sessions it holds from file names alone, and the newer still comes first", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const usual = join(home, "work", "mcp");
    const fresh = join(home, "code", "scratch");
    folder(usual, "# MCP servers");
    folder(fresh);
    workedIn(claudeDir, usual, 90);
    workedIn(claudeDir, fresh, 1);
    for (let n = 1; n < 5; n++) {
      const extra = join(claudeDir, "projects", named(usual), `session-${n}.jsonl`);
      writeFileSync(extra, "{}\n");
      chmodSync(extra, 0o000);
      const old = new Date(Date.now() - 90 * 60_000);
      utimesSync(extra, old, old);
    }

    const old = new Date(Date.now() - 90 * 60_000);
    utimesSync(join(claudeDir, "projects", named(usual)), old, old);

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => [f.name, f.sessions])).toEqual([["scratch", 1], ["mcp", 5]]);
  });

  it("given the folder used most is older than twenty-five newer ones, when the pool is read, then it is still there with its sessions", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const usual = join(home, "work", "mcp");
    folder(usual, "# MCP servers");
    workedIn(claudeDir, usual, 5000);
    for (let n = 1; n < 6; n++) {
      const extra = join(claudeDir, "projects", named(usual), `session-${n}.jsonl`);
      writeFileSync(extra, "{}\n");
      chmodSync(extra, 0o000);
    }
    const old = new Date(Date.now() - 5000 * 60_000);
    for (let n = 1; n < 6; n++) utimesSync(join(claudeDir, "projects", named(usual), `session-${n}.jsonl`), old, old);
    utimesSync(join(claudeDir, "projects", named(usual)), old, old);
    for (let n = 0; n < 25; n++) {
      folder(join(home, "code", `repo${n}`));
      workedIn(claudeDir, join(home, "code", `repo${n}`), n + 1);
    }

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool).toHaveLength(21);
    expect(pool.find((f) => f.path === usual)).toMatchObject({ name: "mcp", sessions: 6 });
  });

  it("given a folder added in Settings that is old, outside the usual roots and behind twenty newer ones, when the pool is read, then it is still there, named as added", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    const added = join(home, "elsewhere", "legacy");
    folder(added);
    const old = new Date(Date.now() - 400 * 24 * 3600_000);
    utimesSync(added, old, old);
    for (let n = 0; n < 25; n++) {
      folder(join(home, "code", `repo${n}`));
      workedIn(claudeDir, join(home, "code", `repo${n}`), n + 1);
    }

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode, opened: [added] });

    // then
    expect(pool).toHaveLength(21);
    expect(pool.find((f) => f.path === added)).toMatchObject({ name: "legacy", from: "added" });
  });

  it("given thirty folders Claude Code worked in, when the pool is read, then it holds the twenty used last", async () => {
    // given
    const { home, claudeDir, dataDir, ownCode } = machine();
    for (let n = 0; n < 30; n++) {
      folder(join(home, "code", `repo${n}`));
      workedIn(claudeDir, join(home, "code", `repo${n}`), n + 1);
    }

    // when
    const pool = await workFolders({ home, dataDir, claudeDir, ownCode });

    // then
    expect(pool.map((f) => f.name)).toEqual(Array.from({ length: 20 }, (_, n) => `repo${n}`));
  });
});
