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
  buildSelectionPrBody,
  manualPrUrl,
  publishCandidate as publishCandidateDeciding,
  publishTeamSelection as publishTeamSelectionDeciding,
} from "./publish.js";
import type { PublishOptions } from "./publish.js";
import { auditServer } from "./mcp.js";
import type { McpServerEntry } from "./mcp.js";
import { runGit, TEAM_PREFIX_FILE } from "./init.js";
import type { CommitMessageChoice, GitRunner, TeamConfig } from "./init.js";
import type { CandidateMeta } from "./queue.js";
import type { GroundedCase } from "./distill.js";


/**
 * The answer every case below gives about its commit message, because none of them is
 * about the wording: a plain sentence of the user's own. It carries no team prefix, so the
 * cases that measure the prefix still measure it. Delegating instead would cost every one
 * of them a second run, since "you decide" has to name the proposal it was shown.
 */
const APPROVED = { message: "chore: the case under test" } as const;

/**
 * The two runs a push takes when the user confirms the branch it proposes: the first shows
 * the name and pushes nothing, the second names it back. A case that names its own branch
 * pays one run, like a case that gives its own message.
 */
function confirmingBranch<T extends { ok: boolean; proposedBranch?: string }>(
  options: PublishOptions,
  run: (options: PublishOptions) => T,
): T {
  if (options.branch !== undefined) return run(options);
  const probe = run(options);
  return !probe.ok && probe.proposedBranch ? run({ ...options, branch: probe.proposedBranch }) : probe;
}

type CandidateArgs = Parameters<typeof publishCandidateDeciding>;
function publishCandidate(
  dir: CandidateArgs[0],
  meta: CandidateArgs[1],
  team: CandidateArgs[2],
  git?: CandidateArgs[3],
  forge?: CandidateArgs[4],
  options: PublishOptions = {},
) {
  return confirmingBranch({ commitMessage: APPROVED, ...options }, (o) =>
    publishCandidateDeciding(dir, meta, team, git, forge, o),
  );
}

/**
 * The two runs a delegated wording takes, which is what the product requires of anyone who
 * answers "you decide": the first shows the sentence and commits nothing, the second names
 * its fingerprint back. The cases below use it where what they measure IS the derived
 * title reaching the commit; everywhere else a case gives its own message and pays one run.
 */
function delegating<T extends { proposalHash?: string }>(run: (choice: CommitMessageChoice) => T): T {
  const probe = run({});
  return run({ delegated: probe.proposalHash! });
}

