import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { formatInitSuccess, initTeamRepo, loadTeamConfig, saveTeamConfig } from "./init.js";
import type { CommitMessageChoice, TeamConfig } from "./init.js";
import { joinTeamRepo } from "./join.js";
import { runDoctor } from "./doctor.js";
import type { CommandRunner } from "./doctor.js";
import { publishCandidate, publishTeamSelection, teamAssets } from "./publish.js";
import type { PublishOptions } from "./publish.js";
import { applyUpgrade, planUpgrade } from "./upgrade.js";
import type { CandidateMeta } from "./queue.js";
import type { McpServerEntry } from "./mcp.js";

// Only the scratch clones the team flow makes refuse to go: every other removal, the
// test's own cleanup included, is the real one. Mocked in a file of its own because
// vi.mock applies to the whole file.
const SCRATCH = /^handbook-(init|join|doctor|publish|index|mcp|upgrade)-/;
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (path: Parameters<typeof fs.rmSync>[0], options?: Parameters<typeof fs.rmSync>[1]) => {
      if (SCRATCH.test(basename(String(path)))) {
        throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(path)}'`), { code: "ENOTEMPTY" });
      }
      return fs.rmSync(path, options);
    },
  };
});

const APPROVED: CommitMessageChoice = { message: "chore: the case under test" };

// no gh/glab on a test machine: the branch is pushed and the link is manual
const noForge = () => {
  const err = new Error("spawn gh ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
};

/** The two runs a push takes when the branch it proposes is accepted. */
function confirmingBranch<T extends { ok: boolean; proposedBranch?: string }>(run: (options: PublishOptions) => T): T {
  const probe = run({ commitMessage: APPROVED });
  return !probe.ok && probe.proposedBranch ? run({ commitMessage: APPROVED, branch: probe.proposedBranch }) : probe;
}

function bareRepo(branch = "master"): string {
  const remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", branch, remote]);
  return remote;
}

function seededRepo(): string {
  const remote = bareRepo();
  const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
  try {
    execFileSync("git", ["-C", seed, "init", "-b", "master"]);
    writeFileSync(join(seed, "README.md"), "# our repo\n");
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", seed, "push", remote, "master"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return remote;
}

/** A team repository as init leaves it: the scaffold at this version on its default branch. */
function handbookRepo(): string {
  const remote = bareRepo("main");
  const initHome = mkdtempSync(join(tmpdir(), "handbook-test-"));
  try {
    const result = initTeamRepo(remote, "acme-skills", initHome, undefined, undefined, noForge, undefined, "", false, APPROVED);
    expect(result).toMatchObject({ ok: true, merged: true });
  } finally {
    rmSync(initHome, { recursive: true, force: true });
  }
  return remote;
}

/** What each scratch clone left behind under a handbook home: there only because removing it failed. */
function leftBehind(home: string, prefix: string): string[] {
  const tmp = join(home, "tmp");
  return existsSync(tmp) ? readdirSync(tmp).filter((name) => name.startsWith(prefix)) : [];
}

let home: string;
let remote: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  remote = "";
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (remote) rmSync(remote, { recursive: true, force: true });
});

describe("initTeamRepo when its clone cannot be removed", () => {
  it("given a scaffold that reached the remote, when the clone refuses to go, then the result and the link to open the request are still returned, and the clone left is named", () => {
    remote = seededRepo();

    const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge, undefined, "", false, APPROVED);

    expect(result).toMatchObject({ ok: true, branch: "handbook/scaffold", merged: false });
    const shown = formatInitSuccess(result);
    expect(shown).toContain("push handbook/scaffold and open a request against master");
    expect(loadTeamConfig(home)).toMatchObject({ repoUrl: remote, marketplaceName: "acme-skills" });
    expect(execFileSync("git", ["-C", remote, "branch", "--list", "handbook/scaffold"], { encoding: "utf8" })).toContain("handbook/scaffold");
    expect(result.leftoverWorkdir).toBe(join(home, "tmp", leftBehind(home, "handbook-init-")[0]!));
    expect(shown).toContain("could not remove the scratch clone at");
  });

  it("given a push the remote refuses, when the clone refuses to go as well, then the refusal is what comes back", () => {
    remote = seededRepo();
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'pushes are closed' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge, undefined, "", false, APPROVED);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("pushes are closed");
    expect(result.error).not.toContain("ENOTEMPTY");
    expect(loadTeamConfig(home)).toBeNull();
  });
});

