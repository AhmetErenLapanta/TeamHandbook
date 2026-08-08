import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateMetaFile,
  candidateMetaFromArtifact,
  decideCandidate,
  formatCandidateList,
  isSafeSlug,
  listCandidates,
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
      expect(listCandidates(home, "pending").map((m) => m.slug)).toEqual(["older", "newer"]);
      expect(listCandidates(home).map((m) => m.slug)).toEqual(["done", "older", "newer"]);
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
      const text = formatCandidateList([meta(), meta({ slug: "other", gate: null })]);
      expect(text).toContain("Pending candidates (2):");
      expect(text).toContain("1. fix-npm-test  [team]  gate 8/10");
      expect(text).toContain("Use when npm test fails with a stale snapshot.");
      expect(text).toContain("2. other  [team]  gate n/a");
    });

    it("says so when there is nothing pending", () => {
      expect(formatCandidateList([])).toBe("No pending candidates.");
    });
  });
});