type SelectionArgs = Parameters<typeof publishTeamSelectionDeciding>;
function publishTeamSelection(
  selection: SelectionArgs[0],
  team: SelectionArgs[1],
  git?: SelectionArgs[2],
  forge?: SelectionArgs[3],
  options: PublishOptions = {},
) {
  return confirmingBranch({ commitMessage: APPROVED, ...options }, (o) =>
    publishTeamSelectionDeciding(selection, team, git, forge, o),
  );
}

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
  it("pushes the confirmed branch with the artifact and returns the forge PR URL", () => {
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
      branch: "fix-npm-test",
      prUrl: "https://gitlab.acme.com/team/skills/-/merge_requests/7",
    });
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", "fix-npm-test"]);
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(files).toContain("skills/fix-npm-test/grounded-case.json");
    const opened = forgeCalls.find((call) => call.includes("create"))!;
    expect(opened[0]).toBe("glab");
    expect(opened).toContain("fix-npm-test");
  });

  // Was: "suffixes the slug when the team repo already has that skill directory". The
  // suffix was a tested preference, and what the test could not see is that nothing ever
  // told the publisher about it: the CLI printed the name they had typed. So the preference
  // is inverted rather than deleted, and the name of this test carries the reason.
  it("refuses instead of suffixing when the team already has that skill, because the suffix was never reported to the publisher", () => {
    // given a team repository that already has a skill by this name
    remote = teamRepo(["fix-npm-test"]);

    // when the candidate is published under its own name
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
    );

    // then nothing was written, and the refusal names both ways forward
    expect(result.ok).toBe(false);
    expect(result.collision).toEqual({ kind: "skill", name: "fix-npm-test" });
    expect(result.error).toContain('already has a skill named "fix-npm-test"');
    expect(result.error).toContain("--update");
    expect(result.error).toContain("--as");
    expect(gitIn(remote, ["branch", "--list"]).replace(/[*\s]/g, "")).toBe("main");
    expect(gitIn(remote, ["show", "main:skills/fix-npm-test/SKILL.md"])).toBe("occupied\n");
  });

  it("sends the skill as an update to the team's own copy when the publisher answers the refusal with --update", () => {
    // given the same collision, and a publisher who was shown it and asked for an update
    remote = teamRepo(["fix-npm-test"]);

    // when they approve again with --update
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
      { update: true },
    );

    // then it goes out under the name it collided with, as a rewrite of theirs
    expect(result).toMatchObject({
      ok: true,
      skillDir: "skills/fix-npm-test",
      skillSlug: "fix-npm-test",
      updatedExisting: true,
    });
    expect(gitIn(remote, ["show", `${result.branch}:skills/fix-npm-test/SKILL.md`])).toContain("Body.");
    expect(gitIn(remote, ["show", `${result.branch}:skills/fix-npm-test/SKILL.md`])).not.toContain("occupied");
  });

  it("publishes under the name the publisher chose when they answer the refusal with --as", () => {
    // given the same collision, answered with a different name instead
    remote = teamRepo(["fix-npm-test"]);

    // when the candidate is published as something else
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
      { as: "fix-npm-snapshot" },
    );

    // then both skills exist, and the new one's frontmatter matches its directory
    expect(result).toMatchObject({ ok: true, skillDir: "skills/fix-npm-snapshot", skillSlug: "fix-npm-snapshot" });
    expect(result.updatedExisting).toBeUndefined();
    expect(gitIn(remote, ["show", `${result.branch}:skills/fix-npm-snapshot/SKILL.md`])).toContain(
      "name: fix-npm-snapshot",
    );
    expect(gitIn(remote, ["show", `${result.branch}:skills/fix-npm-test/SKILL.md`])).toBe("occupied\n");
  });

  it("refuses a chosen name the team also has, rather than suffixing past the second one too", () => {
    // given both names taken
    remote = teamRepo(["fix-npm-test", "fix-npm-snapshot"]);

    // when the publisher picks the one that is also occupied
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "",
      { as: "fix-npm-snapshot" },
    );

    // then the same answer comes back for the name they chose
    expect(result.ok).toBe(false);
    expect(result.collision).toEqual({ kind: "skill", name: "fix-npm-snapshot" });
  });

  it("keeps the skill's own name when only an abandoned handbook branch is in the way, and pushes past the branch", () => {
    // given a branch left behind by an earlier approve whose request was never merged,
    // and NO skills/ directory for it: the two used to be one check, and the branch
    // silently renamed the skill
    remote = teamRepo();
    gitIn(remote, ["branch", "fix-npm-test", "main"]);

    // when the candidate is published
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
    );

    // then the skill keeps the name it asked for, and only the PROPOSED branch steps aside -
    // which is the guard that stops the push being rejected non-fast-forward and the slug
    // being locked for good
    expect(result).toMatchObject({ ok: true, skillDir: "skills/fix-npm-test", branch: "fix-npm-test-2" });
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", "fix-npm-test-2"]);
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(files).not.toContain("skills/fix-npm-test-2/SKILL.md");
    expect(gitIn(remote, ["show", "fix-npm-test-2:skills/fix-npm-test/SKILL.md"])).toContain(
      "name: fix-npm-test",
    );
  });

  it("refuses a branch the user named when the repository already has it, rather than suffixing it", () => {
    // given the branch an earlier approve left behind, and a publisher who names it
    remote = teamRepo();
    gitIn(remote, ["branch", "TEAM-12", "main"]);

    // when the candidate is published under that exact name
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
      { branch: "TEAM-12" },
    );

    // then nothing is pushed, no other name is picked, and the question comes back with it
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already has a branch named "TEAM-12"');
    expect(result.error).toContain("Branch `TEAM-12` - confirm or change it.");
    expect(result.proposedBranch).toBe("TEAM-12");
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("TEAM-12-2");
  });

  it("still finds a free branch for an update whose first attempt left a branch behind", () => {
    // given the team has the skill AND the branch from the approve that put it there
    remote = teamRepo(["fix-npm-test"]);
    gitIn(remote, ["branch", "fix-npm-test", "main"]);

    // when the publisher sends an update
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      undefined,
      () => "https://example.com/mr/1",
      { update: true },
    );

    // then the directory is the one being updated and the branch is a new one: the
    // slug-lock guard survives --update, which is the case that needs it most
    expect(result).toMatchObject({
      ok: true,
      skillDir: "skills/fix-npm-test",
      updatedExisting: true,
      branch: "fix-npm-test-2",
    });
  });

  it("still succeeds with a manual link when the forge CLI fails", () => {
    remote = teamRepo();
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "t" },
      // clone from the local bare repo regardless of the configured SSH URL; real git
      // otherwise, so the push options a local repository refuses are refused as they would
      // be by any server that is not GitLab
      (args, cwd) => runGit(args.map((a) => (a === "git@gitlab.acme.com:team/skills.git" ? remote : a)), cwd),
      () => {
        throw new Error("glab: command not found");
      },
    );
    expect(result).toMatchObject({
      ok: true,
      branch: "fix-npm-test",
      manualUrl:
        "https://gitlab.acme.com/team/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix-npm-test",
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
      gitIn(repo, ["checkout", "-b", "fix-npm-test"]);
      writeFileSync(join(repo, "other.txt"), "divergent\n");
      gitIn(repo, ["add", "-A"]);
      gitIn(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "divergent"]);
      gitIn(repo, ["push", "origin", "fix-npm-test"]);
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
    expect(result.branch).toBe("fix-npm-test-2");
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

describe("publishCandidate - a forge that polices branch names", () => {
  it("given the branch name is refused, when publishing, then nothing is retried and the forge's sentence comes back with the question", () => {
    remote = teamRepo();
    let pushes = 0;
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        pushes += 1;
        throw new Error(
          "git push failed: remote: GitLab: Branch name 'fix-npm-test' does not follow the " +
            "pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'\n" +
            "To gitlab.com:acme/qa-handbook.git\n" +
            " ! [remote rejected] fix-npm-test -> fix-npm-test (pre-receive hook declined)\n" +
            "error: failed to push some refs to 'gitlab.com:acme/qa-handbook.git'",
        );
      }
      return runGit(args, cwd);
    };

    const result = publishCandidate(candidateDir, meta(), { repoUrl: remote, marketplaceName: "t" }, policedGit, () => "");

    expect(result.ok).toBe(false);
    expect(pushes).toBe(1);
    expect(result.error).toContain("Branch name 'fix-npm-test' does not follow the pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'");
    expect(result.error).toContain("Branch `fix-npm-test` · message `chore: the case under test` - confirm or change either.");
    expect(result.error).toContain("--branch <name>");
    expect(result).toMatchObject({ proposedBranch: "fix-npm-test", proposedMessage: "chore: the case under test" });
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("fix-npm-test");
  });

  it("given a commit prefix that is a ticket key, when publishing, then the proposal carries the key and one push goes through", () => {
    remote = teamRepo();
    let pushes = 0;
    const countingGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") pushes += 1;
      return runGit(args, cwd);
    };

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t", commitPrefix: "HQA-000" },
      countingGit,
      () => "",
    );

    expect(result).toMatchObject({ ok: true, branch: "HQA-000-fix-npm-test" });
    expect(pushes).toBe(1);
  });
});

