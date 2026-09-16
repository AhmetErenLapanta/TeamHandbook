import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bumpPluginVersion,
  buildMcpPrBody,
  buildPrBody,
  buildPrTitle,
  formatMcpShareResult,
  manualPrUrl,
  publishCandidate,
  publishMcpServer,
  retryBranchAfterNameRejection,
} from "./publish.js";
import { auditServer } from "./mcp.js";
import type { McpServerEntry } from "./mcp.js";
import { runGit } from "./init.js";
import type { GitRunner } from "./init.js";
import type { CandidateMeta } from "./queue.js";
import type { GroundedCase } from "./distill.js";

let candidateDir: string;
let remote: string;

function meta(overrides: Partial<CandidateMeta> = {}): CandidateMeta {
  return {
    slug: "fix-npm-test",
    status: "pending",
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "Use when npm test fails with a stale snapshot.",
    fingerprint: "abc123",
    sessionId: "s1",
    gate: { total: 8, scores: { recurrence: 2, generality: 2, durability: 2, findability: 1, cost: 1 } },
    ...overrides,
  };
}

function groundedCase(): GroundedCase {
  return {
    fingerprint: "abc123",
    capturedAt: "2026-08-08T00:00:00Z",
    command: "npm test",
    error: "snapshot mismatch in foo.test.ts",
    resolvedCommand: "npm test -- -u",
    edits: ["src/foo.ts"],
    expect: "npm test exits 0 after updating the snapshot",
    gate: { total: 8, scores: { recurrence: 2 } },
  };
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function teamRepo(seedSkillDirs: string[] = [], seedFiles: Record<string, string> = {}): string {
  const bare = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
  try {
    execFileSync("git", ["clone", bare, join(seed, "repo")], { stdio: "ignore" });
    const repo = join(seed, "repo");
    mkdirSync(join(repo, "skills"), { recursive: true });
    writeFileSync(join(repo, "skills", "README.md"), "skills\n");
    for (const dir of seedSkillDirs) {
      mkdirSync(join(repo, "skills", dir), { recursive: true });
      writeFileSync(join(repo, "skills", dir, "SKILL.md"), "occupied\n");
    }
    for (const [path, content] of Object.entries(seedFiles)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    gitIn(repo, ["add", "-A"]);
    gitIn(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    gitIn(repo, ["push", "origin", "main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return bare;
}

beforeEach(() => {
  candidateDir = mkdtempSync(join(tmpdir(), "handbook-candidate-"));
  writeFileSync(join(candidateDir, "SKILL.md"), "---\nname: fix-npm-test\n---\n\nBody.\n");
  writeFileSync(join(candidateDir, "grounded-case.json"), JSON.stringify(groundedCase()) + "\n");
  remote = "";
});

afterEach(() => {
  rmSync(candidateDir, { recursive: true, force: true });
  if (remote) rmSync(remote, { recursive: true, force: true });
});

describe("bumpPluginVersion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "handbook-bump-"));
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("given a skill is being published, when the version is bumped, then teammates have something to fetch", () => {
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme", version: "0.1.0" }));

    expect(bumpPluginVersion(dir)).toBe("0.1.1");
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")).version).toBe("0.1.1");
  });

  it("given the scaffold has not been merged yet, when bumping, then publishing still goes ahead", () => {
    expect(bumpPluginVersion(dir)).toBeNull();
  });

  it("given a version that is not three numbers, when bumping, then it is left alone rather than mangled", () => {
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme", version: "next" }));

    expect(bumpPluginVersion(dir)).toBeNull();
  });
});

describe("buildPrTitle / buildPrBody", () => {
  it("includes the description, scope, gate score, and grounded case", () => {
    expect(buildPrTitle("fix-npm-test")).toBe("feat(skill): add fix-npm-test");
    const body = buildPrBody(meta(), groundedCase());
    expect(body).toContain("Use when npm test fails with a stale snapshot.");
    expect(body).toContain("scope: `team`");
    expect(body).toContain("gate score: 8/10");
    expect(body).toContain("recurrence 2");
    expect(body).toContain("failed command: `npm test`");
    expect(body).toContain("resolving command: `npm test -- -u`");
    expect(body).toContain("expect: npm test exits 0 after updating the snapshot");
  });

  it("degrades gracefully without a gate result or grounded case", () => {
    const body = buildPrBody(meta({ gate: null }), null);
    expect(body).toContain("gate score: n/a");
    expect(body).not.toContain("Grounded case");
  });
});

describe("manualPrUrl", () => {
  it("builds a GitHub new-PR link for github hosts and a GitLab one otherwise", () => {
    expect(manualPrUrl("git@github.com:acme/skills.git", "handbook/x")).toBe(
      "https://github.com/acme/skills/pull/new/handbook/x",
    );
    expect(manualPrUrl("git@gitlab.acme.com:team/skills.git", "handbook/x")).toBe(
      "https://gitlab.acme.com/team/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=handbook%2Fx",
    );
    expect(manualPrUrl("nonsense", "handbook/x")).toBeNull();
  });
});

describe("publishCandidate", () => {
  it("pushes a handbook/<slug> branch with the artifact and returns the forge PR URL", () => {
    remote = teamRepo();
    const forgeCalls: string[][] = [];
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      (tool, args) => {
        forgeCalls.push([tool, ...args]);
        return "https://gitlab.acme.com/team/skills/-/merge_requests/7\n";
      },
    );
    expect(result).toMatchObject({
      ok: true,
      branch: "handbook/fix-npm-test",
      prUrl: "https://gitlab.acme.com/team/skills/-/merge_requests/7",
    });
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", "handbook/fix-npm-test"]);
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(files).toContain("skills/fix-npm-test/grounded-case.json");
    expect(forgeCalls[0]![0]).toBe("glab");
    expect(forgeCalls[0]).toContain("handbook/fix-npm-test");
  });

  it("suffixes the slug when the team repo already has that skill directory", () => {
    remote = teamRepo(["fix-npm-test"]);
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
    );
    expect(result.branch).toBe("handbook/fix-npm-test-2");
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", "handbook/fix-npm-test-2"]);
    expect(files).toContain("skills/fix-npm-test-2/SKILL.md");
  });

  it("still succeeds with a manual link when the forge CLI fails", () => {
    remote = teamRepo();
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "t" },
      (args, cwd) => {
        // clone from the local bare repo regardless of the configured SSH URL
        const rewritten = args.map((a) => (a === "git@gitlab.acme.com:team/skills.git" ? remote : a));
        execFileSync("git", rewritten, { cwd, stdio: "ignore" });
      },
      () => {
        throw new Error("glab: command not found");
      },
    );
    expect(result).toMatchObject({
      ok: true,
      branch: "handbook/fix-npm-test",
      manualUrl:
        "https://gitlab.acme.com/team/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=handbook%2Ffix-npm-test",
    });
    expect(result.prUrl).toBeUndefined();
    // the reason the auto-PR was skipped is surfaced, not swallowed
    expect(result.prError).toContain("command not found");
  });

  it("pins the ambient git identity onto the commit so the PR is not junk-authored", () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === "config" && args[1] === "user.email") return "me@example.com\n";
      if (args[0] === "config" && args[1] === "user.name") return "Me Dev\n";
      return "";
    };
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: "https://gitlab.acme.com/team/skills.git", marketplaceName: "t" },
      recordingGit,
      () => "https://example.com/mr/9",
    );
    expect(result.ok).toBe(true);
    const commit = calls.find((c) => c.includes("commit"))!;
    // identity is pinned with -c (the freshly cloned repo has none of its own) and
    // precedes the commit subcommand
    expect(commit.slice(0, 4)).toEqual(["-c", "user.name=Me Dev", "-c", "user.email=me@example.com"]);
    expect(commit.indexOf("user.email=me@example.com")).toBeLessThan(commit.indexOf("commit"));
  });

  it("blocks the publish when git identity is unset rather than shipping a junk author", () => {
    const unsetGit: GitRunner = (args) => {
      // git config exits non-zero when a key is unset
      if (args[0] === "config") throw new Error("exit status 1");
      return "";
    };
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: "https://gitlab.acme.com/team/skills.git", marketplaceName: "t" },
      unsetGit,
      () => "https://example.com/mr/9",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("user.name/user.email is not set");
  });

  it("publishes a candidate whose grounded-case.json is malformed, omitting the case from the body", () => {
    remote = teamRepo();
    writeFileSync(join(candidateDir, "grounded-case.json"), '{"fingerprint":"abc123"}\n');
    const bodies: string[] = [];
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      (tool, args) => {
        bodies.push(args.join(" "));
        return "https://example.com/mr/2";
      },
    );
    expect(result.ok).toBe(true);
    expect(bodies[0]).not.toContain("Grounded case");
  });

  it("fails without a branch when the clone target is unreachable", () => {
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: join(candidateDir, "missing.git"), marketplaceName: "t" },
      undefined,
      () => "",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("git clone failed");
  });

  it("suffixes past a stale remote branch instead of locking the slug", () => {
    remote = teamRepo();
    const divergent = mkdtempSync(join(tmpdir(), "handbook-divergent-"));
    try {
      execFileSync("git", ["clone", remote, join(divergent, "repo")], { stdio: "ignore" });
      const repo = join(divergent, "repo");
      gitIn(repo, ["checkout", "-b", "handbook/fix-npm-test"]);
      writeFileSync(join(repo, "other.txt"), "divergent\n");
      gitIn(repo, ["add", "-A"]);
      gitIn(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "divergent"]);
      gitIn(repo, ["push", "origin", "handbook/fix-npm-test"]);
    } finally {
      rmSync(divergent, { recursive: true, force: true });
    }
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "",
    );
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("handbook/fix-npm-test-2");
  });

  it("fails with the rule that refused the push, not just the fact that it failed", () => {
    remote = teamRepo();
    const failingGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") throw new Error("git push failed: remote: protected branch");
      return runGit(args, cwd);
    };
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      failingGit,
      () => "",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("protected");
    expect(result.error).toContain("refused the push");
  });
});

