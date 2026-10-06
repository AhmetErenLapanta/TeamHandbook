import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  approveAndDeliver,
  formatApproveResult,
  projectTargetLabel,
  resolveDeliveryDir,
  soloSkillsDir,
} from "./deliver.js";
import { loadTeamConfig, runGit, saveTeamConfig } from "./init.js";
import type { GitRunner } from "./init.js";
import type { ForgeRunner } from "./publish.js";
import { readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

/**
 * The answer every team delivery below gives about its commit message, because none of
 * them is about the wording: a plain sentence of the user's own. It carries no team prefix, so the
 * cases that measure the prefix still measure it. Delegating instead would cost every one
 * of them a second run, since "you decide" has to name the proposal it was shown.
 */
const APPROVED = { message: "chore: the case under test" } as const;

/** A credential in the shape the secret sieve knows, built rather than written out whole. */
const LIVE_KEY = "sk-ant-api03-" + "b".repeat(95);

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

describe("projectTargetLabel", () => {
  it("names the origin project when the review runs from a different one", () => {
    // given a candidate captured in `project`, reviewed from somewhere else
    // when the option text is built
    const label = projectTargetLabel(meta(), "/somewhere/else", () => true);
    // then it names the project the copy will actually land in, before the choice
    expect(label).toBe(`${basename(project)}'s .claude/skills (where it was captured, not this project)`);
  });

  it("keeps the short wording when the origin is the project being reviewed from", () => {
    // given a candidate captured in the very project the review runs from
    // when the option text is built
    const label = projectTargetLabel(meta(), project, () => true);
    // then there is no difference to report and the plain wording stands
    expect(label).toBe("this project's .claude/skills");
  });

  it("says this project once the origin is gone, which is where delivery then lands", () => {
    // given an origin directory that no longer exists
    // when the option text is built
    const label = projectTargetLabel(meta(), "/fallback", () => false);
    // then it follows resolveDeliveryDir's fallback instead of naming a dead project
    expect(label).toBe("this project's .claude/skills");
    expect(resolveDeliveryDir(meta(), "/fallback", () => false)).toBe(soloSkillsDir("/fallback"));
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

  // Was: "never overwrites an existing skill directory; it suffixes instead". The suffix
  // is gone, the promise it was keeping is not: nothing is overwritten. What replaces it
  // is a refusal, because the suffix delivered the candidate and so made the CLI's own
  // "approve again with --update" advice unreachable (the candidate was already approved).
  it("never overwrites an existing skill directory; it refuses rather than filing a second copy", () => {
    seedCandidate(meta());
    const occupied = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "SKILL.md"), "original");

    const result = approveAndDeliver(home, "fix-npm-test");

    expect(result.ok).toBe(false);
    expect(result.collision).toEqual({ kind: "skill", name: "fix-npm-test" });
    expect(readFileSync(join(occupied, "SKILL.md"), "utf8")).toBe("original");
    expect(existsSync(join(soloSkillsDir(project), "fix-npm-test-2"))).toBe(false);
  });

  it("names the origin project when it differs from the review cwd (cross-project approve)", () => {
    seedCandidate(meta()); // captured in `project`
    const result = approveAndDeliver(home, "fix-npm-test", "/somewhere/else");
    expect(result.originProject).toBe(basename(project));
  });

  it("omits originProject when approving from the same project the skill was captured in", () => {
    seedCandidate(meta());
    const result = approveAndDeliver(home, "fix-npm-test", project);
    expect(result.originProject).toBeUndefined();
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

  it("still delivers, with the warning it always gave, when candidate.json holds a cwd that is not a path", () => {
    // readCandidateMeta passes cwd through unchecked, so a hand-edited or older-schema
    // file reaches the delivery typed as a string without being one. Formatting it for
    // display must not be what turns a delivery that used to succeed into a throw.
    seedCandidate(meta({ cwd: 12345 as unknown as string }));
    const fallback = mkdtempSync(join(tmpdir(), "handbook-fallback-"));
    try {
      const result = approveAndDeliver(home, "fix-npm-test", fallback);
      expect(result.ok).toBe(true);
      expect(result.warning).toContain("12345");
      expect(existsSync(join(soloSkillsDir(fallback), "fix-npm-test", "SKILL.md"))).toBe(true);
      expect(() => formatApproveResult("fix-npm-test", result)).not.toThrow();
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
      undefined,
      undefined,
      { commitMessage: APPROVED },
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

  it("given a forge that refuses the default branch name, when sharing, then the prefix it accepts is remembered", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t", commitPrefix: "HQA-000" }, home);
    seedCandidate(meta());
    let pushes = 0;
    const policedGit: GitRunner = (args, cwd) => {
      if (args[0] === "push" && ++pushes === 1) {
        throw new Error(
          "git push failed: remote: GitLab: Branch name 'handbook/fix-npm-test' does not follow the " +
            "pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'",
        );
      }
      return runGit(args, cwd);
    };

    const result = approveAndDeliver(
      home,
      "fix-npm-test",
      "/fallback",
      "2026-08-08T01:00:00Z",
      undefined,
      policedGit,
      () => "",
      undefined,
      undefined,
      { commitMessage: APPROVED },
    );

    expect(result).toMatchObject({ ok: true, mode: "team", branch: "HQA-000-fix-npm-test" });
    expect(loadTeamConfig(home)?.branchPrefix).toBe("HQA-000-");
  });

  it("records the branch as deliveredTo when no PR URL could be obtained", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedCandidate(meta());
    const result = approveAndDeliver(
      home,
      "fix-npm-test",
      "/fallback",
      "2026-08-08T01:00:00Z",
      undefined,
      undefined,
      () => {
        throw new Error("glab: command not found");
      },
      undefined,
      undefined,
      { commitMessage: APPROVED },
    );
    expect(result).toMatchObject({
      ok: true,
      mode: "team",
      branch: "handbook/fix-npm-test",
      deliveredTo: `${remote} (branch handbook/fix-npm-test)`,
    });
    expect(result.prUrl).toBeUndefined();
  });

  it("given no decision about the commit message, when a candidate is approved to the team, then nothing is pushed and the candidate is still waiting", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedCandidate(meta());
    const before = execFileSync("git", ["-C", remote, "branch", "--list"], { encoding: "utf8" });

    // no commitMessage in the options: the reviewer was never asked. The forge stub is
    // not decoration - a run with no wording asks whether a request could be opened, so
    // the default runner would reach for the real gh or glab on whatever machine runs this.
    const result = approveAndDeliver(
      home,
      "fix-npm-test",
      "/fallback",
      "2026-08-08T01:00:00Z",
      undefined,
      undefined,
      () => "Logged in",
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("team");
    expect(result.error).toContain("commit message required");
    // the sentence to put in front of the reviewer travels with the refusal
    expect(result.proposedMessage).toBe("feat(skill): add fix-npm-test");
    // and the verdict is still theirs to give: a refusal must not spend the candidate
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
    expect(execFileSync("git", ["-C", remote, "branch", "--list"], { encoding: "utf8" })).toBe(before);
  });

  it("given the reviewer's own wording, when a candidate is approved to the team, then the commit says it and they are told so", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedCandidate(meta());

    const result = approveAndDeliver(
      home,
      "fix-npm-test",
      "/fallback",
      "2026-08-08T01:00:00Z",
      undefined,
      undefined,
      () => "https://example.com/mr/3",
      undefined,
      undefined,
      { commitMessage: { message: "feat: the npm test fix we all keep hitting" } },
    );

    expect(result).toMatchObject({ ok: true, commitMessage: "feat: the npm test fix we all keep hitting" });
    const subject = execFileSync("git", ["-C", remote, "log", "-1", "--format=%s", "handbook/fix-npm-test"], {
      encoding: "utf8",
    });
    expect(subject.trim()).toBe("feat: the npm test fix we all keep hitting");
    expect(formatApproveResult("fix-npm-test", result)).toContain("feat: the npm test fix we all keep hitting");
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

describe("three-way delivery (v2)", () => {
  it("keeps a candidate personally in the user-level skills dir", () => {
    const dir = seedCandidate(meta({ suggestedTarget: "personal" }));
    const personal = mkdtempSync(join(tmpdir(), "handbook-personal-"));
    try {
      const result = approveAndDeliver(
        home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
        null, undefined, undefined, undefined, personal,
      );
      expect(result).toMatchObject({ ok: true, mode: "personal" });
      expect(result.deliveredTo).toBe(join(personal, "fix-npm-test"));
      expect(existsSync(join(personal, "fix-npm-test", "SKILL.md"))).toBe(true);
      expect(readCandidateMeta(dir)?.deliveredMode).toBe("personal");
    } finally {
      rmSync(personal, { recursive: true, force: true });
    }
  });

  it("given a commit message on an approval that installs rather than commits, when it runs, then it says so instead of dropping it", () => {
    // Nothing is committed on the way to ~/.claude/skills, so a wording given for it has
    // nowhere to go. Silently dropping it told the reviewer their words had travelled.
    const dir = seedCandidate(meta({ suggestedTarget: "personal" }));

    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, undefined, undefined, "personal", undefined,
      { commitMessage: { message: "feat: mine" } },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no commit message to give");
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });

  it("an explicit --to project overrides a team config", () => {
    saveTeamConfig({ repoUrl: "git@unreachable:x/y.git", marketplaceName: "t" }, home);
    seedCandidate(meta());
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, undefined, undefined, "project",
    );
    expect(result.mode).toBe("solo");
    expect(result.deliveredTo).toBe(join(soloSkillsDir(project), "fix-npm-test"));
  });

  it("refuses --to team without a team config, pointing at the fix", () => {
    seedCandidate(meta());
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      null, undefined, undefined, "team",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no team configured");
    expect(result.error).toContain("--to personal");
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
  });

  // Assembled rather than written out: this repository refuses a literal absolute home path
  // on any line it takes in, a fixture's included.
  const STAND_IN = "alice";
  const HOME_PATH = ["", "Users", STAND_IN, "work", "api"].join("/");

  function tracedCandidate(): string {
    const dir = seedCandidate(meta());
    writeFileSync(
      join(dir, "grounded-case.json"),
      JSON.stringify({ fingerprint: "abc123", edits: [`${HOME_PATH}/src/app.ts`] }) + "\n",
    );
    return dir;
  }

  it("given a candidate carrying a trace of this machine, when it is approved into a project, then nothing is written and the refusal names the class", () => {
    // A project skill is committed with the repository, so this copy reaches everyone who
    // clones it - the same journey the team route makes, through the reviewer's own commit.
    const dir = tracedCandidate();

    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("carries a trace of this machine");
    expect(result.error).toContain("home-path");
    expect(JSON.stringify(result)).not.toContain(STAND_IN);
    expect(existsSync(join(soloSkillsDir(project), "fix-npm-test"))).toBe(false);
    // still waiting for a verdict, so the reviewer can keep it or clean it up
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });

  it("given the same candidate, when it is kept personally, then it is delivered and the trace is recorded rather than refused", () => {
    const dir = tracedCandidate();
    const personal = mkdtempSync(join(tmpdir(), "handbook-personal-"));
    try {
      const result = approveAndDeliver(
        home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
        null, undefined, undefined, "personal", personal,
      );

      expect(result).toMatchObject({ ok: true, mode: "personal" });
      expect(existsSync(join(personal, "fix-npm-test", "SKILL.md"))).toBe(true);
      // the copy stays on the machine the trace names, and the record says what is in it
      expect(readCandidateMeta(dir)?.hygiene).toEqual({
        identity: "home-path",
        where: "grounded-case.json",
      });
    } finally {
      rmSync(personal, { recursive: true, force: true });
    }
  });

  it("follows the harvest's suggestedTarget when no explicit target is given", () => {
    seedCandidate(meta({ suggestedTarget: "project" }));
    // even with a team configured, the suggestion wins over the legacy default
    saveTeamConfig({ repoUrl: "git@unreachable:x/y.git", marketplaceName: "t" }, home);
    const result = approveAndDeliver(home, "fix-npm-test", "/fallback");
    expect(result.mode).toBe("solo");
  });
});

describe("delivery carries the whole skill", () => {
  function seedWithExtras(m: CandidateMeta): string {
    const dir = seedCandidate(m);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "preflight.sh"), "#!/bin/sh\necho ready\n");
    writeFileSync(join(dir, "scripts", "server.cjs"), "module.exports = {};\n");
    return dir;
  }

  it("given a skill with extra files, when it is kept for yourself, then they are installed too", () => {
    const personal = mkdtempSync(join(tmpdir(), "handbook-personal-"));
    try {
      seedWithExtras(meta());

      const result = approveAndDeliver(
        home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
        null, undefined, undefined, "personal", personal,
      );

      expect(result.ok).toBe(true);
      const target = join(personal, "fix-npm-test");
      expect(readFileSync(join(target, "preflight.sh"), "utf8")).toContain("echo ready");
      expect(readFileSync(join(target, "scripts", "server.cjs"), "utf8")).toContain("module.exports");
      // the queue's own bookkeeping is not part of the skill
      expect(existsSync(join(target, "candidate.json"))).toBe(false);
    } finally {
      rmSync(personal, { recursive: true, force: true });
    }
  });

  it("given a skill with extra files, when it is added to the project, then they are installed too", () => {
    seedWithExtras(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    expect(result.ok).toBe(true);
    const target = join(soloSkillsDir(project), "fix-npm-test");
    expect(readFileSync(join(target, "preflight.sh"), "utf8")).toContain("echo ready");
    expect(readFileSync(join(target, "scripts", "server.cjs"), "utf8")).toContain("module.exports");
    expect(existsSync(join(target, "candidate.json"))).toBe(false);
  });

  it("given an ordinary harvest candidate, when it is delivered, then it installs exactly the two files it always did", () => {
    // the pre-existing behaviour, pinned against the general copy
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    expect(result.ok).toBe(true);
    const target = join(soloSkillsDir(project), "fix-npm-test");
    expect(readdirSync(target).sort()).toEqual(["SKILL.md", "grounded-case.json"]);
  });

  it("given an unreadable candidate, when it is delivered, then no skill directory is left behind", () => {
    const dir = join(candidatesDir(home), "fix-npm-test");
    mkdirSync(dir, { recursive: true });
    writeCandidateMeta(dir, meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    expect(result.ok).toBe(false);
    expect(existsSync(join(soloSkillsDir(project), "fix-npm-test"))).toBe(false);
  });
});

describe("the name a delivery actually used", () => {
  it("reaches the reviewer for every destination, which is the field the type used to lack", () => {
    // given a free name in each local destination and a contested one on the team
    const personalDir = join(home, "personal-skills");
    seedCandidate(meta({ slug: "fix-npm-test" }));

    // when it is approved into the project under a chosen name
    const solo = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { as: "fix-npm-snapshot" },
    );

    // then the result names what was written, not what the reviewer typed, and the line
    // they read says the same thing
    expect(solo).toMatchObject({ ok: true, deliveredSlug: "fix-npm-snapshot" });
    expect(formatApproveResult("fix-npm-test", solo)).toContain('Approved "fix-npm-snapshot"');

    // and the same holds for the personal destination
    seedCandidate(meta({ slug: "fix-npm-test" }));
    const personal = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "personal", personalDir, { as: "fix-npm-snapshot" },
    );
    expect(personal).toMatchObject({ ok: true, deliveredSlug: "fix-npm-snapshot" });
    expect(formatApproveResult("fix-npm-test", personal)).toContain('Kept "fix-npm-snapshot"');
  });

  it("replaces the installed skill instead of suffixing when the reviewer asks for an update", () => {
    // given a skill of that name already in the project, with a file the new one lacks
    const installed = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "SKILL.md"), "---\nname: fix-npm-test\n---\n\nOld.\n");
    writeFileSync(join(installed, "preflight.sh"), "echo stale\n");
    seedCandidate(meta());

    // when the reviewer approves it as an update
    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { update: true },
    );

    // then one skill exists, carrying the new body, and the file the new version dropped
    // is not left behind to be read
    expect(result).toMatchObject({ ok: true, deliveredSlug: "fix-npm-test", updatedExisting: true });
    expect(existsSync(join(soloSkillsDir(project), "fix-npm-test-2"))).toBe(false);
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("Body.");
    expect(existsSync(join(installed, "preflight.sh"))).toBe(false);
    expect(formatApproveResult("fix-npm-test", result)).toContain("This replaced the");
  });

  it("never replaces an installed skill without being asked, however many times it is approved", () => {
    // given a skill of that name already installed
    const installed = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "SKILL.md"), "---\nname: fix-npm-test\n---\n\nTheirs.\n");
    seedCandidate(meta());

    // when it is approved with no update asked for
    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    // then what was there is exactly what is still there, and nothing was delivered
    expect(result.ok).toBe(false);
    expect(result.updatedExisting).toBeUndefined();
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("Theirs.");
  });

  it("installs under the name the reviewer chose when they answer with a different one", () => {
    mkdirSync(join(soloSkillsDir(project), "fix-npm-test"), { recursive: true });
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { as: "fix-npm-snapshot" },
    );

    expect(result).toMatchObject({ ok: true, deliveredSlug: "fix-npm-snapshot" });
    // the frontmatter follows the directory, so the two skills do not shadow each other
    expect(readFileSync(join(soloSkillsDir(project), "fix-npm-snapshot", "SKILL.md"), "utf8")).toContain(
      "name: fix-npm-snapshot",
    );
  });

  it("refuses a name that could not be a skill directory before anything is written", () => {
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { as: "../escape" },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be a skill name");
  });
});