describe("publishTeamSelection with a single server", () => {
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

    const result = publishTeamSelection({ servers: [gitlab] }, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/3");

    expect(result).toMatchObject({ ok: true, branch: "mcp-gitlab", version: "0.1.1" });
    const declared = JSON.parse(gitIn(remote, ["show", "mcp-gitlab:.mcp.json"]));
    expect(declared.mcpServers.linear).toEqual({ type: "sse", url: "https://mcp.linear.app/sse" });
    expect(declared.mcpServers.gitlab).toEqual(gitlab.config);
    // the server and the version signal travel as one commit, in either order: a merged
    // server whose version did not move reaches nobody
    const touched = gitIn(remote, ["show", "--name-only", "--format=", "mcp-gitlab"]);
    expect(touched).toContain(".mcp.json");
    expect(touched).toContain(".claude-plugin/plugin.json");
    expect(JSON.parse(gitIn(remote, ["show", "mcp-gitlab:.claude-plugin/plugin.json"])).version).toBe("0.1.1");
  });

  it("given a team repo with no .mcp.json at all, when a server is shared, then the file is created in the shape Claude Code loads", () => {
    remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });

    const result = publishTeamSelection({ servers: [gitlab] }, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/4");

    expect(result.ok).toBe(true);
    expect(JSON.parse(gitIn(remote, ["show", "mcp-gitlab:.mcp.json"]))).toEqual({
      mcpServers: { gitlab: gitlab.config },
    });
  });

  it("given a forge that polices names, when a server is shared, then the branch and the commit both carry the team's prefix", () => {
    remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });

    const result = publishTeamSelection(
      { servers: [gitlab] },
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

    const result = publishTeamSelection(
      {
        servers: [
          {
            name: "acme-api",
            scope: "user",
            config: { type: "http", url: "https://api.acme.com/mcp", headers: { Authorization: "Bearer 8f2c41d9ab7e05631cd4a29f" } },
          },
        ],
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

    const result = publishTeamSelection({ servers: [gitlab] }, { repoUrl: remote, marketplaceName: "acme" }, undefined, () => "https://example.com/mr/7");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already declares");
    expect(gitIn(remote, ["branch", "--list"])).not.toContain("mcp-gitlab");
  });
});

