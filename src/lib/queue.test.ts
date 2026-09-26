import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveCandidate,
  candidateMetaFile,
  candidateMetaFromArtifact,
  decideCandidate,
  formatCandidateList,
  auditSkillDir,
  isSafeSlug,
  listArchiveManifests,
  listCandidates,
  patchPendingCandidate,
  loadMutedFingerprints,
  readArchiveManifest,
  readCandidateMeta,
  formatUnreadableCandidates,
  restoreArchived,
  skillRefusalMessage,
  unreadableCandidates,
  writeArchiveManifest,
  writeCandidateMeta,
} from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import type { SkillArtifact } from "./distill.js";
import type { GateVerdict } from "./score.js";
import { candidatesDir } from "./skill-index.js";

function meta(overrides: Partial<CandidateMeta> = {}): CandidateMeta {
  return {
    slug: "fix-npm-test",
    status: "pending",
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "Use when npm test fails with a stale snapshot.",
    fingerprint: "abc123",
    sessionId: "s1",
    gate: {
      total: 8,
      scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
    },
    ...overrides,
  };
}

function writeCandidateDir(home: string, m: CandidateMeta): string {
  const dir = join(candidatesDir(home), m.slug);
  mkdirSync(dir, { recursive: true });
  writeCandidateMeta(dir, m);
  return dir;
}

