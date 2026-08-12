import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionStartSummary,
  pendingHarvestCount,
  pendingTeamNudge,
  diffNewSkills,
  heartbeatDelta,
  isFirstRun,
  loadNotifyConfig,
  seenSkillsFile,
  sessionStartNotice,
  weeklyDigest,
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
      expect(text).toContain("Nothing installs or ships without your say-so");
      // discloses the transcript read + its kill switch up front, and points at doctor
      expect(text).toContain("your prompts included, secrets redacted");
      expect(text).toContain('"harvest": {"enabled": false}');
      expect(text).toContain("/handbook:doctor");
    });

    it("shows the heartbeat only when there is activity and nothing stronger to say", () => {
      const active = buildSessionStartSummary({
        pending: 0,
        newSkills: [],
        heartbeat: { failures: 3, pairs: 1, gateErrors: 0 },
      });
      expect(active).toContain("3 failures watched");
      expect(active).toContain("1 error→fix pair captured");

      const idle = buildSessionStartSummary({ pending: 0, newSkills: [], heartbeat: { failures: 0, pairs: 0, gateErrors: 0 } });
      expect(idle).toBeNull();

      const withPending = buildSessionStartSummary({
        pending: 1,
        newSkills: [],
        heartbeat: { failures: 3, pairs: 1, gateErrors: 0 },
      });
      expect(withPending).not.toContain("since your last session -");
    });
  });

  describe("heartbeatDelta / isFirstRun", () => {
    it("is first-run exactly once", () => {
      expect(isFirstRun(home)).toBe(true);
      expect(isFirstRun(home)).toBe(false);
    });

    it("reports activity since the previous call and then resets", () => {
      bumpCounter("bashFailuresCaptured", home, 2);
      expect(heartbeatDelta(home)).toEqual({ failures: 2, pairs: 0, gateErrors: 0 });
      expect(heartbeatDelta(home)).toEqual({ failures: 0, pairs: 0, gateErrors: 0 });
      bumpCounter("pairsResolved", home);
      expect(heartbeatDelta(home)).toEqual({ failures: 0, pairs: 1, gateErrors: 0 });
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

describe("pendingTeamNudge (solo → team growth bridge)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-teamnudge-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function approveN(home: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const dir = join(candidatesDir(home), `skill-${i}`);
      mkdirSync(dir, { recursive: true });
      writeCandidateMeta(dir, {
        slug: `skill-${i}`,
        status: "approved",
        createdAt: "2026-08-08T00:00:00Z",
        scope: "team",
        description: "d",
        fingerprint: `fp${i}`,
        sessionId: "s1",
        gate: null,
      });
    }
  }

  it("fires exactly once after enough solo approvals", () => {
    approveN(home, 3);
    const nudge = pendingTeamNudge(home);
    expect(nudge).toContain("3 approved skills");
    expect(nudge).toContain("/handbook:init");
    expect(pendingTeamNudge(home)).toBeNull();
  });

  it("stays silent below the threshold or when a team repo is configured", () => {
    approveN(home, 2);
    expect(pendingTeamNudge(home)).toBeNull();
    saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "t" }, home);
    approveN(home, 5);
    expect(pendingTeamNudge(home)).toBeNull();
  });
});

describe("gate failure push (B3)", () => {
  it("pushes a gate-outage line regardless of other content", () => {
    const notice = buildSessionStartSummary({
      pending: 1,
      newSkills: [],
      heartbeat: { failures: 0, pairs: 0, gateErrors: 3 },
    });
    expect(notice).toContain("3 gate runs failed since your last session");
    expect(notice).toContain("/handbook:doctor");
  });
});

describe("pendingHarvestCount", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-pbc-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeJob(name: string, sessionId: string): void {
    const dir = join(home, "pending");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), JSON.stringify({ sessionId, cwd: "/p", evidence: { pairs: [], recurrence: {} } }));
  }

  it("counts queued AND in-flight harvests, ignoring malformed and non-json entries", () => {
    writeJob("s-1.json", "s1");
    writeJob("s-2.json", "s2");
    writeJob("s-3.json.claimed-999", "s3"); // in flight: a runner holds this claim
    writeFileSync(join(home, "pending", "broken.json"), "not json");
    writeFileSync(join(home, "pending", "note.txt"), "noise");
    expect(pendingHarvestCount(home)).toBe(3);
  });

  it("is zero with no pending directory", () => {
    expect(pendingHarvestCount(home)).toBe(0);
  });
});

describe("harvest headline (v2 session-start ask)", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-harvestline-"));
    cwd = mkdtempSync(join(tmpdir(), "handbook-proj2-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function harvestCandidate(slug: string, total: number): void {
    const dir = join(candidatesDir(home), slug);
    mkdirSync(dir, { recursive: true });
    writeCandidateMeta(dir, {
      slug, status: "pending", createdAt: "2026-08-10T00:00:00Z", scope: "team",
      description: "d", fingerprint: `fp-${slug}`, sessionId: "s1",
      gate: { total, scores: {} }, origin: "harvest", kind: "correction",
      suggestedTarget: "personal",
    });
  }

  it("headlines the best harvested lesson with the keep/share/skip ask", () => {
    harvestCandidate("prefer-config-flags", 8);
    harvestCandidate("minor-discovery", 5);
    sessionStartNotice(cwd, home); // consume first-run welcome
    const notice = sessionStartNotice(cwd, home)!;
    expect(notice).toContain('TeamHandbook learned from your last session: "prefer-config-flags" (correction, 8/10)');
    expect(notice).toContain("(+1 more)");
    expect(notice).toContain("keep it for yourself, add it to this repo, or share it with the team");
    // harvested items are not double-counted in the plain pending line
    expect(notice).not.toContain("candidate skills are awaiting");
  });

  it("keeps the plain review line for non-harvest candidates", () => {
    writePendingCandidate(home, "manual-learn");
    sessionStartNotice(cwd, home);
    const notice = sessionStartNotice(cwd, home)!;
    expect(notice).toContain("1 candidate skill is awaiting your review");
    expect(notice).not.toContain("learned from your last session");
  });
});