describe("a name the destination already has", () => {
  const gitlab: McpServerEntry = {
    name: "gitlab",
    scope: "user",
    config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
  };
  const pluginJson = JSON.stringify({ name: "acme", version: "0.1.0" }, null, 2) + "\n";
  let commandDir: string;

  beforeEach(() => {
    commandDir = mkdtempSync(join(tmpdir(), "handbook-commands-"));
    writeFileSync(join(commandDir, "explain.md"), "---\ndescription: mine\n---\n\nMine.\n");
  });
  afterEach(() => rmSync(commandDir, { recursive: true, force: true }));

  function occupiedTeamRepo(): string {
    return teamRepo(["fix-npm-test"], {
      ".claude-plugin/plugin.json": pluginJson,
      ".mcp.json": JSON.stringify({ mcpServers: { gitlab: { type: "sse", url: "https://theirs.example/sse" } } }) + "\n",
      "commands/explain.md": "---\ndescription: theirs\n---\n\nTheirs.\n",
    });
  }

  it("gets the same answer whether it is a skill, an MCP server or a command", () => {
    // given a team repository that already carries one of each, by the same names
    remote = occupiedTeamRepo();
    const team = { repoUrl: remote, marketplaceName: "acme" };

    // when each kind is sent under the name the team already has
    const skill = publishCandidate(candidateDir, meta(), team, undefined, () => "");
    const selection = publishTeamSelection(
      { servers: [gitlab], commands: [{ name: "explain", scope: "personal", file: join(commandDir, "explain.md") }] },
      team,
      undefined,
      () => "",
    );

    // then all three are turned back, all three say the name is taken and that what was
    // there is untouched, and all three are marked as a collision rather than as some
    // other kind of refusal - which is what lets each caller offer the route out of it in
    // the grammar its own flags actually use
    expect(skill.collision).toEqual({ kind: "skill", name: "fix-npm-test" });
    expect(selection.refused).toEqual([
      { name: "gitlab", kind: "mcp", reason: expect.stringContaining("already declares"), collision: true },
      { name: "explain", kind: "command", reason: expect.stringContaining("already has a command"), collision: true },
    ]);
    for (const answer of [skill.error!, ...selection.refused!.map((r) => r.reason)]) {
      expect(answer).toContain("already");
      expect(answer).toMatch(/left exactly as it is|Nothing was written/);
    }
    // the skill refusal has exactly one caller, so it can and does name the route itself
    expect(skill.error).toContain("--update");

    // and nothing was pushed over anything
    expect(gitIn(remote, ["branch", "--list"]).replace(/[*\s]/g, "")).toBe("main");
  });

  it("is replaced for a server and a command too, once the publisher answers with --update", () => {
    // given the same collisions, and a publisher who was shown them
    remote = occupiedTeamRepo();
    const team = { repoUrl: remote, marketplaceName: "acme" };

    // when the selection is sent again as an update
    const result = delegating((commitMessage) =>
      publishTeamSelection(
        { servers: [gitlab], commands: [{ name: "explain", scope: "personal", file: join(commandDir, "explain.md") }] },
        team,
        undefined,
        () => "",
        { update: ["gitlab", "explain"], commitMessage },
      ),
    );

    // then both carry the publisher's version, and the request says which names it rewrites
    expect(result.ok).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.updated).toEqual({ servers: ["gitlab"], commands: ["explain"], skills: [] });
    expect(JSON.parse(gitIn(remote, ["show", `${result.branch}:.mcp.json`])).mcpServers.gitlab).toEqual(gitlab.config);
    expect(gitIn(remote, ["show", `${result.branch}:commands/explain.md`])).toContain("Mine.");
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).trim()).toBe(
      "feat(mcp,commands): update gitlab, explain",
    );
  });

  it("replaces only the names the publisher consented to, not everything the selection collided with", () => {
    // given two collisions in one selection, and consent given for exactly one of them
    remote = occupiedTeamRepo();
    const team = { repoUrl: remote, marketplaceName: "acme" };

    // when the selection is sent again naming only that one
    const result = publishTeamSelection(
      { servers: [gitlab], commands: [{ name: "explain", scope: "personal", file: join(commandDir, "explain.md") }] },
      team,
      undefined,
      () => "",
      { update: ["gitlab"] },
    );

    // then the consented one travels as an update and the other is STILL refused: one word
    // cannot stand in for two answers, which is the same rule the batch guard enforces
    expect(result.ok).toBe(true);
    expect(result.updated).toEqual({ servers: ["gitlab"], commands: [], skills: [] });
    expect(result.commandNames).toBeUndefined();
    expect(result.refused).toEqual([
      { name: "explain", kind: "command", reason: expect.stringContaining("already has a command"), collision: true },
    ]);
    expect(JSON.parse(gitIn(remote, ["show", `${result.branch}:.mcp.json`])).mcpServers.gitlab).toEqual(gitlab.config);
    // the team's command is the team's command, on the branch as well as on main
    expect(gitIn(remote, ["show", `${result.branch}:commands/explain.md`])).toContain("Theirs.");
  });

  it("tells the reviewer a request replaces what the team has, which the title alone does not", () => {
    // given one new server and one that rewrites the team's own
    remote = occupiedTeamRepo();
    const team = { repoUrl: remote, marketplaceName: "acme" };
    const linear: McpServerEntry = { name: "linear", scope: "user", config: { type: "sse", url: "https://mcp.linear.app/sse" } };

    // when both travel in one request
    const result = delegating((commitMessage) =>
      publishTeamSelection({ servers: [linear, gitlab] }, team, undefined, () => "", { update: true, commitMessage }),
    );

    // then the title keeps the two verbs apart and the body spells out the consequence
    expect(result.ok).toBe(true);
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).trim()).toBe(
      "feat(mcp): add linear; update gitlab",
    );
    expect(result.updated).toEqual({ servers: ["gitlab"], commands: [], skills: [] });
  });
});