describe("the team's own copy, and the reviewer's answer to it", () => {
  let remote: string;

  beforeEach(() => {
    remote = bareTeamRepo();
  });
  afterEach(() => rmSync(remote, { recursive: true, force: true }));

  function seedTeamSkill(): void {
    const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
    try {
      execFileSync("git", ["clone", remote, join(seed, "repo")], { stdio: "ignore" });
      const repo = join(seed, "repo");
      mkdirSync(join(repo, "skills", "fix-npm-test"), { recursive: true });
      writeFileSync(join(repo, "skills", "fix-npm-test", "SKILL.md"), "---\nname: fix-npm-test\n---\n\nTheirs.\n");
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed skill"]);
      execFileSync("git", ["-C", repo, "push", "origin", "main"]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
  }

  it("carries the refusal out to the reviewer as a collision rather than a failure to explain", () => {
    // given the team already has a skill by this name
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedTeamSkill();
    seedCandidate(meta());

    // when the reviewer shares it
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, undefined, () => "",
    );

    // then the collision travels through the delivery result, and the candidate is still
    // pending: nothing was decided on the reviewer's behalf
    expect(result.ok).toBe(false);
    expect(result.collision).toEqual({ kind: "skill", name: "fix-npm-test" });
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
  });

  it("sends it as an update once the reviewer asks, and says so in the line they read", () => {
    // given the same collision, and a reviewer who answered it
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedTeamSkill();
    seedCandidate(meta());

    // when they approve again with --update
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, undefined, () => "https://example.com/mr/9",
      undefined, undefined, { update: true, commitMessage: APPROVED },
    );

    // then it goes out under the contested name, and the reviewer is told it replaces theirs
    expect(result).toMatchObject({ ok: true, mode: "team", deliveredSlug: "fix-npm-test", updatedExisting: true });
    const printed = formatApproveResult("fix-npm-test", result);
    expect(printed).toContain("as an update to the skill they already had");
    expect(printed).toContain("replaces their copy");
    const body = execFileSync(
      "git",
      ["-C", remote, "show", `${result.branch}:skills/fix-npm-test/SKILL.md`],
      { encoding: "utf8" },
    );
    expect(body).toContain("Body.");
  });

  it("names the team's copy by what was written when the reviewer renamed it", () => {
    saveTeamConfig({ repoUrl: remote, marketplaceName: "t" }, home);
    seedTeamSkill();
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, undefined, () => "https://example.com/mr/9",
      undefined, undefined, { as: "fix-npm-snapshot", commitMessage: APPROVED },
    );

    expect(result.deliveredSlug).toBe("fix-npm-snapshot");
    // the line the reviewer reads used to print the slug they typed, whatever was written
    expect(formatApproveResult("fix-npm-test", result)).toContain('Shared "fix-npm-snapshot" with the team');
  });
});

