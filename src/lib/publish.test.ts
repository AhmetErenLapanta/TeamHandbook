import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrBody, buildPrTitle, manualPrUrl, publishCandidate } from "./publish.js";
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

function teamRepo(seedSkillDirs: string[] = []): string {
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
      "https://gitlab.acme.com/team/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=TeamHandbook%2Fx",
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
        "https://gitlab.acme.com/team/skills/-/merge_requests/new?merge_request%5Bsource_branch%5D=TeamHandbook%2Ffix-npm-test",
    });
    expect(result.prUrl).toBeUndefined();
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

  it("fails when the push is rejected", () => {
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
    expect(result.ok).toBe(false);
    expect(result.error).toContain("git push failed");
  });
});