describe("buildMcpPrBody / buildSelectionPrBody", () => {
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

  it("given commands travel too, when the request is written, then each file is named and the check stays a check", () => {
    const body = buildSelectionPrBody(
      [{ entry: stdio, audit: auditServer(stdio.config) }],
      [{ name: "explain", content: "Explain it.\n" }],
      "acme-handbook",
    );

    // a bare `/explain` would not resolve once the plugin is installed - Claude Code
    // namespaces every installed plugin's commands as /<plugin>:<command>
    expect(body).toContain("- command: `/acme-handbook:explain`");
    expect(body).toContain("- file: `commands/explain.md`");
    // a merged command is read by Claude as instructions on a teammate's machine, which
    // is a consent fact the reviewer cannot get from the title
    expect(body).toContain("read as instructions");
    expect(body).toContain("## What was checked");
    // the command paragraph says what the scan looked for and stops there: the sentence
    // that tells a reviewer the files are clean is the sentence that stops them looking
    expect(body).toContain("not a proof");
    expect(body).toContain("Read the file in this diff before merging.");
  });

  it("given a request of commands alone, when it is written, then it claims nothing about servers it does not carry", () => {
    const body = buildSelectionPrBody([], [{ name: "explain", content: "Explain it.\n" }], "acme-handbook");

    expect(body).toContain("Adds one slash command to this plugin");
    expect(body).not.toContain("`headers`");
    expect(body).not.toContain("endpoint");
    expect(body).toContain("narrower claim");
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

  it("given a grounded case carrying the machine it was learned on, when it is approved to the team, then nothing is pushed and the refusal names the class, not the trace", () => {
    // The route that matters for a candidate: it never reaches the share screen, so this is
    // where its own trace would otherwise travel - into the installed file AND into the body
    // of the merge request, which prints the recorded paths.
    // Assembled rather than written out: this repository refuses a literal absolute home
    // path on any line it takes in, a fixture's included.
    const standIn = "alice";
    const homePath = ["", "Users", standIn, "work", "api"].join("/");
    writeFileSync(
      join(candidateDir, "grounded-case.json"),
      JSON.stringify({ ...groundedCase(), edits: [`${homePath}/src/app.ts`] }) + "\n",
    );
    remote = teamRepo();
    const before = gitIn(remote, ["branch", "--list"]);

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("carries a trace of this machine");
    expect(result.error).toContain("home-path");
    expect(result.error).toContain("grounded-case.json");
    expect(JSON.stringify(result)).not.toContain(standIn);
    expect(gitIn(remote, ["branch", "--list"])).toBe(before);
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

  it("given a renamed slug, when it is shared, then the extra files follow it under the new name", () => {
    writeFileSync(join(candidateDir, "preflight.sh"), "#!/bin/sh\necho ready\n");
    remote = teamRepo(["fix-npm-test"]);

    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
      { as: "fix-npm-test-2" },
    );

    expect(result.ok).toBe(true);
    expect(result.skillDir).toBe("skills/fix-npm-test-2");
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!]).split("\n");
    expect(files).toContain("skills/fix-npm-test-2/preflight.sh");
  });

  it("given an update, when the new version dropped a file, then the team's tree does not keep reading it", () => {
    // given a team copy that carries a script the new version no longer has
    remote = teamRepo([], {
      "skills/fix-npm-test/SKILL.md": "---\nname: fix-npm-test\n---\n\nTheirs.\n",
      "skills/fix-npm-test/preflight.sh": "#!/bin/sh\necho stale\n",
    });

    // when the publisher sends theirs as an update
    const result = publishCandidate(
      candidateDir,
      meta(),
      { repoUrl: remote, marketplaceName: "t" },
      runGit,
      () => "",
      { update: true },
    );

    // then the directory is replaced, not merged into: a file the update dropped is gone
    expect(result.ok).toBe(true);
    const files = gitIn(remote, ["ls-tree", "-r", "--name-only", result.branch!]).split("\n");
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(files).not.toContain("skills/fix-npm-test/preflight.sh");
  });
});

describe("a machine that joined before the repository recorded its prefix", () => {
  const gitlab: McpServerEntry = {
    name: "gitlab",
    scope: "user",
    config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
  };
  const pluginJson = JSON.stringify({ name: "acme", version: "0.1.0" }, null, 2) + "\n";

  /** A team repository that records the prefix its forge demands, the way /handbook:init
   * now scaffolds one. */
  function recordingRepo(commitPrefix: string): string {
    return teamRepo([], {
      ".claude-plugin/plugin.json": pluginJson,
      [TEAM_PREFIX_FILE]: JSON.stringify({ commitPrefix }, null, 2) + "\n",
    });
  }

  /** The founder adding the record to a handbook that had none, which is what both
   * refusal messages tell the reader to go and do. */
  function recordPrefix(remote: string, commitPrefix: string): void {
    const work = mkdtempSync(join(tmpdir(), "handbook-record-"));
    try {
      execFileSync("git", ["clone", remote, work], { stdio: "ignore" });
      writeFileSync(join(work, TEAM_PREFIX_FILE), JSON.stringify({ commitPrefix }, null, 2) + "\n");
      gitIn(work, ["add", "-A"]);
      gitIn(work, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "OPS-42 record the prefix"]);
      gitIn(work, ["push", "origin", "HEAD:main"]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** The config joinTeamRepo leaves behind when the repository recorded nothing: no
   * prefix of any kind, and no initializedAt to say this machine was ever told. */
  const joiner = (repoUrl: string): TeamConfig => ({ repoUrl, marketplaceName: "acme", joinedAt: "2026-02-02T00:00:00Z" });

  it("given a share from a machine with no prefix, when the repository records one, then the commit carries it without a rejection first", () => {
    const remote = recordingRepo("OPS-42");

    const result = publishTeamSelection({ servers: [gitlab] }, joiner(remote), undefined, () => "https://example.com/mr/9");

    expect(result.ok).toBe(true);
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).startsWith("OPS-42 ")).toBe(true);
    // Read again on every push rather than written into the config: nothing is handed back
    // for a caller to persist.
    expect(result).not.toHaveProperty("learnedCommitPrefix");
  });

  it("given an approval from a machine with no prefix, when the repository records one, then the skill's commit carries it too", () => {
    const remote = recordingRepo("OPS-42");

    const result = publishCandidate(candidateDir, meta(), joiner(remote), runGit, () => "");

    expect(result.ok).toBe(true);
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).startsWith("OPS-42 ")).toBe(true);
  });

  it("given a machine that already has its own prefix, when the repository records a different one, then the machine's own is kept", () => {
    const remote = recordingRepo("OPS-42");

    const result = publishTeamSelection(
      { servers: [gitlab] },
      { ...joiner(remote), commitPrefix: "OPS-99" },
      undefined,
      () => "https://example.com/mr/10",
    );

    // A prefix in the config may be a correction made by hand after a rejection; the
    // repository never overwrites one.
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).startsWith("OPS-99 ")).toBe(true);
  });

  it("given the repository records that the team needs no prefix, when shared, then the title carries none", () => {
    const remote = recordingRepo("");

    const result = delegating((commitMessage) =>
      publishTeamSelection({ servers: [gitlab] }, joiner(remote), undefined, () => "https://example.com/mr/11", {
        commitMessage,
      }),
    );

    expect(result.ok).toBe(true);
    // No prefix, and no stray leading space either: the title is exactly what it would be
    // on a machine that had always known the team asks for nothing.
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).trim()).toBe("feat(mcp): add gitlab");
  });

  it("given a repository recording nothing, when a commit-message rule refuses the push, then the message names a route that exists", () => {
    const remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        throw new Error(
          "git push failed: remote: GitLab: Commit message does not follow the pattern " +
            "'^(?:(TEAM|OPS|ENG|SEC)-\\d+)'",
        );
      }
      return runGit(args, cwd);
    };

    const result = publishTeamSelection({ servers: [gitlab] }, joiner(remote), policedGit, () => "");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rejected the commit MESSAGE");
    // The defect this replaces: the share path printed init's own advice, sending the user
    // to a flag share.js has never had.
    expect(result.error).not.toContain("--commit-prefix");
    expect(result.error).toContain(TEAM_PREFIX_FILE);
    expect(result.error).toContain("/handbook:init --upgrade");
  });

  it("given a repository recording that no prefix is needed, when the forge starts demanding one, then the route named is the one that exists", () => {
    const remote = recordingRepo("");
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        throw new Error(
          "git push failed: remote: GitLab: Commit message does not follow the pattern " +
            "'^(?:(TEAM|OPS|ENG|SEC)-\\d+)'",
        );
      }
      return runGit(args, cwd);
    };

    const result = publishTeamSelection({ servers: [gitlab] }, joiner(remote), policedGit, () => "");

    expect(result.ok).toBe(false);
    // The record EXISTS and says "nothing", so claiming it is absent is a lie, and
    // `--upgrade` would regenerate the same empty answer and call the file current.
    expect(result.error).not.toContain(`no ${TEAM_PREFIX_FILE}`);
    expect(result.error).not.toContain("--upgrade");
    expect(result.error).toContain("/handbook:join");
  });

  it("given a teammate refused for the commit message, when the founder records the prefix, then the very next share passes", () => {
    const remote = teamRepo([], { ".claude-plugin/plugin.json": pluginJson });
    // The forge as it actually behaves: it reads the commit it is being asked to accept.
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") {
        const subject = String(runGit(["log", "-1", "--format=%s"], cwd) ?? "");
        if (!subject.startsWith("OPS-")) {
          throw new Error(
            "git push failed: remote: GitLab: Commit message does not follow the pattern " +
              "'^(?:(TEAM|OPS|ENG|SEC)-\\d+)'",
          );
        }
      }
      return runGit(args, cwd);
    };

    const first = publishTeamSelection({ servers: [gitlab] }, joiner(remote), policedGit, () => "");
    expect(first.ok).toBe(false);
    expect(first.error).toContain("rejected the commit MESSAGE");

    // What the message told them to do, done by the person it named.
    recordPrefix(remote, "OPS-42");

    const second = publishTeamSelection({ servers: [gitlab] }, joiner(remote), policedGit, () => "");

    expect(second.ok).toBe(true);
    expect(gitIn(remote, ["log", "-1", "--format=%s", second.branch!]).startsWith("OPS-42 ")).toBe(true);
  });

  it("given a repository that records its prefix, when a share is proposed, then the branch takes its ticket key and goes through first time", () => {
    const remote = recordingRepo("HQA-000");
    let pushes = 0;
    const countingGit: GitRunner = (args, cwd) => {
      if (args[0] === "push") pushes++;
      return runGit(args, cwd);
    };

    const result = publishTeamSelection({ servers: [gitlab] }, joiner(remote), countingGit, () => "");

    // The repository's prefix reaches the proposal through the clone, with nothing written
    // into this machine's config on the way.
    expect(result.ok).toBe(true);
    expect(result.branch).toBe("HQA-000-mcp-gitlab");
    expect(pushes).toBe(1);
  });
});