describe("the route a refusal names has to work when it is walked", () => {
  // The local path used to suffix and DELIVER, which set the candidate to `approved` - and
  // `approved` is terminal (queue.ts has no path back to `pending`). So the very next line
  // the CLI printed, "Approve with --update", answered with `candidate "fix-npm-test" is
  // already approved`, and the user was left holding the two disagreeing skills this
  // product exists to prevent. What this test holds down is that the advice a refusal
  // prints can still be taken when you take it.
  it("lets the reviewer walk the refusal's own advice: refuse, then --update, on the same candidate", () => {
    // given a skill of that name already installed in the project
    const installed = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "SKILL.md"), "---\nname: fix-npm-test\n---\n\nTheirs.\n");
    writeFileSync(join(installed, "helper.sh"), "echo stale\n");
    seedCandidate(meta());

    // when the reviewer approves it the ordinary way
    const refused = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    // then nothing is written, and the candidate is STILL PENDING - which is the whole
    // point: the advice below is only reachable while it is
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("--update");
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("pending");
    expect(existsSync(join(soloSkillsDir(project), "fix-npm-test-2"))).toBe(false);

    // when they then run exactly what they were told to run
    const updated = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { update: true },
    );

    // then it works: one skill, the new body, and the file the new version dropped is gone
    expect(updated).toMatchObject({ ok: true, deliveredSlug: "fix-npm-test", updatedExisting: true });
    expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("Body.");
    expect(existsSync(join(installed, "helper.sh"))).toBe(false);
    expect(readCandidateMeta(join(candidatesDir(home), "fix-npm-test"))?.status).toBe("approved");
  });

  it("names a route that works when the CHOSEN name is the taken one, rather than one it will refuse", () => {
    // given the name the reviewer picked is itself taken
    mkdirSync(join(soloSkillsDir(project), "bar"), { recursive: true });
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { as: "bar" },
    );

    // then it does not offer `--as bar --update`, which is refused (see below): a refusal
    // that names a blocked route is the dead end this describe block is about
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--as");
    expect(result.error).toContain("drop --as");
  });
});