describe("retryBranchAfterNameRejection", () => {
  const pattern = "((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$";
  const rejection = new Error(
    `git push failed: remote: GitLab: Branch name 'handbook/fix-npm-test' does not follow the pattern '${pattern}'`,
  );
  const team = { repoUrl: "git@gitlab.com:acme/qa.git", marketplaceName: "qa", commitPrefix: "HQA-000" };

  it("given the team's own commit prefix, when the branch name is refused, then it is reused for the branch", () => {
    const retry = retryBranchAfterNameRejection(rejection, team, "fix-npm-test");

    expect(retry).toEqual({ branch: "HQA-000-fix-npm-test", prefix: "HQA-000-" });
  });

  it("given a slug already suffixed past a collision, when derived, then the name still satisfies the rule", () => {
    const retry = retryBranchAfterNameRejection(rejection, team, "fix-npm-test-2");

    expect(retry).toEqual({ branch: "HQA-000-fix-npm-test-2", prefix: "HQA-000-" });
  });

  it("given no commit prefix to derive from, when the branch name is refused, then nothing is invented", () => {
    const retry = retryBranchAfterNameRejection(rejection, { ...team, commitPrefix: undefined }, "fix-npm-test");

    expect(retry).toBeNull();
  });

  it("given a derived name the pattern still rejects, when checked, then it is not pushed", () => {
    const refusesEverything = new Error(
      "git push failed: remote: GitLab: Branch name 'handbook/x' does not follow the pattern '^release/.+$'",
    );

    expect(retryBranchAfterNameRejection(refusesEverything, team, "fix-npm-test")).toBeNull();
  });

  it("given the commit MESSAGE was refused, when classified, then the branch name is left alone", () => {
    const commitRule = new Error(
      "git push failed: remote: GitLab: Commit message does not follow the pattern '^HQA-\\d+'",
    );

    expect(retryBranchAfterNameRejection(commitRule, team, "fix-npm-test")).toBeNull();
  });

  it("given an unparseable pattern, when evaluated, then the rule is reported instead of guessed at", () => {
    const broken = new Error(
      "git push failed: remote: GitLab: Branch name 'handbook/x' does not follow the pattern '([unclosed'",
    );

    expect(retryBranchAfterNameRejection(broken, team, "fix-npm-test")).toBeNull();
  });
});