describe("weeklyDigest", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-digest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const t0 = Date.parse("2026-08-01T00:00:00Z");

  function decided(slug: string, mode: "personal" | "team", decidedAt: string): void {
    const dir = join(candidatesDir(home), slug);
    mkdirSync(dir, { recursive: true });
    writeCandidateMeta(dir, {
      slug, status: "approved", createdAt: decidedAt, scope: "team", description: "d",
      fingerprint: `fp-${slug}`, sessionId: "s1", gate: null, decidedAt, deliveredMode: mode,
    });
  }

  it("starts the clock silently, then reports the week's decisions exactly once", () => {
    expect(weeklyDigest(home, t0)).toBeNull(); // first call only baselines
    expect(weeklyDigest(home, t0 + WEEK + 1000)).toBeNull(); // a week passed but nothing happened

    decided("kept-one", "personal", new Date(t0 + WEEK + 2000).toISOString());
    decided("shared-one", "team", new Date(t0 + WEEK + 3000).toISOString());
    writePendingCandidate(home, "still-waiting");

    const line = weeklyDigest(home, t0 + 2 * WEEK + 5000)!;
    expect(line).toContain("your week:");
    expect(line).toContain("1 skill kept");
    expect(line).toContain("1 shared with the team");
    expect(line).toContain("1 waiting for your call");
    // not again until the next interval
    expect(weeklyDigest(home, t0 + 2 * WEEK + 6000)).toBeNull();
  });
});

describe("an honest empty harvest is not silence", () => {
  it("says it found nothing rather than showing a blank screen", () => {
    const text = buildSessionStartSummary({ pending: 0, newSkills: [], harvestedNothing: true })!;
    expect(text).toContain("found nothing worth keeping");
    expect(text).toContain("normal answer, not a failure");
  });

  it("stays quiet about it when there is a real lesson to show instead", () => {
    const text = buildSessionStartSummary({
      pending: 0,
      newSkills: [],
      harvestedNothing: true,
      harvested: { name: "x", kind: "correction", total: 8, more: 0 },
    })!;
    expect(text).not.toContain("found nothing");
    expect(text).toContain("learned from your last session");
  });
});

describe("harvest headline with a repeated teaching", () => {
  const base = { pending: 0, newSkills: [] };

  it("given a lesson taught for the first time, when announced, then it does not claim repetition", () => {
    const out = buildSessionStartSummary({
      ...base,
      harvested: { name: "no-db-mocks", kind: "correction", total: 8, more: 0 },
    });

    expect(out).not.toContain("sessions");
  });

  it("given a lesson the developer has taught before, when announced, then the headline says how many sessions", () => {
    const out = buildSessionStartSummary({
      ...base,
      harvested: { name: "no-db-mocks", kind: "correction", total: 8, more: 0, taughtBefore: 2 },
    });

    expect(out).toContain("TeamHandbook learned something you have now told Claude in 3 sessions");
  });
});

describe("pending queue with a lesson taught again", () => {
  it("given a pending candidate the developer keeps re-teaching, when announced, then the wait is the point", () => {
    const out = buildSessionStartSummary({
      pending: 1,
      newSkills: [],
      pendingRepeats: 3,
    });

    expect(out).toContain("told Claude one of these in 3 sessions now, and it is still waiting");
  });

  it("given pending candidates taught only once, when announced, then it stays the plain reminder", () => {
    const out = buildSessionStartSummary({ pending: 2, newSkills: [] });

    expect(out).toContain("run /handbook:review to approve or reject");
    expect(out).not.toContain("sessions now");
  });
});

describe("which harvested lesson gets the headline", () => {
  it("given a repeated lesson and a higher-scoring one-off, when announced, then the repeated one leads", () => {
    const home = mkdtempSync(join(tmpdir(), "handbook-headline-"));
    const write = (slug: string, total: number, taughtBefore?: number) => {
      mkdirSync(join(home, "candidates", slug), { recursive: true });
      writeFileSync(
        join(home, "candidates", slug, "candidate.json"),
        JSON.stringify({
          status: "pending",
          origin: "harvest",
          kind: "correction",
          description: "d",
          scope: "team",
          createdAt: "2026-08-01T00:00:00Z",
          gate: { total, scores: {} },
          ...(taughtBefore ? { taughtBefore } : {}),
        }),
      );
    };
    write("said-once", 10);
    write("said-four-times", 6, 3);

    const notice = sessionStartNotice(home, home);

    expect(notice).toContain('"said-four-times"');
    expect(notice).toContain("you have now told Claude in 4 sessions");
    rmSync(home, { recursive: true, force: true });
  });
});