describe("two answers to one refusal are not one answer twice", () => {
  // `--update` lands on the name `--as` chose, not on the name the reviewer was refused
  // for - so `approve foo --as bar --update` used to delete a skill called `bar` whose
  // existence was never put in front of them, and say so only afterwards.
  it("refuses --as together with --update instead of deleting a skill the reviewer was never shown", () => {
    // given an unrelated, hand-written skill the reviewer has never been warned about
    const bystander = join(soloSkillsDir(project), "bar");
    mkdirSync(bystander, { recursive: true });
    writeFileSync(join(bystander, "SKILL.md"), "---\nname: bar\n---\n\nHand written.\n");
    writeFileSync(join(bystander, "notes.md"), "notes worth keeping\n");
    seedCandidate(meta());

    // when both answers are given at once
    const result = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project", undefined, { as: "bar", update: true },
    );

    // then nothing is deleted and the reason says why the pair cannot be consent
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--as and --update");
    expect(readFileSync(join(bystander, "SKILL.md"), "utf8")).toContain("Hand written.");
    expect(readFileSync(join(bystander, "notes.md"), "utf8")).toBe("notes worth keeping\n");
  });

  it("refuses the same pair on the team path, before a clone is ever made", () => {
    // given a git runner that records every call
    const calls: string[][] = [];
    const recordingGit: GitRunner = (args) => {
      calls.push(args);
      return "";
    };
    saveTeamConfig({ repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "t" }, home);
    seedCandidate(meta());

    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-08-08T01:00:00Z",
      undefined, recordingGit, () => "", "team", undefined, { as: "bar", update: true },
    );

    // then it is turned back before git is run at all
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--as and --update");
    expect(calls).toEqual([]);
  });
});