describe("publishCandidate — a forge that polices branch names", () => {
  it("given the default branch name is refused, when publishing, then it retries under the team's prefix and reports it", () => {
    remote = teamRepo();
    let pushes = 0;
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        pushes += 1;
        if (pushes === 1) {
          throw new Error(
            "git push failed: remote: GitLab: Branch name 'handbook/fix-npm-test' does not follow the " +
              "pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'\n" +
              "To gitlab.com:acme/qa-handbook.git\n" +
              " ! [remote rejected] handbook/fix-npm-test -> handbook/fix-npm-test (pre-receive hook declined)\n" +
              "error: failed to push some refs to 'gitlab.com:acme/qa-handbook.git'",
          );
        }
      }
      return runGit(args, cwd);
    };

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t", commitPrefix: "HQA-000" },
      policedGit,
      () => "",
    );

    expect(result.ok).toBe(true);
    expect(result.branch).toBe("HQA-000-fix-npm-test");
    expect(result.learnedBranchPrefix).toBe("HQA-000-");
    expect(pushes).toBe(2);
  });

  it("given nothing to derive a prefix from, when the branch name is refused, then the rule and the fix are reported", () => {
    remote = teamRepo();
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        throw new Error(
          "git push failed: remote: GitLab: Branch name 'handbook/fix-npm-test' does not follow the " +
            "pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'",
        );
      }
      return runGit(args, cwd);
    };

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      policedGit,
      () => "",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the branch NAME");
    expect(result.error).toContain("branchPrefix");
  });
});