describe("the rest of the team flow when its clone cannot be removed", () => {
  const team = (): TeamConfig => ({ repoUrl: remote, marketplaceName: "acme-skills" });
  // publish, upgrade, doctor and the asset listing clone under the default handbook home,
  // which the suite's setup points at a directory of this file's own
  const suiteHome = () => process.env.TEAMHANDBOOK_HOME!;

  it("given a team repository, when this machine joins it and the clone refuses to go, then the join still succeeds", () => {
    remote = handbookRepo();

    const result = joinTeamRepo(remote, home);

    expect(result).toMatchObject({ ok: true, name: "acme-skills" });
    expect(loadTeamConfig(home)).toMatchObject({ repoUrl: remote });
    expect(leftBehind(home, "handbook-join-")).toHaveLength(1);
  });

  it("given a team repository, when the doctor reads its distribution and the clone refuses to go, then the report still comes back", () => {
    remote = handbookRepo();
    saveTeamConfig(team(), home);
    const realGitFakeClaude: CommandRunner = (cmd, args, timeoutMs) => {
      if (cmd === "claude") return args[0] === "-p" ? "OK" : "2.1.0";
      if (cmd === "gh" || cmd === "glab") return "Logged in";
      return execFileSync(cmd, args, { encoding: "utf8", timeout: timeoutMs }).trim();
    };
    const before = leftBehind(suiteHome(), "handbook-doctor-").length;

    const report = runDoctor(home, realGitFakeClaude);

    expect(report.checks.find((c) => c.name === "team repo")?.detail).toContain("reachable");
    expect(leftBehind(suiteHome(), "handbook-doctor-").length).toBe(before + 1);
  });

  it("given a team repository, when its assets are listed and the clone refuses to go, then the listing still comes back", () => {
    remote = handbookRepo();
    const before = leftBehind(suiteHome(), "handbook-index-").length;

    const assets = teamAssets(team());

    expect(assets).toEqual({ skills: expect.any(Array), servers: expect.any(Array), commands: expect.any(Array) });
    expect(leftBehind(suiteHome(), "handbook-index-").length).toBe(before + 1);
  });

  it("given an approved skill, when it is published and the clone refuses to go, then the branch it pushed is still reported", () => {
    remote = handbookRepo();
    const candidate = mkdtempSync(join(tmpdir(), "handbook-candidate-"));
    writeFileSync(join(candidate, "SKILL.md"), "---\nname: fix-npm-test\n---\n\nBody.\n");
    const meta: CandidateMeta = {
      slug: "fix-npm-test",
      status: "pending",
      createdAt: "2026-08-08T00:00:00Z",
      scope: "team",
      description: "Use when npm test fails with a stale snapshot.",
      fingerprint: "abc123",
      sessionId: "s1",
      gate: { total: 8, scores: { recurrence: 2, generality: 2, durability: 2, findability: 1, cost: 1 } },
    };
    try {
      const result = confirmingBranch((options) => publishCandidate(candidate, meta, team(), undefined, () => "", options));

      expect(result.ok).toBe(true);
      expect(result.branch).toBeTruthy();
      expect(execFileSync("git", ["-C", remote, "branch", "--list", result.branch!], { encoding: "utf8" })).toContain(result.branch!);
      expect(leftBehind(suiteHome(), "handbook-publish-").length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }
  });

  it("given a server shared with the team, when it is published and the clone refuses to go, then the branch it pushed is still reported", () => {
    remote = handbookRepo();
    const gitlab: McpServerEntry = { name: "gitlab", scope: "user", config: { type: "http", url: "https://gitlab.com/api/v4/mcp" } };

    const result = confirmingBranch((options) => publishTeamSelection({ servers: [gitlab] }, team(), undefined, () => "", options));

    expect(result.ok).toBe(true);
    expect(result.branch).toBeTruthy();
    expect(execFileSync("git", ["-C", remote, "branch", "--list", result.branch!], { encoding: "utf8" })).toContain(result.branch!);
    expect(leftBehind(suiteHome(), "handbook-mcp-").length).toBeGreaterThanOrEqual(1);
  });

  it("given a scaffold behind this version, when the refresh is planned and applied and each clone refuses to go, then both still report what they did", () => {
    remote = handbookRepo();
    const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
    try {
      execFileSync("git", ["clone", "-q", remote, seed]);
      writeFileSync(join(seed, "README.md"), "# acme-skills\n\nan older, much shorter readme\n");
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "an older readme"]);
      execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
    const before = leftBehind(suiteHome(), "handbook-upgrade-").length;

    const plan = planUpgrade(team());
    const behind = plan.files!.filter((file) => file.state === "differs").map((file) => file.path);
    const probe = applyUpgrade(team(), behind, undefined, () => "", APPROVED);
    const result =
      !probe.ok && probe.proposedBranch
        ? applyUpgrade(team(), behind, undefined, () => "", APPROVED, { branch: probe.proposedBranch })
        : probe;

    expect(plan.ok).toBe(true);
    expect(behind).toContain("README.md");
    expect(result.ok).toBe(true);
    expect(leftBehind(suiteHome(), "handbook-upgrade-").length).toBeGreaterThanOrEqual(before + 2);
  });
});