describe("a demo draft, approved anywhere but its scratch repository", () => {
  function demoDraft(): string {
    return seedCandidate(meta({ slug: "add-resource-endpoints", origin: "mine", demo: true, suggestedTarget: "project" }));
  }

  it("given a demo draft, when it is kept for yourself, then it is refused and nothing reaches your own skills", () => {
    // given a demo draft and an empty personal skills directory
    const dir = demoDraft();
    const personal = mkdtempSync(join(tmpdir(), "handbook-personal-"));
    try {
      // when it is approved to personal
      const result = approveAndDeliver(
        home, "add-resource-endpoints", project, "2026-10-06T00:00:00Z", null, undefined, undefined, "personal", personal,
      );

      // then it is refused by what it is, the personal directory stays empty, and it still waits
      expect(result.ok).toBe(false);
      expect(result.error).toContain("a demo draft stays in its scratch repository");
      expect(readdirSync(personal)).toEqual([]);
      expect(readCandidateMeta(dir)?.status).toBe("pending");
    } finally {
      rmSync(personal, { recursive: true, force: true });
    }
  });

  it("given a demo draft and a team, when it is shared with the team, then it is refused before git or the forge is called", () => {
    // given a configured team and runners that record every call
    saveTeamConfig({ repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "t" }, home);
    const dir = demoDraft();
    const gitCalls: string[][] = [];
    const forgeCalls: string[][] = [];

    // when it is approved to the team, with a wording already given so nothing else stops it
    const result = approveAndDeliver(
      home, "add-resource-endpoints", project, "2026-10-06T00:00:00Z", undefined,
      (args) => {
        gitCalls.push(args);
        return "";
      },
      (_tool, args) => {
        forgeCalls.push(args);
        return "";
      },
      "team", undefined, { commitMessage: { message: "add the add-resource-endpoints skill" } },
    );

    // then it is refused, and nothing was cloned, pushed or opened
    expect(result.ok).toBe(false);
    expect(result.error).toContain("a demo draft stays in its scratch repository");
    expect(gitCalls).toEqual([]);
    expect(forgeCalls).toEqual([]);
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });
});

