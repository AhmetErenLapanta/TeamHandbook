import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  candidateMetaFile,
  candidateMetaFromArtifact,
  decideCandidate,
  formatCandidateList,
  intakeSkill,
  isSafeSlug,
  listCandidates,
  patchPendingCandidate,
  loadMutedFingerprints,
  readCandidateMeta,
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

describe("intakeSkill", () => {
  let home: string;
  let local: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
    local = mkdtempSync(join(tmpdir(), "handbook-local-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(local, { recursive: true, force: true });
  });

  // A hand-written skill directory, the shape a manager already has on disk: no
  // candidate.json and no grounded-case.json, because nothing harvested it.
  function handWrittenSkill(
    name: string,
    extras: Record<string, string> = {},
  ): string {
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

  it("given a hand-written SKILL.md, when it is taken in, then the queue reads it as pending", () => {
    const source = handWrittenSkill("rebuild-nightly-report");

    const result = intakeSkill(source, home);

    expect(result.ok).toBe(true);
    expect(result.slug).toBe("rebuild-nightly-report");
    // no candidate.json is written: the meta comes from the frontmatter via synthesizeMeta
    const dir = join(candidatesDir(home), "rebuild-nightly-report");
    expect(existsSync(candidateMetaFile(dir))).toBe(false);
    const meta = readCandidateMeta(dir);
    expect(meta?.status).toBe("pending");
    expect(meta?.scope).toBe("team");
    expect(meta?.description).toBe("Use when the nightly report has to be rebuilt by hand.");
    expect(listCandidates(home, "pending").map((m) => m.slug)).toContain("rebuild-nightly-report");
  });

  it("given a skill with scripts and references, when it is taken in, then every file comes with it", () => {
    const source = handWrittenSkill("rebuild-nightly-report", {
      "preflight.sh": "#!/bin/sh\necho ready\n",
      "scripts/server.cjs": "module.exports = {};\n",
      "references/queries.sql": "select count(*) from orders;\n",
    });

    const result = intakeSkill(source, home);

    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(4);
    const dir = join(candidatesDir(home), "rebuild-nightly-report");
    expect(readFileSync(join(dir, "preflight.sh"), "utf8")).toContain("echo ready");
    expect(readFileSync(join(dir, "scripts", "server.cjs"), "utf8")).toContain("module.exports");
    expect(readFileSync(join(dir, "references", "queries.sql"), "utf8")).toContain("select count(*)");
  });

  it("given a secret in a file that is not SKILL.md, when it is taken in, then nothing is written to the queue", () => {
    // the scan cannot stop at SKILL.md: the credential lives in the file the skill runs
    const source = handWrittenSkill("rebuild-nightly-report", {
      "references/queries.sql": "-- connect first\nPGPASSWORD=hunter2trustno1 psql -h db -U reports\n",
    });

    const result = intakeSkill(source, home);

    expect(result.ok).toBe(false);
    expect(result.secret?.file).toBe("references/queries.sql");
    expect(result.error).toContain("references/queries.sql");
    // the refusal happens BEFORE the copy: the candidate directory was never created,
    // so not even the clean SKILL.md reached the queue
    expect(existsSync(join(candidatesDir(home), "rebuild-nightly-report"))).toBe(false);
    expect(listCandidates(home)).toEqual([]);
  });

  it("given a secret in SKILL.md itself, when it is taken in, then it is refused too", () => {
    const dir = join(local, "rebuild-nightly-report");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      '---\nname: rebuild-nightly-report\ndescription: "Rebuild the report."\n---\n\n' +
        "Authenticate with token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 first.\n",
    );

    const result = intakeSkill(dir, home);

    expect(result.ok).toBe(false);
    expect(result.secret?.file).toBe("SKILL.md");
    expect(existsSync(join(candidatesDir(home), "rebuild-nightly-report"))).toBe(false);
  });

  it("given a refusal, when the skill is fixed, then it is refused for the secret and not for a leftover directory", () => {
    // proves the failed intake left no half-built candidate that would block a retry
    const source = handWrittenSkill("rebuild-nightly-report", {
      "notes.md": "export API_KEY=sk_live_0123456789abcdef0123\n",
    });
    expect(intakeSkill(source, home).ok).toBe(false);

    writeFileSync(join(source, "notes.md"), "no credentials here\n");
    const retry = intakeSkill(source, home);

    expect(retry.ok).toBe(true);
    expect(retry.fileCount).toBe(2);
  });

  it("given a symlink in the skill, when it is taken in, then it is refused rather than silently dropped", () => {
    const source = handWrittenSkill("rebuild-nightly-report");
    symlinkSync(join(local, "elsewhere.txt"), join(source, "linked.txt"));

    const result = intakeSkill(source, home);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("linked.txt");
    expect(existsSync(join(candidatesDir(home), "rebuild-nightly-report"))).toBe(false);
  });

  it("given a slug already in the queue, when it is taken in again, then the queued one is left alone", () => {
    const source = handWrittenSkill("rebuild-nightly-report");
    expect(intakeSkill(source, home).ok).toBe(true);
    writeFileSync(join(source, "SKILL.md"), '---\nname: rebuild-nightly-report\ndescription: "Rewritten."\n---\n\nNew body.\n');

    const result = intakeSkill(source, home);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already in the review queue");
    const queued = join(candidatesDir(home), "rebuild-nightly-report", "SKILL.md");
    expect(readFileSync(queued, "utf8")).toContain("Body.");
  });

  it("given a directory with no SKILL.md, when it is taken in, then it is refused", () => {
    const dir = join(local, "not-a-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.md"), "just notes\n");

    const result = intakeSkill(dir, home);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no readable SKILL.md");
    expect(existsSync(join(candidatesDir(home), "not-a-skill"))).toBe(false);
  });

  it("given a SKILL.md without frontmatter, when it is taken in, then it is refused", () => {
    const dir = join(local, "bare-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# just a heading\n");

    const result = intakeSkill(dir, home);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("frontmatter");
    expect(existsSync(join(candidatesDir(home), "bare-skill"))).toBe(false);
  });

  it("given a directory name that is not a safe slug, when it is taken in, then it is refused", () => {
    const dir = join(local, "Not A Slug");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), '---\nname: x\ndescription: "y"\n---\n\nBody.\n');

    const result = intakeSkill(dir, home);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot be a skill name");
  });
});
