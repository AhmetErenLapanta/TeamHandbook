import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveAndDeliver, resolveDeliveryDir, soloSkillsDir } from "./deliver.js";
import { saveTeamConfig } from "./init.js";
import { readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  project = mkdtempSync(join(tmpdir(), "handbook-project-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function meta(overrides: Partial<CandidateMeta> = {}): CandidateMeta {
  return {
    slug: "fix-npm-test",
    status: "pending",
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "Use when npm test fails with a stale snapshot.",
    fingerprint: "abc123",
    sessionId: "s1",
    cwd: project,
    gate: null,
    ...overrides,
  };
}

function seedCandidate(m: CandidateMeta): string {
  const dir = join(candidatesDir(home), m.slug);
  mkdirSync(dir, { recursive: true });
  writeCandidateMeta(dir, m);
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${m.slug}\ndescription: "${m.description}"\nscope: "${m.scope}"\n---\n\nBody.\n`,
  );
  writeFileSync(join(dir, "grounded-case.json"), JSON.stringify({ fingerprint: m.fingerprint }) + "\n");
  return dir;
}

function bareTeamRepo(): string {
  const bare = mkdtempSync(join(tmpdir(), "handbook-team-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
  try {
    execFileSync("git", ["clone", bare, join(seed, "repo")], { stdio: "ignore" });
    const repo = join(seed, "repo");
    writeFileSync(join(repo, "README.md"), "team skills\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
    execFileSync("git", ["-C", repo, "push", "origin", "main"]);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
  return bare;
}

describe("resolveDeliveryDir", () => {
  it("targets the candidate's origin project when its directory still exists", () => {
    expect(resolveDeliveryDir(meta(), "/fallback", () => true)).toBe(soloSkillsDir(project));
  });

  it("falls back to the given cwd when the origin is gone or unrecorded", () => {
    expect(resolveDeliveryDir(meta(), "/fallback", () => false)).toBe(soloSkillsDir("/fallback"));
    expect(resolveDeliveryDir(meta({ cwd: undefined }), "/fallback")).toBe(soloSkillsDir("/fallback"));
  });
});

describe("approveAndDeliver", () => {
  it("copies the artifact into the origin project's .claude/skills and marks the candidate approved", () => {
    seedCandidate(meta());
    const result = approveAndDeliver(home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z");
    const target = join(soloSkillsDir(project), "fix-npm-test");
    expect(result).toMatchObject({ ok: true, deliveredTo: target });
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("name: fix-npm-test");
    expect(JSON.parse(readFileSync(join(target, "grounded-case.json"), "utf8"))).toEqual({
      fingerprint: "abc123",
    });
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))).toMatchObject({
      status: "approved",
      decidedAt: "2026-08-08T01:00:00Z",
      deliveredTo: target,
    });
  });

  it("never overwrites an existing skill directory; it suffixes instead", () => {
    seedCandidate(meta());
    const occupied = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "SKILL.md"), "original");
    const result = approveAndDeliver(home, "fix-npm-test");
    expect(result.deliveredTo).toBe(join(soloSkillsDir(project), "fix-npm-test-2"));
    expect(readFileSync(join(occupied, "SKILL.md"), "utf8")).toBe("original");
  });

  it("delivers to the fallback cwd when the origin project no longer exists", () => {
    seedCandidate(meta({ cwd: join(project, "gone") }));
    const fallback = mkdtempSync(join(tmpdir(), "handbook-fallback-"));
    try {
      const result = approveAndDeliver(home, "fix-npm-test", fallback);
      expect(result.deliveredTo).toBe(join(soloSkillsDir(fallback), "fix-npm-test"));
      expect(existsSync(join(soloSkillsDir(fallback), "fix-npm-test", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("delivers a candidate that has no grounded case file", () => {
    const dir = seedCandidate(meta());
    rmSync(join(dir, "grounded-case.json"));
    const result = approveAndDeliver(home, "fix-npm-test");
    expect(result.ok).toBe(true);
    expect(existsSync(join(result.deliveredTo!, "SKILL.md"))).toBe(true);
    expect(existsSync(join(result.deliveredTo!, "grounded-case.json"))).toBe(false);
  });

  it("refuses unknown, unsafe, and already-decided candidates", () => {
    expect(approveAndDeliver(home, "nope")).toMatchObject({ ok: false, error: 'no candidate named "nope"' });
    expect(approveAndDeliver(home, "../etc")).toMatchObject({ ok: false });
    seedCandidate(meta({ status: "rejected" }));
    expect(approveAndDeliver(home, "fix-npm-test")).toMatchObject({
      ok: false,
      error: 'candidate "fix-npm-test" is already rejected',
    });
    expect(existsSync(soloSkillsDir(project))).toBe(false);
  });

  it("keeps the candidate pending when delivery fails", () => {
    seedCandidate(meta());
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(soloSkillsDir(project), ""); // .claude/skills as a file blocks mkdir
    const result = approveAndDeliver(home, "fix-npm-test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("delivery failed");
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
  });
});

describe("approveAndDeliver (team mode)", () => {
  let remote: string;

  beforeEach(() => {
    remote = bareTeamRepo();
  });

  afterEach(() => {
    rmSync(remote, { recursive: true, force: true });
  });

  it("publishes to the configured team repo instead of the solo skills dir", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedCandidate(meta());
    const result = approveAndDeliver(
      home,
      "fix-npm-test",
      "/fallback",
      "2026-08-08T01:00:00Z",
      undefined,
      undefined,
      () => "https://gitlab.acme.com/team/skills/-/merge_requests/7\n",
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "team",
      branch: "handbook/fix-npm-test",
      prUrl: "https://gitlab.acme.com/team/skills/-/merge_requests/7",
      deliveredTo: "https://gitlab.acme.com/team/skills/-/merge_requests/7",
    });
    const files = execFileSync(
      "git",
      ["-C", remote, "ls-tree", "-r", "--name-only", "handbook/fix-npm-test"],
      { encoding: "utf8" },
    );
    expect(files).toContain("skills/fix-npm-test/SKILL.md");
    expect(existsSync(soloSkillsDir(project))).toBe(false);
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))).toMatchObject({
      status: "approved",
      decidedAt: "2026-08-08T01:00:00Z",
    });
  });

  it("records the branch as deliveredTo when no PR URL could be obtained", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedCandidate(meta());
    const result = approveAndDeliver(home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z", undefined, undefined, () => {
      throw new Error("glab: command not found");
    });
    expect(result).toMatchObject({
      ok: true,
      mode: "team",
      branch: "handbook/fix-npm-test",
      deliveredTo: `${remote} (branch handbook/fix-npm-test)`,
    });
    expect(result.prUrl).toBeUndefined();
  });

  it("keeps the candidate pending when the team repo is unreachable", () => {
    saveTeamConfig({ repoUrl: join(home, "missing.git"), marketplaceName: "t" }, home);
    seedCandidate(meta());
    const result = approveAndDeliver(home, "fix-npm-test");
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("team");
    expect(result.error).toContain("git clone failed");
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
    expect(existsSync(soloSkillsDir(project))).toBe(false);
  });
});