describe("queue", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("writeCandidateMeta / readCandidateMeta", () => {
    it("round-trips candidate metadata", () => {
      const dir = writeCandidateDir(home, meta());
      expect(readCandidateMeta(dir)).toEqual(meta());
    });

    it("takes the slug from the directory name, not the file", () => {
      const dir = join(candidatesDir(home), "actual-dir-name");
      mkdirSync(dir, { recursive: true });
      writeCandidateMeta(dir, meta({ slug: "stale-slug" }));
      expect(readCandidateMeta(dir)?.slug).toBe("actual-dir-name");
    });

    it("synthesizes pending metadata from SKILL.md and grounded-case.json when candidate.json is missing", () => {
      const dir = join(candidatesDir(home), "legacy-skill");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "SKILL.md"),
        '---\nname: legacy-skill\ndescription: "Legacy candidate."\nscope: "gitlab.x.com/ekip/bff"\n---\n\nBody.\n',
      );
      writeFileSync(
        join(dir, "grounded-case.json"),
        JSON.stringify({
          fingerprint: "fp9",
          capturedAt: "2026-08-07T00:00:00Z",
          gate: { total: 7, scores: {} },
        }),
      );
      expect(readCandidateMeta(dir)).toEqual({
        slug: "legacy-skill",
        status: "pending",
        createdAt: "2026-08-07T00:00:00Z",
        scope: "gitlab.x.com/ekip/bff",
        description: "Legacy candidate.",
        fingerprint: "fp9",
        sessionId: "",
        gate: { total: 7, scores: {} },
      });
    });

    it("returns null when the directory has neither metadata nor a SKILL.md", () => {
      const dir = join(candidatesDir(home), "empty");
      mkdirSync(dir, { recursive: true });
      expect(readCandidateMeta(dir)).toBeNull();
    });
  });

  describe("candidateMetaFromArtifact", () => {
    it("builds pending metadata from the artifact and the gate verdict", () => {
      const artifact: SkillArtifact = {
        slug: "fix-npm-test",
        scope: "team",
        skillMd: '---\nname: fix-npm-test\ndescription: "Use when npm test fails."\nscope: "team"\n---\n\nBody.\n',
        groundedCase: {
          fingerprint: "abc123",
          capturedAt: "2026-08-08T00:00:00Z",
          command: "npm test",
          error: "1 test failed",
          resolvedCommand: "npm test",
          edits: ["src/app.ts"],
          expect: "npm test exits 0.",
          gate: null,
        },
      };
      const verdict: GateVerdict = {
        signal: {
          ts: "2026-08-08T00:00:00Z",
          sessionId: "s1",
          kind: "candidate",
          fingerprint: "abc123",
          family: "npm test",
          command: "npm test",
          error: "1 test failed",
          cwd: "/repo",
          count: 2,
          edits: ["/repo/src/app.ts"],
        },
        outcome: "promote",
        result: {
          scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
          total: 8,
          pass: true,
          rationale: "recurring and unfindable",
        },
      };
      expect(candidateMetaFromArtifact("fix-npm-test-2", artifact, verdict, "2026-08-08T01:00:00Z")).toEqual({
        slug: "fix-npm-test-2",
        status: "pending",
        createdAt: "2026-08-08T01:00:00Z",
        scope: "team",
        description: "Use when npm test fails.",
        fingerprint: "abc123",
        sessionId: "s1",
        cwd: "/repo",
        gate: {
          total: 8,
          scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
          rationale: "recurring and unfindable",
        },
      });
    });
  });

  describe("listCandidates", () => {
    it("returns an empty list when the queue directory does not exist", () => {
      expect(listCandidates(home)).toEqual([]);
    });

    it("sorts by creation time and filters by status", () => {
      writeCandidateDir(home, meta({ slug: "newer", createdAt: "2026-08-08T02:00:00Z" }));
      writeCandidateDir(home, meta({ slug: "older", createdAt: "2026-08-08T01:00:00Z" }));
      writeCandidateDir(home, meta({ slug: "done", status: "approved" }));
      expect(listCandidates(home, "pending").map((m) => m.slug)).toEqual(["newer", "older"]);
      // newest first; "done" has the default createdAt shared with fix-npm-test
      expect(new Set(listCandidates(home).map((m) => m.slug))).toEqual(new Set(["done", "older", "newer"]));
    });

    it("skips stray files and unreadable directories in the queue", () => {
      writeCandidateDir(home, meta());
      writeFileSync(join(candidatesDir(home), "stray.txt"), "noise");
      mkdirSync(join(candidatesDir(home), "broken"), { recursive: true });
      expect(listCandidates(home).map((m) => m.slug)).toEqual(["fix-npm-test"]);
    });
  });

  describe("decideCandidate", () => {
    it("moves a pending candidate to approved and stamps the decision time", () => {
      const dir = writeCandidateDir(home, meta());
      const result = decideCandidate(home, "fix-npm-test", "approved", "2026-08-08T03:00:00Z");
      expect(result.ok).toBe(true);
      expect(result.meta?.status).toBe("approved");
      expect(result.meta?.decidedAt).toBe("2026-08-08T03:00:00Z");
      expect(JSON.parse(readFileSync(candidateMetaFile(dir), "utf8")).status).toBe("approved");
    });

    it("rejects a second decision on an already-decided candidate", () => {
      writeCandidateDir(home, meta({ status: "rejected" }));
      const result = decideCandidate(home, "fix-npm-test", "approved");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("already rejected");
    });

    it("fails on an unknown candidate", () => {
      const result = decideCandidate(home, "nope", "approved");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("nope");
    });

    it("refuses unsafe slugs without touching the filesystem", () => {
      const result = decideCandidate(home, "../escape", "approved");
      expect(result.ok).toBe(false);
      expect(result.error).toContain("invalid");
    });
  });

  describe("isSafeSlug", () => {
    it.each([
      ["fix-npm-test", true],
      ["a2-b", true],
      ["../escape", false],
      ["has/slash", false],
      ["-leading-dash", false],
      ["", false],
    ])("classifies %s as %s", (slug, expected) => {
      expect(isSafeSlug(slug)).toBe(expected);
    });
  });

  describe("formatCandidateList", () => {
    it("prints slug, scope, gate score, and description per candidate", () => {
      const text = formatCandidateList([meta(), meta({ slug: "other", gate: null })], Date.parse("2026-08-08T00:00:00Z"));
      expect(text).toContain("Pending candidates (2), newest first:");
      expect(text).toContain("1. fix-npm-test  [team]  gate 8/10");
      expect(text).toContain("Use when npm test fails with a stale snapshot.");
      expect(text).toContain("2. other  [team]  gate n/a");
      expect(text).toMatch(/ago/);
    });

    it("says so when there is nothing pending", () => {
      expect(formatCandidateList([])).toBe("No pending candidates.");
    });
  });

  it("given a candidate.json without createdAt, when listing, then it is still listed instead of crashing the queue", () => {
    mkdirSync(join(home, "candidates", "hand-edited"), { recursive: true });
    writeFileSync(
      join(home, "candidates", "hand-edited", "candidate.json"),
      JSON.stringify({ status: "pending", description: "d", scope: "repo" }),
    );

    const listed = listCandidates(home);

    expect(listed.map((c) => c.slug)).toContain("hand-edited");
    expect(listed.find((c) => c.slug === "hand-edited")?.createdAt).toBe("");
  });

  it("given a candidate approved while a background harvest was in flight, when patched, then the approval is not undone", () => {
    const dir = join(home, "candidates", "already-kept");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "candidate.json"),
      JSON.stringify({
        status: "approved",
        description: "d",
        scope: "repo",
        createdAt: "2026-08-01T00:00:00Z",
        deliveredMode: "personal",
        deliveredTo: "/u/.claude/skills/already-kept",
      }),
    );

    const patched = patchPendingCandidate(home, "already-kept", { taughtBefore: 3 });

    expect(patched).toBe(false);
    const meta = readCandidateMeta(dir);
    expect(meta?.status).toBe("approved");
    expect(meta?.deliveredMode).toBe("personal");
    expect(meta?.taughtBefore).toBeUndefined();
  });

  it("given a candidate still pending, when patched, then the amendment lands", () => {
    const dir = join(home, "candidates", "still-waiting");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "candidate.json"),
      JSON.stringify({ status: "pending", description: "d", scope: "repo", createdAt: "2026-08-01T00:00:00Z" }),
    );

    expect(patchPendingCandidate(home, "still-waiting", { taughtBefore: 3 })).toBe(true);
    expect(readCandidateMeta(dir)?.taughtBefore).toBe(3);
  });
});

