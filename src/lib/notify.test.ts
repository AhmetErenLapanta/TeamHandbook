import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionStartSummary,
  diffNewSkills,
  loadNotifyConfig,
  seenSkillsFile,
  sessionStartNotice,
} from "./notify.js";
import { writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

function writeSkill(dir: string, name: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: "d"\n---\n\nBody.\n`);
}

function writePendingCandidate(home: string, slug: string): void {
  const dir = join(candidatesDir(home), slug);
  mkdirSync(dir, { recursive: true });
  const meta: CandidateMeta = {
    slug,
    status: "pending",
    createdAt: "2026-08-08T00:00:00Z",
    scope: "team",
    description: "d",
    fingerprint: "fp",
    sessionId: "s1",
    gate: null,
  };
  writeCandidateMeta(dir, meta);
}

describe("notify", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
    cwd = mkdtempSync(join(tmpdir(), "handbook-proj-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  describe("loadNotifyConfig", () => {
    it("defaults to enabled without a config file", () => {
      expect(loadNotifyConfig(home)).toEqual({ sessionStart: true });
    });

    it("can be switched off via config.json", () => {
      writeFileSync(join(home, "config.json"), JSON.stringify({ notify: { sessionStart: false } }));
      expect(loadNotifyConfig(home)).toEqual({ sessionStart: false });
    });
  });

  describe("diffNewSkills", () => {
    it("treats the first sighting of a directory as baseline and reports nothing", () => {
      expect(diffNewSkills("/proj/.claude/skills", ["a", "b"], home)).toEqual([]);
      expect(JSON.parse(readFileSync(seenSkillsFile(home), "utf8"))).toEqual({
        "/proj/.claude/skills": ["a", "b"],
      });
    });

    it("reports skills added since the last session and advances the baseline", () => {
      diffNewSkills("/proj/.claude/skills", ["a"], home);
      expect(diffNewSkills("/proj/.claude/skills", ["a", "c", "b"], home)).toEqual(["b", "c"]);
      expect(diffNewSkills("/proj/.claude/skills", ["a", "c", "b"], home)).toEqual([]);
    });

    it("tracks each project directory independently", () => {
      diffNewSkills("/p1/.claude/skills", ["a"], home);
      diffNewSkills("/p2/.claude/skills", ["x"], home);
      expect(diffNewSkills("/p1/.claude/skills", ["a", "b"], home)).toEqual(["b"]);
      expect(diffNewSkills("/p2/.claude/skills", ["x"], home)).toEqual([]);
    });
  });

  describe("buildSessionStartSummary", () => {
    it("mentions pending candidates and new skills", () => {
      const text = buildSessionStartSummary(2, ["fix-npm-test"]);
      expect(text).toContain("2 candidate skills are awaiting your review");
      expect(text).toContain("/handbook:review");
      expect(text).toContain("1 new skill available since your last session here: fix-npm-test.");
    });

    it("uses singular wording for a single pending candidate", () => {
      expect(buildSessionStartSummary(1, [])).toContain("1 candidate skill is awaiting");
    });

    it("returns null when there is nothing to announce", () => {
      expect(buildSessionStartSummary(0, [])).toBeNull();
    });
  });

  describe("sessionStartNotice", () => {
    it("announces pending candidates and newly appeared project skills", () => {
      writePendingCandidate(home, "fix-npm-test");
      const skillsDir = join(cwd, ".claude", "skills");
      diffNewSkills(skillsDir, [], home);
      writeSkill(skillsDir, "brand-new-skill");
      const notice = sessionStartNotice(cwd, home);
      expect(notice).toContain("1 candidate skill is awaiting your review");
      expect(notice).toContain("brand-new-skill");
    });

    it("stays silent when notifications are disabled", () => {
      writePendingCandidate(home, "fix-npm-test");
      writeFileSync(join(home, "config.json"), JSON.stringify({ notify: { sessionStart: false } }));
      expect(sessionStartNotice(cwd, home)).toBeNull();
    });

    it("stays silent when there is nothing to report", () => {
      expect(sessionStartNotice(cwd, home)).toBeNull();
    });
  });
});