describe("publishMcpServer", () => {
  const gitlab: McpServerEntry = {
    name: "gitlab",
    scope: "user",
    config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
  };
  const pluginJson = JSON.stringify({ name: "acme", version: "0.1.0" }, null, 2) + "\n";

  it("given the team repo already declares a server, when another is shared, then theirs survives and the version rises in the same commit", () => {
    remote = teamRepo([], {
      ".claude-plugin/plugin.json": pluginJson,
      ".mcp.json": JSON.stringify({ mcpServers: { linear: { type: "sse", url: "https://mcp.linear.app/sse" } } }, null, 2) + "\n",
    });

    const result = publishMcpServer(gitlab, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/3");

    expect(result).toMatchObject({ ok: true, branch: "handbook/mcp-gitlab", version: "0.1.1" });
    const declared = JSON.parse(gitIn(remote, ["show", "handbook/mcp-gitlab:.mcp.json"]));
    expect(declared.mcpServers.linear).toEqual({ type: "sse", url: "https://mcp.linear.app/sse" });
    expect(declared.mcpServers.gitlab).toEqual(gitlab.config);
    // the server and the version signal travel as one commit, in either order: a merged
    // server whose version did not move reaches nobody
    const touched = gitIn(remote, ["show", "--name-only", "--format=", "handbook/mcp-gitlab"]);
    expect(touched).toContain(".mcp.json");
    expect(touched).toContain(".claude-plugin/plugin.json");
    expect(JSON.parse(gitIn(remote, ["show", "handbook/mcp-gitlab:.claude-plugin/plugin.json"])).version).toBe("0.1.1");
  });

  it("given a team repo with no .mcp.json at all, when a server is shared, then the file is created in the shape Claude Code loads", () => {
    remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });

    const result = publishMcpServer(gitlab, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/4");

    expect(result.ok).toBe(true);
    expect(JSON.parse(gitIn(remote, ["show", "handbook/mcp-gitlab:.mcp.json"]))).toEqual({
      mcpServers: { gitlab: gitlab.config },
    });
  });

  it("given a forge that polices names, when a server is shared, then the branch and the commit both carry the team's prefix", () => {
    remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });

    const result = publishMcpServer(
      gitlab,
      { repoUrl: remote, marketplaceName: "acme", branchPrefix: "TEAM-1-", commitPrefix: "TEAM-1" },
      undefined,
      () => "https://example.com/mr/5",
    );

    expect(result).toMatchObject({ ok: true, branch: "TEAM-1-mcp-gitlab" });
    expect(gitIn(remote, ["log", "-1", "--format=%s", "TEAM-1-mcp-gitlab"]).startsWith("TEAM-1 ")).toBe(true);
  });

  it("given a server carrying a credential, when it is shared, then git is never run at all", () => {
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };

    const result = publishMcpServer(
      {
        name: "acme-api",
        scope: "user",
        config: { type: "http", url: "https://api.acme.com/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" } },
      },
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "acme" },
      recordingGit,
      () => "https://example.com/mr/6",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("headers.Authorization");
    // the credential never reached a clone, an index, or a working tree: the refusal
    // happens before the first git call, not after the commit
    expect(calls).toEqual([]);
  });

  it("given the team already declares that name, when it is shared, then nothing is pushed over theirs", () => {
    remote = teamRepo([], {
      ".claude-plugin/plugin.json": pluginJson,
      ".mcp.json": JSON.stringify({ mcpServers: { gitlab: { type: "http", url: "https://gitlab.acme.com/api/v4/mcp" } } }) + "\n",
    });

    const result = publishMcpServer(gitlab, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/7");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already declares");
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("mcp-gitlab");
  });
});