// A delegated wording is an answer about the merge request, so it is honoured only where
// one can really be opened. These sit against a real bare repository rather than a
// recording runner, because what they measure is that the REMOTE was never written to:
// the check runs before the push, and a check that ran after it would leave the commit
// carrying an unread sentence on a branch with nothing to carry it further.
describe("a delegated wording needs a merge request to be about", () => {
  /** A machine without the CLI at all, which is what ENOENT means here. */
  const missingForge = () => {
    const err = new Error("spawn glab ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  };
  /** A machine that has it and is signed in: `auth status` answers, and the request comes
   * back as a link. The control for every case below. */
  const signedInForge = (_tool: "gh" | "glab", args: string[]) =>
    args[0] === "auth" ? "Logged in to acme.example as dev" : "https://acme.example/mr/1";

  it("given no way to open one, when a candidate is approved to the team with the wording delegated, then nothing reaches the remote", () => {
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };
    const before = gitIn(remote, ["branch", "--list"]);
    const probe = publishCandidateDeciding(candidateDir, meta(), team, undefined, missingForge, { commitMessage: {} });

    const result = publishCandidateDeciding(candidateDir, meta(), team, undefined, missingForge, {
      commitMessage: { delegated: probe.proposalHash! },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no merge request can be opened from this machine");
    expect(gitIn(remote, ["branch", "--list"])).toBe(before);
  });

  it("given a machine that is signed in, when the same approval is delegated, then it goes out as it always did", () => {
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };
    const probe = publishCandidateDeciding(candidateDir, meta(), team, undefined, signedInForge, { commitMessage: {} });

    const result = publishCandidateDeciding(candidateDir, meta(), team, undefined, signedInForge, {
      commitMessage: { delegated: probe.proposalHash! },
      branch: probe.proposedBranch!,
    });

    expect(result).toMatchObject({ ok: true, branch: "fix-npm-test" });
    expect(gitIn(remote, ["log", "-1", "--format=%s", "fix-npm-test"]).trim()).toBe(probe.proposedMessage);
  });

  it("given no way to open one, when a selection is shared with the wording delegated, then nothing reaches the remote", () => {
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };
    const server: McpServerEntry = {
      name: "gitlab",
      scope: "user",
      config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
    };
    const before = gitIn(remote, ["branch", "--list"]);
    const probe = publishTeamSelectionDeciding({ servers: [server] }, team, undefined, missingForge, {
      commitMessage: {},
    });

    const result = publishTeamSelectionDeciding({ servers: [server] }, team, undefined, missingForge, {
      commitMessage: { delegated: probe.proposalHash! },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no merge request can be opened from this machine");
    expect(gitIn(remote, ["branch", "--list"])).toBe(before);
  });

  it("given a machine that cannot open one, when nobody has been asked yet, then the refusal does not offer a delegation it would refuse", () => {
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };

    const probe = publishCandidateDeciding(candidateDir, meta(), team, undefined, missingForge, { commitMessage: {} });

    expect(probe.error).toContain("commit message required");
    expect(probe.error).toContain("no merge request can be opened from this machine");
    expect(probe.error).not.toContain("--delegate-message");
    // the fingerprint still travels: the machine may be signed in by the next run
    expect(probe.proposalHash).toBeTruthy();
  });

  it("given a server whose own NAME reads as a credential, when the user gives their own message, then it is committed rather than refused for the proposal", () => {
    // The title is built from names this machine did not write, and the audit screens a
    // server's config rather than what it is called, so the proposal really can arrive
    // unusable. Screening it on this branch too would refuse a clean message and leave
    // the user with no answer that works.
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };
    const poisoned: McpServerEntry = {
      name: "glpat-ABCDEFGHIJKLMNOPQRSTUVWX",
      scope: "user",
      config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
    };

    const result = publishTeamSelectionDeciding({ servers: [poisoned] }, team, undefined, () => "", {
      commitMessage: { message: "feat: add the server the team asked for" },
      branch: "TEAM-12-gitlab-server",
    });

    expect(result).toMatchObject({ ok: true, commitMessage: "feat: add the server the team asked for" });
    expect(gitIn(remote, ["log", "-1", "--format=%s", result.branch!]).trim()).toBe(
      "feat: add the server the team asked for",
    );
  });

  it("given a server whose own NAME reads as a credential, when nobody has been asked yet, then the refusal says so and offers no delegation", () => {
    remote = teamRepo();
    const team = { repoUrl: remote, marketplaceName: "t" };
    const poisoned: McpServerEntry = {
      name: "glpat-ABCDEFGHIJKLMNOPQRSTUVWX",
      scope: "user",
      config: { type: "http", url: "https://gitlab.com/api/v4/mcp" },
    };

    const probe = publishTeamSelectionDeciding({ servers: [poisoned] }, team, undefined, () => "", {
      commitMessage: {},
    });

    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("gitlab-token");
    expect(probe.error).toContain("--message");
    // the branch it would derive from that name is screened the same way, and not offered
    expect(probe.proposedBranch).toBeUndefined();
    expect(probe.error).not.toContain("glpat");
    expect(gitIn(remote, ["branch", "--list"]).replace(/^\*\s*/, "").trim()).toBe("main");
  });
});