describe("a candidate edited in the queue, approved to the team", () => {
  function recordingRunners(): { git: GitRunner; forge: ForgeRunner; gitCalls: string[][]; forgeCalls: string[][] } {
    const gitCalls: string[][] = [];
    const forgeCalls: string[][] = [];
    return {
      gitCalls,
      forgeCalls,
      git: (args) => {
        gitCalls.push(args);
        return "";
      },
      forge: (_tool, args) => {
        forgeCalls.push(args);
        return "";
      },
    };
  }

  beforeEach(() => {
    saveTeamConfig({ repoUrl: "git@gitlab.acme.com:team/skills.git", marketplaceName: "t" }, home);
  });

  it("given a secret in SKILL.md next to a symlink, when it is approved to the team, then nothing is cloned or pushed", () => {
    // given a candidate whose body holds a credential and which carries a link out of itself
    const dir = seedCandidate(meta());
    writeFileSync(join(dir, "SKILL.md"), `---\nname: fix-npm-test\ndescription: "d"\n---\n\nexport KEY=${LIVE_KEY}\n`);
    writeFileSync(join(home, "outside.md"), "elsewhere\n");
    symlinkSync(join(home, "outside.md"), join(dir, "reference.md"));
    const runners = recordingRunners();
    // when it is approved to the team with wording
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-10-01T00:00:00Z",
      undefined, runners.git, runners.forge, "team", undefined, { commitMessage: APPROVED },
    );
    // then the share door's audit turns it back before git or the forge is run at all
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a regular file");
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
    expect(runners.gitCalls).toEqual([]);
    expect(runners.forgeCalls).toEqual([]);
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });

  it("given a secret in a SKILL.md with no frontmatter, when it is approved to the team, then nothing is cloned or pushed", () => {
    // given a candidate edited into a body with no frontmatter and a credential in it
    const dir = seedCandidate(meta());
    writeFileSync(join(dir, "SKILL.md"), `Steps.\n\nexport KEY=${LIVE_KEY}\n`);
    const runners = recordingRunners();
    // when it is approved to the team with wording
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-10-01T00:00:00Z",
      undefined, runners.git, runners.forge, "team", undefined, { commitMessage: APPROVED },
    );
    // then the audit's first refusal is a refusal here too, though it never reached the secret
    expect(result.ok).toBe(false);
    expect(result.error).toContain("frontmatter");
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
    expect(runners.gitCalls).toEqual([]);
    expect(runners.forgeCalls).toEqual([]);
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });

  it("given a secret in a reference file, when it is approved to the team, then the refusal names the file and not the value", () => {
    // given a candidate whose only problem is a credential beside its SKILL.md
    const dir = seedCandidate(meta());
    writeFileSync(join(dir, "reference.md"), `export KEY=${LIVE_KEY}\n`);
    const runners = recordingRunners();
    // when it is approved to the team with wording
    const result = approveAndDeliver(
      home, "fix-npm-test", "/fallback", "2026-10-01T00:00:00Z",
      undefined, runners.git, runners.forge, "team", undefined, { commitMessage: APPROVED },
    );
    // then the secret sieve stops it, by the file and the class of what it found
    expect(result.ok).toBe(false);
    expect(result.error).toContain('"reference.md" looks like it contains a secret (anthropic-api-key)');
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
    expect(runners.gitCalls).toEqual([]);
    expect(readCandidateMeta(dir)?.status).toBe("pending");
  });
});

/**
 * A mined draft is the one candidate whose project delivery COMMITS, so it is the one
 * that has to answer for its wording. Everything here is about that difference: the
 * wording is asked for before anything is written, the sieves that guard a shared file
 * run, and the commit carries the skill and nothing else the tree happened to hold.
 */