describe("buildMcpPrBody / formatMcpShareResult", () => {
  const stdio: McpServerEntry = {
    name: "playwright",
    scope: "project",
    config: { command: "npx", args: ["@playwright/mcp@latest"], env: { PW_TOKEN: "${PW_TOKEN}" } },
  };

  it("given a server that starts a process, when the request is written, then the reviewer sees the exact command", () => {
    const body = buildMcpPrBody(stdio, auditServer(stdio.config));

    expect(body).toContain("- command: `npx @playwright/mcp@latest`");
    expect(body).toContain("starts a process");
    expect(body).toContain("`PW_TOKEN`");
  });

  it("given a body that reports the check, when it is read, then it claims only what was verified", () => {
    const body = buildMcpPrBody(stdio, auditServer(stdio.config));

    expect(body).toContain("## What was checked");
    // the claim stays inside the check: an unconditional "no credential travels" told the
    // one human control in this flow to stop looking
    expect(body).not.toContain("No credential travels");
    expect(body).toContain("narrower claim");
    expect(body).toContain("heuristic");
    expect(body).toContain("`args` is not");
  });

  it("given the request is open, when the result is reported, then the local server is named as still present", () => {
    const text = formatMcpShareResult(
      { ok: true, serverName: "gitlab", branch: "handbook/mcp-gitlab", prUrl: "https://example.com/mr/3", version: "0.1.1" },
      "acme",
    );

    expect(text).toContain("plugin:acme:gitlab");
    expect(text).toContain("never writes to ~/.claude.json");
    expect(text).toContain("0.1.1");
  });
});

describe("publishCandidate carries the whole skill", () => {
  it("given a candidate with scripts and references, when it is shared, then they reach the team repo", () => {
    // 7 of 21 skills measured on a real machine carry working parts next to SKILL.md;
    // a two-file copy would put a skill in the team repo that cannot run
    mkdirSync(join(candidateDir, "scripts"), { recursive: true });
    mkdirSync(join(candidateDir, "references"), { recursive: true });
    writeFileSync(join(candidateDir, "preflight.sh"), "#!/bin/sh\necho ready\n");
    writeFileSync(join(candidateDir, "scripts", "server.cjs"), "module.exports = {};\n");
    writeFileSync(join(candidateDir, "references", "queries.sql"), "select 1;\n");
    remote = teamRepo();

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
    );

    expect(result.ok).toBe(true);
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!]).split("\n");
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(files).toContain("skills/fix-npm-test/grounded-case.json");
    expect(files).toContain("skills/fix-npm-test/preflight.sh");
    expect(files).toContain("skills/fix-npm-test/scripts/server.cjs");
    expect(files).toContain("skills/fix-npm-test/references/queries.sql");
  });

  it("given an ordinary harvest candidate, when it is shared, then only its two files go out", () => {
    // the pre-existing behaviour, pinned: a general copy must not start shipping more
    remote = teamRepo();

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
    );

    expect(result.ok).toBe(true);
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!])
      .split("\n")
      .filter((f) => f.startsWith("skills/fix-npm-test/"));
    expect(files.sort()).toEqual([
      "skills/fix-npm-test/SKILL.md",
      "skills/fix-npm-test/grounded-case.json",
    ]);
  });

  it("given a candidate.json in the candidate dir, when it is shared, then it stays out of the team repo", () => {
    // candidate.json carries the session id and the absolute cwd of the machine the
    // lesson was captured on; writeFileAtomic can also leave a .tmp- sibling behind
    writeFileSync(join(candidateDir, "candidate.json"), JSON.stringify(meta()) + "\n");
    writeFileSync(join(candidateDir, "candidate.json.tmp-123-0-abc"), "torn write\n");
    remote = teamRepo();

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
    );

    expect(result.ok).toBe(true);
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!]);
    expect(files).not.toContain("candidate.json");
  });

  it("given a suffixed slug, when it is shared, then the extra files follow it under the new name", () => {
    writeFileSync(join(candidateDir, "preflight.sh"), "#!/bin/sh\necho ready\n");
    remote = teamRepo(["fix-npm-test"]);

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
    );

    expect(result.ok).toBe(true);
    expect(result.skillDir).toBe("skills/fix-npm-test-2");
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!]).split("\n");
    expect(files).toContain("skills/fix-npm-test-2/preflight.sh");
  });
});

