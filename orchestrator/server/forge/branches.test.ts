import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { RepoRecord } from "../store.js";
import { repoBranches } from "./branches.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A repository on main with a commit on develop after one on an older feature branch, and a branch whose name git would read as an option. */
function seeded(root: string): string {
  const repo = join(root, "service");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "service\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "main", "--date", "2026-11-01T10:00:00Z");
  for (const [branch, at] of [["feature/old", "2026-11-02T10:00:00Z"], ["develop", "2026-11-03T10:00:00Z"]] as const) {
    git(repo, "switch", "-q", "-c", branch, "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", branch, "--date", at);
    execFileSync("git", [...IDENTITY, "commit", "-q", "--amend", "--no-edit", "--allow-empty"], { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: at } });
  }
  git(repo, "switch", "-q", "main");
  git(repo, "update-ref", "refs/heads/-x", "HEAD");
  return repo;
}

const repoAt = (url: string, head: string | null = "a".repeat(40)) => ({ tenant: "acme", id: "service", team: "Payments", name: "service", url, head }) as unknown as RepoRecord;

describe("the branches a task can start from", () => {
  it("given a repository read by path with its own branches and one only on its origin, when they are read, then the checked out branch comes first as the default, then the clone's own by their last commit, none only on the origin and none git would take as an option", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "branches-"));
    roots.push(root);
    const origin = seeded(root);
    const clone = join(root, "clone");
    git(root, "clone", "-q", origin, clone);
    git(clone, "update-ref", "refs/remotes/origin/release", "refs/remotes/origin/develop");
    git(clone, "branch", "-q", "develop", "origin/develop");
    git(clone, "branch", "-q", "feature/old", "origin/feature/old");

    // when
    const read = await repoBranches({ dataDir: join(root, "data"), tenant: "acme" } as OrchestratorContext, repoAt(`file://${clone}`));

    // then
    expect(read?.default).toBe("main");
    expect(read?.branches[0]).toBe("main");
    expect(new Set(read?.branches)).toEqual(new Set(["main", "develop", "feature/old"]));
    expect(read?.branches.indexOf("develop")).toBeLessThan(read!.branches.indexOf("feature/old"));
  });

  it("given a repository the orchestrator mirrors, one not read yet, and a folder on a machine, when their branches are read, then the mirror's branches come back with its default and the others have none here", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "branches-"));
    roots.push(root);
    const ctx = { dataDir: join(root, "data"), tenant: "acme" } as OrchestratorContext;
    const origin = seeded(root);
    mkdirSync(join(root, "data", "mirrors", "acme"), { recursive: true });
    git(root, "clone", "-q", "--mirror", origin, mirrorDir(ctx, "service"));

    // when
    const mirrored = await repoBranches(ctx, repoAt("https://git.example.invalid/acme/service.git"));
    const unread = await repoBranches(ctx, repoAt("https://git.example.invalid/acme/service.git", null));
    const onMachine = await repoBranches(ctx, repoAt("machine:mch_1:~/service"));

    // then
    expect(mirrored).toEqual({ default: "main", branches: ["main", "develop", "feature/old"] });
    expect([unread, onMachine]).toEqual([null, null]);
  });
});