describe("a mined draft delivered into the project it came from", () => {
  function gitRepo(): string {
    execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
    execFileSync("git", ["-C", project, "config", "user.name", "t"]);
    execFileSync("git", ["-C", project, "config", "user.email", "t@t"]);
    writeFileSync(join(project, "README.md"), "a repository\n");
    execFileSync("git", ["-C", project, "add", "-A"]);
    execFileSync("git", ["-C", project, "commit", "-m", "seed"], { stdio: "ignore" });
    return project;
  }

  function mined(overrides: Partial<CandidateMeta> = {}): CandidateMeta {
    return meta({ slug: "add-entity-field", origin: "mine", kind: "procedure", ...overrides });
  }

  function log(): string {
    return execFileSync("git", ["-C", project, "log", "--oneline", "-1"], { encoding: "utf8" });
  }

  it("given no commit message, when it is approved into the project, then nothing is written and the proposal is shown", () => {
    // given a mined candidate whose delivery will make a commit
    gitRepo();
    seedCandidate(mined());
    // when it is approved with no wording decided
    const result = approveAndDeliver(home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project");
    // then it is refused, the candidate is untouched, and the sentence it would commit is on offer
    expect(result.ok).toBe(false);
    expect(result.error).toContain("commit message required");
    expect(result.proposedMessage).toContain("add-entity-field");
    expect(readCandidateMeta(join(candidatesDir(home), "add-entity-field"))?.status).toBe("pending");
    expect(existsSync(join(soloSkillsDir(project), "add-entity-field"))).toBe(false);
  });

  it("given the reviewer's own wording, when it is approved, then the skill is committed with it", () => {
    // given a mined candidate and a sentence the reviewer approved
    gitRepo();
    seedCandidate(mined());
    // when it is approved with that wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the add-entity-field skill" } },
    );
    // then the skill is in the tree and the commit says what the reviewer said
    expect(result.ok).toBe(true);
    expect(result.commitMessage).toBe("add the add-entity-field skill");
    expect(existsSync(join(soloSkillsDir(project), "add-entity-field", "SKILL.md"))).toBe(true);
    expect(log()).toContain("add the add-entity-field skill");
    // and the reviewer is not sent to make a commit that this approval already made
    const said = formatApproveResult("add-entity-field", result);
    expect(said).toContain("It is committed");
    expect(said).not.toContain("Commit this directory");
  });

  it("given a demo draft whose scratch repository was deleted, when it is approved into the project the reviewer stands in, then it is refused and nothing reaches that project", () => {
    // given a real repository to approve from, and a demo draft whose scratch repository is gone
    gitRepo();
    const scratch = mkdtempSync(join(tmpdir(), "handbook-demo-"));
    rmSync(scratch, { recursive: true, force: true });
    seedCandidate(mined({ demo: true, cwd: scratch }));

    // when it is approved into the project, with a wording already decided so nothing else stops it
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the add-entity-field skill" } },
    );

    // then it is refused by what it is, the real repository has neither the file nor a commit,
    // and the draft is still there to be rejected
    expect(result.ok).toBe(false);
    expect(result.error).toContain("this demo draft belongs to a scratch repository that no longer exists; reject it");
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(execFileSync("git", ["-C", project, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe("1");
    expect(readCandidateMeta(join(candidatesDir(home), "add-entity-field"))?.status).toBe("pending");
  });

  it("given a demo draft whose scratch repository is still there, when it is approved from another directory, then it is committed into the scratch repository only", () => {
    // given the scratch repository, and a reviewer standing somewhere else
    const scratch = gitRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "handbook-elsewhere-"));
    seedCandidate(mined({ demo: true, cwd: scratch }));

    // when it is approved into the project
    const result = approveAndDeliver(
      home, "add-entity-field", elsewhere, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the add-entity-field skill" } },
    );

    // then the mark closes only the fallback: the scratch repository takes the commit as before
    expect(result.ok).toBe(true);
    expect(log()).toContain("add the add-entity-field skill");
    expect(existsSync(join(elsewhere, ".claude"))).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("given you decide, when it is approved, then it is refused because no merge request is opened here", () => {
    // given a mined candidate and a reviewer who delegated the wording
    gitRepo();
    seedCandidate(mined());
    const asked = approveAndDeliver(home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project");
    // when the fingerprint they were shown is handed back
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { delegated: asked.proposalHash } },
    );
    // then delegating is refused: it is an answer about a merge request that is never opened
    expect(result.ok).toBe(false);
    expect(result.error).toContain("merge request");
    expect(existsSync(join(soloSkillsDir(project), "add-entity-field"))).toBe(false);
  });

  it("given a draft carrying a trace of this machine, when it is approved, then nothing is committed", () => {
    // given a mined candidate whose body names this machine's home directory
    gitRepo();
    const dir = seedCandidate(mined());
    const standIn = ["", "Users", "alice", "work", "api"].join("/");
    writeFileSync(join(dir, "SKILL.md"), `---\nname: add-entity-field\ndescription: "d"\n---\n\nRun it in ${standIn}.\n`);
    // when it is approved with wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then the trace stops it before the commit
    expect(result.ok).toBe(false);
    expect(result.error).toContain("home-path");
    expect(log()).toContain("seed");
  });

  it("given a draft carrying a secret, when it is approved, then nothing is committed", () => {
    // given a mined candidate whose reference file holds a credential
    gitRepo();
    const dir = seedCandidate(mined());
    writeFileSync(join(dir, "reference.md"), "export KEY=sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    // when it is approved with wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then the sieve that guards a shared file stops it
    expect(result.ok).toBe(false);
    expect(result.error?.toLowerCase()).toContain("secret");
    expect(log()).toContain("seed");
  });

  function nothingCommitted(): void {
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(log()).toContain("seed");
    expect(readCandidateMeta(join(candidatesDir(home), "add-entity-field"))?.status).toBe("pending");
  }

  it("given a secret in SKILL.md next to a symlink, when it is approved, then nothing is written or committed", () => {
    // given a mined candidate whose body holds a credential and which carries a link out of itself
    gitRepo();
    const dir = seedCandidate(mined());
    writeFileSync(join(dir, "SKILL.md"), `---\nname: add-entity-field\ndescription: "d"\n---\n\nexport KEY=${LIVE_KEY}\n`);
    writeFileSync(join(home, "outside.md"), "elsewhere\n");
    symlinkSync(join(home, "outside.md"), join(dir, "reference.md"));
    // when it is approved with wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then the link refuses it before the copy can skip it, and the key goes nowhere
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not a regular file");
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
    nothingCommitted();
  });

  it("given a secret in a SKILL.md with no frontmatter, when it is approved, then nothing is written or committed", () => {
    // given a mined candidate edited into a body with no frontmatter and a credential in it
    gitRepo();
    const dir = seedCandidate(mined());
    writeFileSync(join(dir, "SKILL.md"), `Steps.\n\nexport KEY=${LIVE_KEY}\n`);
    // when it is approved with wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then the audit's first refusal is a refusal here too, though it never reached the secret
    expect(result.ok).toBe(false);
    expect(result.error).toContain("frontmatter");
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
    nothingCommitted();
  });

  it("given a draft carrying a secret, when it is kept personally, then it is delivered and the secret is marked by its pattern", () => {
    // given a mined candidate whose reference file holds a credential
    const dir = seedCandidate(mined());
    writeFileSync(join(dir, "reference.md"), `export KEY=${LIVE_KEY}\n`);
    const personal = mkdtempSync(join(tmpdir(), "handbook-personal-"));
    try {
      // when it is kept for yourself
      const result = approveAndDeliver(
        home, "add-entity-field", "/fallback", "2026-10-01T00:00:00Z",
        null, undefined, undefined, "personal", personal,
      );
      // then it installs, since it stays on this machine, and the record names the pattern and the file
      expect(result).toMatchObject({ ok: true, mode: "personal" });
      const recorded = readCandidateMeta(dir);
      expect(recorded?.hygiene).toEqual({ secret: { pattern: "anthropic-api-key", file: "reference.md" } });
      expect(JSON.stringify(recorded)).not.toContain(LIVE_KEY);
    } finally {
      rmSync(personal, { recursive: true, force: true });
    }
  });

  it("given unrelated work already staged, when a mined draft is committed, then that work is left staged and out of the commit", () => {
    // given a reviewer who had staged something of their own before approving
    gitRepo();
    seedCandidate(mined());
    writeFileSync(join(project, "mine.txt"), "my own work in progress\n");
    execFileSync("git", ["-C", project, "add", "mine.txt"]);
    // when the mined draft is approved
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then the commit holds the skill alone and their work is still staged, still theirs
    expect(result.ok).toBe(true);
    const files = execFileSync("git", ["-C", project, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    expect(files).toContain(".claude/skills/add-entity-field/SKILL.md");
    expect(files).not.toContain("mine.txt");
    const staged = execFileSync("git", ["-C", project, "diff", "--cached", "--name-only"], { encoding: "utf8" });
    expect(staged).toContain("mine.txt");
  });

  it("given .claude is ignored by the repository, when a mined draft is approved, then it is refused and no directory is left behind", () => {
    // given a repository whose .gitignore excludes the directory a project skill lives in
    gitRepo();
    writeFileSync(join(project, ".gitignore"), ".claude/\n");
    execFileSync("git", ["-C", project, "add", "-A"]);
    execFileSync("git", ["-C", project, "commit", "-m", "ignore .claude"], { stdio: "ignore" });
    seedCandidate(mined());
    // when it is approved with wording
    const result = approveAndDeliver(
      home, "add-entity-field", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project",
      undefined, { commitMessage: { message: "add the skill" } },
    );
    // then it fails closed: no half-installed skill, and the candidate is still waiting
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ignored by this repository's .gitignore");
    expect(result.error).toContain("--to personal");
    // the advice has to be the form git actually honours: measured, a re-include under a
    // directory excluded outright does nothing, which is what the first wording told people to do
    expect(result.error).toContain(".claude/*");
    expect(result.error).toContain("!.claude/skills/");
    // the directories the install made go too, or "nothing was written" is not true
    expect(existsSync(join(project, ".claude"))).toBe(false);
    expect(readCandidateMeta(join(candidatesDir(home), "add-entity-field"))?.status).toBe("pending");
  });

  it("given an ordinary harvested candidate, when it is approved into the project, then it still installs without being asked for a message", () => {
    // given a candidate the harvest produced rather than the miner
    gitRepo();
    seedCandidate(meta({ slug: "fix-npm-test", origin: "harvest" }));
    // when it is approved into the project
    const result = approveAndDeliver(home, "fix-npm-test", project, "2026-10-01T00:00:00Z", null, runGit, undefined, "project");
    // then the route it always took is unchanged: files copied, no commit, no question
    expect(result.ok).toBe(true);
    expect(result.commitMessage).toBeUndefined();
    expect(log()).toContain("seed");
  });
});