describe("reject semantics", () => {
  it("a plain reject does not mute; reject with mute records the fingerprint", () => {
    const home2 = mkdtempSync(join(tmpdir(), "handbook-mute-"));
    try {
      for (const slug of ["skill-a", "skill-b"]) {
        const dir = join(candidatesDir(home2), slug);
        mkdirSync(dir, { recursive: true });
        writeCandidateMeta(dir, {
          slug,
          status: "pending",
          createdAt: "2026-08-08T00:00:00Z",
          scope: "team",
          description: "d",
          fingerprint: `fp-${slug}`,
          sessionId: "s1",
          gate: null,
        });
      }
      decideCandidate(home2, "skill-a", "rejected");
      expect(loadMutedFingerprints(home2).size).toBe(0);
      decideCandidate(home2, "skill-b", "rejected", undefined, { mute: true });
      expect([...loadMutedFingerprints(home2)]).toEqual(["fp-skill-b"]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

describe("formatCandidateList age + origin", () => {
  it("shows relative age and origin project", () => {
    const text = formatCandidateList(
      [meta({ createdAt: "2026-08-08T00:00:00Z", cwd: "/Users/me/payments-service" })],
      Date.parse("2026-08-08T03:00:00Z"),
    );
    expect(text).toContain("3h ago");
    expect(text).toContain("from payments-service");
  });
});

describe("formatCandidateList kind badge (v2)", () => {
  it("shows the harvest kind next to the scope", () => {
    const text = formatCandidateList(
      [meta({ kind: "correction", origin: "harvest" })],
      Date.parse("2026-08-08T01:00:00Z"),
    );
    expect(text).toContain("[correction]  [team]");
  });
});

describe("archiving the queue", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-archive-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("given an archived candidate, when it is read back, then it stays archived with its evidence intact", () => {
    const dir = writeCandidateDir(
      home,
      meta({
        slug: "stale-discovery",
        kind: "discovery",
        origin: "harvest",
        sessionId: "s-42",
        suggestedTarget: "personal",
        taughtBefore: 2,
      }),
    );

    const result = archiveCandidate(home, "stale-discovery", "below the discovery bar", "2026-09-16T00:00:00Z");

    expect(result.ok).toBe(true);
    // the resurrection trap: a status readCandidateMeta does not know is not hidden,
    // it is rebuilt as pending by synthesizeMeta and stripped of everything below
    const read = readCandidateMeta(dir);
    expect(read?.status).toBe("archived");
    expect(read?.gate).toEqual(meta().gate);
    expect(read?.taughtBefore).toBe(2);
    expect(read?.sessionId).toBe("s-42");
    expect(read?.suggestedTarget).toBe("personal");
    expect(read?.archivedAt).toBe("2026-09-16T00:00:00Z");
    expect(read?.archiveReason).toBe("below the discovery bar");
  });

  it("given an archived candidate, when the pending queue is listed, then it is gone but the unfiltered list still has it", () => {
    writeCandidateDir(home, meta({ slug: "keeps-waiting" }));
    writeCandidateDir(home, meta({ slug: "swept-away" }));

    archiveCandidate(home, "swept-away", "below the discovery bar");

    expect(listCandidates(home, "pending").map((m) => m.slug)).toEqual(["keeps-waiting"]);
    expect(listCandidates(home, "archived").map((m) => m.slug)).toEqual(["swept-away"]);
    expect(listCandidates(home).map((m) => m.slug).sort()).toEqual(["keeps-waiting", "swept-away"]);
  });

  it("given three archived candidates, when restored from the manifest, then each meta matches its pre-archive snapshot", () => {
    const slugs = ["one-rule", "two-rule", "three-rule"];
    const dirs = slugs.map((slug, i) =>
      writeCandidateDir(home, meta({ slug, kind: "discovery", taughtBefore: i, sessionId: `s-${i}` })),
    );
    const before = dirs.map((dir) => readCandidateMeta(dir));

    const entries = slugs.map((slug) => archiveCandidate(home, slug, "swept", "2026-09-16T00:00:00Z").entry!);
    const file = writeArchiveManifest(home, {
      sweptAt: "2026-09-16T00:00:00Z",
      reason: "swept",
      entries,
    });
    expect(listCandidates(home, "pending")).toEqual([]);

    const restored = restoreArchived(home, readArchiveManifest(file)!);

    expect(restored.restored.sort()).toEqual([...slugs].sort());
    expect(restored.skipped).toEqual([]);
    expect(dirs.map((dir) => readCandidateMeta(dir))).toEqual(before);
    expect(listCandidates(home, "pending").map((m) => m.slug).sort()).toEqual([...slugs].sort());
    expect(listArchiveManifests(home)).toEqual([file]);
  });

  it("given a candidate that is not pending, when archiving is tried, then it is refused", () => {
    writeCandidateDir(home, meta({ slug: "already-kept", status: "approved" }));
    writeCandidateDir(home, meta({ slug: "turned-down", status: "rejected" }));
    writeCandidateDir(home, meta({ slug: "swept-once" }));
    archiveCandidate(home, "swept-once", "swept");

    expect(archiveCandidate(home, "already-kept", "swept").error).toContain("approved");
    expect(archiveCandidate(home, "turned-down", "swept").error).toContain("rejected");
    // archiving twice would record "archived" as the status to restore to
    expect(archiveCandidate(home, "swept-once", "swept").error).toContain("archived");
    expect(readCandidateMeta(join(candidatesDir(home), "already-kept"))?.status).toBe("approved");
  });

  it("given an archived candidate, when a decision is attempted, then the review CLI refuses it", () => {
    writeCandidateDir(home, meta({ slug: "swept-away" }));
    archiveCandidate(home, "swept-away", "swept");

    const result = decideCandidate(home, "swept-away", "approved");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already archived");
  });

  it("given a manifest naming a candidate that was decided since, when restoring, then it is skipped rather than reopened", () => {
    writeCandidateDir(home, meta({ slug: "swept-away" }));
    const entry = archiveCandidate(home, "swept-away", "swept").entry!;
    const dir = join(candidatesDir(home), "swept-away");
    writeCandidateMeta(dir, { ...readCandidateMeta(dir)!, status: "approved" });

    const result = restoreArchived(home, { sweptAt: "2026-09-16T00:00:00Z", reason: "swept", entries: [entry] });

    expect(result.restored).toEqual([]);
    expect(result.skipped).toEqual([{ slug: "swept-away", reason: "already approved" }]);
  });
});

describe("auditSkillDir", () => {
  let local: string;

  beforeEach(() => {
    local = mkdtempSync(join(tmpdir(), "handbook-local-"));
  });

  afterEach(() => {
    rmSync(local, { recursive: true, force: true });
  });

  // A hand-written skill directory, the shape a manager already has on disk: no
  // candidate.json and no grounded-case.json, because nothing harvested it.
  function handWrittenSkill(name: string, extras: Record<string, string> = {}): string {
    const dir = join(local, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: "Use when the nightly report has to be rebuilt by hand."\nscope: "team"\n---\n\nBody.\n`,
    );
    for (const [rel, content] of Object.entries(extras)) {
      const file = join(dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return dir;
  }

  it("given a hand-written SKILL.md, when the directory is audited, then it is shareable with its frontmatter read", () => {
    const dir = handWrittenSkill("rebuild-nightly-report");

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(true);
    expect(audit.summary).toMatchObject({
      name: "rebuild-nightly-report",
      description: "Use when the nightly report has to be rebuilt by hand.",
      scope: "team",
    });
    expect(audit.files).toEqual(["SKILL.md"]);
  });

  it("given the skill carries extra files, when it is audited, then every one of them is in the screened list", () => {
    const dir = handWrittenSkill("rebuild-nightly-report", {
      "references/queries.sql": "select 1;\n",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
    });

    const audit = auditSkillDir(dir);

    // the list the sieve cleared is the list the publisher copies, so a skill whose
    // scripts were left behind cannot reach a teammate looking complete
    expect(audit.shareable).toBe(true);
    expect(audit.files).toEqual(["references/queries.sql", "scripts/run.sh", "SKILL.md"]);
  });

  // The screen runs `detectSecret` over every file, so a rule that reads ordinary prose as a
  // credential does not merely lose a harvest - it refuses a skill someone wrote by hand and
  // tells them it held a secret. Both sentences below were shareable before the field-name
  // rules landed and have to stay shareable.
  it("given a skill whose prose says machine, login and password in netrc order, when it is audited, then it is still shareable", () => {
    const dir = handWrittenSkill("rotate-deploy-credentials", {
      "references/notes.md":
        "Each machine needs login and password set before the first deploy.\n" +
        "The machine used login and password from the netrc file, not the keychain.\n",
    });

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(true);
  });

  it("given a skill documenting BuildKit's own --secret flag, when it is audited, then it is still shareable", () => {
    const dir = handWrittenSkill("build-with-buildkit-secrets", {
      "references/commands.md":
        "docker build --secret id=aws,src=/etc/acme/credentials.ini .\n" +
        "docker buildx build --secret id=npmrc,src=/home/build/.npmrc .\n",
    });

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(true);
  });

  it("given a credential in a file beside SKILL.md, when it is audited, then the whole skill is refused and the file named", () => {
    const dir = handWrittenSkill("rebuild-nightly-report", {
      "scripts/seed.sh": "export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
    });

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("secret");
    expect(audit.secret?.file).toBe("scripts/seed.sh");
    // refused rather than redacted: a skill with a blanked-out script installs and then
    // fails, which is worse than one that never arrives
    expect(skillRefusalMessage("~/skills/rebuild-nightly-report", "rebuild-nightly-report", audit)).toContain(
      "scripts/seed.sh",
    );
  });

  it("given a symlink in the directory, when it is audited, then it is refused rather than followed or dropped", () => {
    const dir = handWrittenSkill("rebuild-nightly-report");
    symlinkSync("/etc/passwd", join(dir, "linked.txt"));

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("irregular-entry");
    expect(audit.detail).toBe("linked.txt");
  });

  it("given no frontmatter, when it is audited, then it is refused as something Claude Code would not load either", () => {
    const dir = join(local, "no-frontmatter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "Just a body.\n");

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("no-frontmatter");
    expect(skillRefusalMessage("~/skills/no-frontmatter", "no-frontmatter", audit)).toContain(
      "no name and description frontmatter",
    );
  });

  it("given no SKILL.md at all, when it is audited, then it is refused by name", () => {
    const dir = join(local, "empty-skill");
    mkdirSync(dir, { recursive: true });

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("no-skill-md");
  });

  it("given a directory name that cannot be a skill name, when it is audited, then it is refused before anything is read", () => {
    const dir = join(local, "Not A Slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");

    const audit = auditSkillDir(dir);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("unsafe-name");
    expect(skillRefusalMessage("~/skills/Not A Slug", "Not A Slug", audit)).toContain("cannot be a skill name");
  });

  it("given the user typed the path, when a refusal names it, then it is echoed exactly rather than shortened", () => {
    const dir = join(local, "no-frontmatter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "Just a body.\n");

    // the caller picks the spelling; the message must not rewrite an argument the user
    // has to recognize as their own
    expect(skillRefusalMessage(dir, "no-frontmatter", auditSkillDir(dir))).toContain(dir);
  });
});

describe("unreadableCandidates", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
    mkdirSync(candidatesDir(home), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function candidateDir(slug: string): string {
    const dir = join(candidatesDir(home), slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("given a candidate.json that is not valid JSON, when the queue is checked, then it is named rather than dropped", () => {
    const dir = candidateDir("torn-write");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: torn-write\ndescription: d\n---\n");
    writeFileSync(candidateMetaFile(dir), "{ not json");

    const broken = unreadableCandidates(home);

    // readCandidateMeta synthesizes a fresh "pending" from the frontmatter here, which is
    // the resurrection the status list exists to prevent - so the file has to be visible
    expect(broken).toEqual([
      { slug: "torn-write", reason: "its candidate.json is not valid JSON", listed: true },
    ]);
    // and the message must not claim it is shown nowhere: it is in the listing above,
    // which is exactly what makes a decided candidate reappear as new
    const text = formatUnreadableCandidates(broken);
    expect(text).toContain("torn-write - its candidate.json is not valid JSON");
    expect(text).toContain("ARE listed above as pending");
    expect(text).not.toContain("counted nowhere");
    expect(listCandidates(home, "pending").map((c) => c.slug)).toEqual(["torn-write"]);
  });

  it("given a status nothing recognizes, when the queue is checked, then the file is named instead of silently reset", () => {
    const dir = candidateDir("unknown-status");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: unknown-status\ndescription: d\n---\n");
    writeFileSync(candidateMetaFile(dir), JSON.stringify({ status: "shipped", description: "d", scope: "team" }));

    expect(unreadableCandidates(home)).toEqual([
      { slug: "unknown-status", reason: 'its candidate.json has an unknown status "shipped"', listed: true },
    ]);
  });

  it("given a directory with neither metadata nor frontmatter, when the queue is checked, then it is named", () => {
    candidateDir("empty-dir");

    const broken = unreadableCandidates(home);

    // nothing rescues this one, so it really is invisible and the message says so
    expect(broken).toEqual([
      { slug: "empty-dir", reason: "it has no candidate.json and no readable SKILL.md frontmatter", listed: false },
    ]);
    expect(formatUnreadableCandidates(broken)).toContain("counted nowhere and shown nowhere else");
    expect(listCandidates(home, "pending")).toEqual([]);
  });

  it("given a candidate with no candidate.json but good frontmatter, when the queue is checked, then it is NOT reported", () => {
    const dir = candidateDir("hand-written");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: hand-written\ndescription: d\n---\n");

    // synthesis is the intended path for a missing file and produces a reviewable
    // candidate, so reporting it would cry wolf on every one of them
    expect(unreadableCandidates(home)).toEqual([]);
    expect(listCandidates(home, "pending").map((c) => c.slug)).toEqual(["hand-written"]);
    expect(formatUnreadableCandidates([])).toBe("");
  });

  it("given a healthy candidate, when the queue is checked, then nothing is reported", () => {
    const dir = candidateDir("healthy");
    writeFileSync(join(dir, "SKILL.md"), "---\nname: healthy\ndescription: d\n---\n");
    writeCandidateMeta(dir, {
      slug: "healthy",
      status: "pending",
      createdAt: "2026-09-01T00:00:00Z",
      scope: "team",
      description: "d",
      fingerprint: "f",
      sessionId: "s",
      gate: null,
    });

    expect(unreadableCandidates(home)).toEqual([]);
  });
});
