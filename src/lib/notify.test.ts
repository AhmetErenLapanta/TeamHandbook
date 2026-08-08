import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionStartSummary,
  diffNewSkills,
  heartbeatDelta,
  isFirstRun,
  loadNotifyConfig,
  seenSkillsFile,
  sessionStartNotice,
} from "./notify.js";
import { bumpCounter } from "./counters.js";
import { saveTeamConfig } from "./init.js";
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
      expect(loadNotifyConfig(home)).toEqual({ sessionStart: true, heartbeat: true });
    });

    it("can be switched off via config.json", () => {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ notify: { sessionStart: false, heartbeat: false } }),
      );
      expect(loadNotifyConfig(home)).toEqual({ sessionStart: false, heartbeat: false });
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
      const text = buildSessionStartSummary({ pending: 2, newSkills: ["fix-npm-test"] });
      expect(text).toContain("2 candidate skills are awaiting your review");
      expect(text).toContain("/handbook:review");
      expect(text).toContain("1 new skill available since your last session here: fix-npm-test.");
    });

    it("uses singular wording for a single pending candidate", () => {
      expect(buildSessionStartSummary({ pending: 1, newSkills: [] })).toContain(
        "1 candidate skill is awaiting",
      );
    });

    it("returns null when there is nothing to announce", () => {
      expect(buildSessionStartSummary({ pending: 0, newSkills: [] })).toBeNull();
    });

    it("welcomes on the first run", () => {
      const text = buildSessionStartSummary({ pending: 0, newSkills: [], firstRun: true });
      expect(text).toContain("TeamHandbook is active");
      expect(text).toContain("Nothing leaves your machine");
    });

    it("shows the heartbeat only when there is activity and nothing stronger to say", () => {
      const active = buildSessionStartSummary({
        pending: 0,
        newSkills: [],
        heartbeat: { failures: 3, pairs: 1 },
      });
      expect(active).toContain("3 failures watched");
      expect(active).toContain("1 error→fix pair captured");

      const idle = buildSessionStartSummary({ pending: 0, newSkills: [], heartbeat: { failures: 0, pairs: 0 } });
      expect(idle).toBeNull();

      const withPending = buildSessionStartSummary({
        pending: 1,
        newSkills: [],
        heartbeat: { failures: 3, pairs: 1 },
      });
      expect(withPending).not.toContain("since your last session —");
    });
  });

  describe("heartbeatDelta / isFirstRun", () => {
    it("is first-run exactly once", () => {
      expect(isFirstRun(home)).toBe(true);
      expect(isFirstRun(home)).toBe(false);
    });

    it("reports activity since the previous call and then resets", () => {
      bumpCounter("bashFailuresCaptured", home, 2);
      expect(heartbeatDelta(home)).toEqual({ failures: 2, pairs: 0 });
      expect(heartbeatDelta(home)).toEqual({ failures: 0, pairs: 0 });
      bumpCounter("pairsResolved", home);
      expect(heartbeatDelta(home)).toEqual({ failures: 0, pairs: 1 });
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

    it("welcomes on the very first session, then stays silent when idle", () => {
      const first = sessionStartNotice(cwd, home);
      expect(first).toContain("TeamHandbook is active");
      expect(sessionStartNotice(cwd, home)).toBeNull();
    });

    it("announces skills that arrived via the team marketplace", () => {
      saveTeamConfig({ repoUrl: "git@x:t/skills.git", marketplaceName: "acme" }, home);
      const root = join(home, "marketplaces");
      sessionStartNotice(cwd, home, root); // baseline (also consumes the welcome)
      writeSkill(join(root, "acme", "skills"), "teammate-skill");
      const notice = sessionStartNotice(cwd, home, root);
      expect(notice).toContain("teammate-skill");
    });

    it("reports a heartbeat after detector activity, exactly once", () => {
      sessionStartNotice(cwd, home); // consume first-run welcome
      bumpCounter("bashFailuresCaptured", home);
      const notice = sessionStartNotice(cwd, home);
      expect(notice).toContain("1 failure watched");
      expect(sessionStartNotice(cwd, home)).toBeNull();
    });
  });
});
