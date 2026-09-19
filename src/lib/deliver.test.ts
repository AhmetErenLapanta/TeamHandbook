import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("never overwrites an existing skill directory; it suffixes instead", () => {
    seedCandidate(meta());
    const occupied = join(soloSkillsDir(project), "fix-npm-test");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "SKILL.md"), "original");
    const result = approveAndDeliver(home, "fix-npm-test");
    expect(result.deliveredTo).toBe(join(soloSkillsDir(project), "fix-npm-test-2"));
    expect(readFileSync(join(occupied, "SKILL.md"), "utf8")).toBe("original");
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
    );

    expect(result).toMatchObject({ ok: true, mode: "team", branch: "HQA-000-fix-npm-test" });
    expect(loadTeamConfig(home)?.branchPrefix).toBe("HQA-000-");
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
    // given a skill of that name already installed in each local destination
    const personalDir = join(home, "personal-skills");
    mkdirSync(join(personalDir, "fix-npm-test"), { recursive: true });
    mkdirSync(join(soloSkillsDir(project), "fix-npm-test"), { recursive: true });
    seedCandidate(meta({ slug: "fix-npm-test" }));

    // when it is approved into the project
    const solo = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "project",
    );

    // then the result names what was written, not what was asked for, and the line the
    // reviewer reads says the same thing
    expect(solo).toMatchObject({ ok: true, deliveredSlug: "fix-npm-test-2", renamedFrom: "fix-npm-test" });
    const printed = formatApproveResult("fix-npm-test", solo);
    expect(printed).toContain('"fix-npm-test-2"');
    expect(printed).toContain('A skill named "fix-npm-test" was already there');
    expect(printed).toContain("--update");

    // and the same holds for the personal destination
    seedCandidate(meta({ slug: "fix-npm-test" }));
    const personal = approveAndDeliver(
      home, "fix-npm-test", project, "2026-08-08T01:00:00Z",
      null, undefined, undefined, "personal", personalDir,
    );
    expect(personal).toMatchObject({ ok: true, deliveredSlug: "fix-npm-test-2" });
    expect(formatApproveResult("fix-npm-test", personal)).toContain('Kept "fix-npm-test-2"');
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
    expect(result.renamedFrom).toBeUndefined();
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

    // then what was there is exactly what is still there
    expect(result.ok).toBe(true);
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
    expect(result.renamedFrom).toBeUndefined();
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
      undefined, undefined, { update: true },
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
      undefined, undefined, { as: "fix-npm-snapshot" },
    );

    expect(result.deliveredSlug).toBe("fix-npm-snapshot");
    // the line the reviewer reads used to print the slug they typed, whatever was written
    expect(formatApproveResult("fix-npm-test", result)).toContain('Shared "fix-npm-snapshot" with the team');
  });
});
