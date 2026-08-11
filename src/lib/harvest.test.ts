import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarvestPrompt,
  harvestFingerprint,
  harvestSession,
  loadHarvestConfig,
  parseHarvestResponse,
  sieveHarvestItems,
  suggestedTargetFor,
} from "./harvest.js";
import type { HarvestEvidence, HarvestItem, HarvestJob } from "./harvest.js";
import { readCandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";
import { UNTRUSTED_OPEN } from "./prompt-safety.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-harvest-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function item(overrides: Partial<HarvestItem> = {}): HarvestItem {
  return {
    kind: "correction",
    name: "prefer-config-feature-flags",
    description: "Use when adding a feature flag.",
    body: "## Rule\n\nFlags live in config, not env vars.",
    expect: "New flags are read from config.",
    scope: "team",
    scores: { recurrence: 1, unfindability: 2, generality: 2, durability: 1, costOfError: 1 },
    total: 7,
    quote: "we keep feature flags in config, never env vars",
    ...overrides,
  };
}

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { total: _total, ...rest } = item();
  return { ...rest, ...overrides };
}

const evidence: HarvestEvidence = {
  pairs: [
    {
      fingerprint: "abcdefabcdefabcd",
      family: "npm test",
      command: "npm test",
      error: "1 test failed",
      resolvedCommand: "npm test",
      edits: ["src/app.ts"],
    },
  ],
  work: { families: ["npm test"], exts: [".ts"] },
  recurrence: { abcdefabcdefabcd: 3 },
};

describe("parseHarvestResponse", () => {
  it("parses a valid array and computes totals", () => {
    const parsed = parseHarvestResponse(JSON.stringify([rawItem()]));
    expect(parsed).toHaveLength(1);
    expect(parsed![0]!.total).toBe(7);
  });

  it("extracts the array from surrounding prose and drops invalid items", () => {
    const raw = `Here you go:\n${JSON.stringify([
      rawItem(),
      rawItem({ kind: "nonsense" }),
      rawItem({ scope: "gitlab.evil.com/x" }), // free-form scope is refused
      rawItem({ scores: { recurrence: 5 } }),
      rawItem({ name: "" }),
    ])}\nDone.`;
    expect(parseHarvestResponse(raw)).toHaveLength(1);
  });

  it("fails closed on non-JSON and non-array replies", () => {
    expect(parseHarvestResponse("I could not find any lessons.")).toBeNull();
    expect(parseHarvestResponse('{"kind":"correction"}')).toBeNull();
    expect(parseHarvestResponse("[not json")).toBeNull();
  });

  it("accepts an empty array as a valid answer", () => {
    expect(parseHarvestResponse("[]")).toEqual([]);
  });
  it("given prose after the array containing a bracket, when parsed, then the array is still read", () => {
    const raw =
      '```json\n[]\n```\n\nNothing new here — see [the earlier note] for why.';

    expect(parseHarvestResponse(raw)).toEqual([]);
  });

  it("given a bracket in the prose BEFORE the array, when parsed, then the real array is found", () => {
    const item = {
      kind: "correction",
      name: "n",
      description: "Use when ...",
      body: "b",
      expect: "e",
      scope: "team",
      scores: { recurrence: 1, unfindability: 1, generality: 1, durability: 1, costOfError: 1 },
      total: 5,
    };
    const raw = `Looking at [the session] I found this:\n\n[${JSON.stringify(item)}]`;

    expect(parseHarvestResponse(raw)).toHaveLength(1);
  });

  it("given a body containing brackets and escaped quotes, when parsed, then the array is not cut short", () => {
    const item = {
      kind: "discovery",
      name: "n",
      description: "Use when ...",
      body: 'see [docs](x) and the \\"quoted\\" ] bracket',
      expect: "e",
      scope: "team",
      scores: { recurrence: 1, unfindability: 1, generality: 1, durability: 1, costOfError: 1 },
      total: 5,
    };

    expect(parseHarvestResponse(JSON.stringify([item]))).toHaveLength(1);
  });

  it("given a reply with no array at all, when parsed, then it fails closed", () => {
    expect(parseHarvestResponse("I could not find anything worth keeping.")).toBeNull();
  });

});

describe("sieveHarvestItems", () => {
  const context = {
    existingSkillNames: new Set<string>(),
    muted: new Set<string>(),
    minScore: 4,
    maxPerSession: 3,
  };

  it("vetoes secrets, oversized bodies, duplicates, muted, and below-floor items", () => {
    const { kept, dropped } = sieveHarvestItems(
      [
        item({ name: "leaky", body: "token=sk-proj-abcdef1234567890ABCDEFGH" }),
        item({ name: "huge", body: "x".repeat(9000) }),
        item({ name: "prefer-config-feature-flags" }), // duplicates existing skill
        item({ name: "weak", scores: { recurrence: 0, unfindability: 1, generality: 1, durability: 0, costOfError: 0 }, total: 2 }),
        item({ name: "good-one" }),
      ],
      { ...context, existingSkillNames: new Set(["prefer-config-feature-flags"]) },
    );
    expect(kept.map((i) => i.name)).toEqual(["good-one"]);
    expect(dropped.map((d) => d.reason).sort()).toEqual(["below-floor", "duplicate", "oversized", "secret"]);
  });

  it("caps at maxPerSession keeping the highest scores", () => {
    const items = [5, 8, 6, 9].map((total, i) =>
      item({
        name: `skill-${i}`,
        total,
        scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 2, costOfError: total - 8 >= 0 ? 1 : 0 },
      }),
    );
    const { kept, dropped } = sieveHarvestItems(items, { ...context, maxPerSession: 2 });
    expect(kept.map((i) => i.total)).toEqual([9, 8]);
    expect(dropped.filter((d) => d.reason === "over-cap")).toHaveLength(2);
  });

  it("drops muted fingerprints (reject --never keeps working)", () => {
    const target = item({ name: "silenced" });
    const { kept, dropped } = sieveHarvestItems([target], {
      ...context,
      muted: new Set([harvestFingerprint(target)]),
    });
    expect(kept).toEqual([]);
    expect(dropped[0]?.reason).toBe("muted");
  });
});

describe("harvestFingerprint", () => {
  it("inherits the pair fingerprint for error-fix items", () => {
    expect(harvestFingerprint(item({ kind: "error-fix", source: "pair:abcdefabcdefabcd" }))).toBe(
      "abcdefabcdefabcd",
    );
  });

  it("hashes kind+slug stably otherwise", () => {
    const a = harvestFingerprint(item());
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(harvestFingerprint(item())).toBe(a);
    expect(harvestFingerprint(item({ kind: "discovery" }))).not.toBe(a);
  });
});

describe("suggestedTargetFor", () => {
  it("routes project scopes to project, team scope by team config", () => {
    expect(suggestedTargetFor("gitlab.x.com/a/b", true)).toBe("project");
    expect(suggestedTargetFor("team", true)).toBe("team");
    expect(suggestedTargetFor("team", false)).toBe("personal");
  });
});

describe("buildHarvestPrompt", () => {
  it("fences the conversation and evidence as untrusted data", () => {
    const prompt = buildHarvestPrompt({
      slice: "User: never use Lombok here",
      evidence,
      existingSkills: [{ name: "old-skill", description: "d" }],
      recentDecisions: ["- rejected-one: rejected"],
      maxItems: 3,
    });
    expect(prompt).toContain(UNTRUSTED_OPEN);
    expect(prompt).toContain("never use Lombok");
    expect(prompt).toContain("recurred 3×");
    expect(prompt).toContain("old-skill");
    expect(prompt).toContain("empty array [] is a valid");
  });

  it("given a teaching was flagged, when the prompt is built, then the model is told an empty answer needs a reason", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: { ...evidence, corrections: [{ at: "x", kind: "convention", text: "we never use Lombok" }] },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("stated a rule in their OWN words");
  });

  it("given no teaching was flagged, when the prompt is built, then that instruction is absent", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: { ...evidence, corrections: [] },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).not.toContain("stated a rule in their OWN words");
  });
});

describe("harvestSession (end to end with a fake runner)", () => {
  function job(overrides: Partial<HarvestJob> = {}): HarvestJob {
    const transcript = join(home, "t.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "always run make fmt before committing" } }) + "\n",
    );
    return { sessionId: "s1", cwd: home, transcriptPath: transcript, evidence, ...overrides };
  }

  it("writes candidates with harvest meta from a valid model reply", async () => {
    const reply = JSON.stringify([
      rawItem(),
      rawItem({ kind: "error-fix", name: "fix-npm-snapshot", quote: undefined, source: "pair:abcdefabcdefabcd" }),
    ]);
    const summary = await harvestSession(job(), home, {
      runner: async (prompt) => {
        expect(prompt).toContain("always run make fmt");
        return reply;
      },
      remoteUrl: () => null,
      listSkills: () => [],
      skillDirs: () => [],
    });
    expect(summary.outcome).toBe("harvested");
    expect(summary.written).toEqual(["prefer-config-feature-flags", "fix-npm-snapshot"]);

    const dir = join(candidatesDir(home), "prefer-config-feature-flags");
    const meta = readCandidateMeta(dir)!;
    expect(meta).toMatchObject({
      origin: "harvest",
      kind: "correction",
      suggestedTarget: "personal", // team scope, no team configured
      gate: { total: 7 },
    });
    const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    expect(grounded.quote).toContain("feature flags in config");

    // the error-fix candidate carries its pair receipt
    const fixCase = JSON.parse(
      readFileSync(join(candidatesDir(home), "fix-npm-snapshot", "grounded-case.json"), "utf8"),
    );
    expect(fixCase).toMatchObject({
      fingerprint: "abcdefabcdefabcd",
      command: "npm test",
      resolvedCommand: "npm test",
    });
  });

  it("resolves project scope to the git remote itself (model never controls the string)", async () => {
    const reply = JSON.stringify([rawItem({ scope: "project", name: "repo-specific-rule" })]);
    const summary = await harvestSession(job(), home, {
      runner: async () => reply,
      remoteUrl: () => "git@gitlab.acme.com:team/api.git",
      listSkills: () => [],
      skillDirs: () => [],
    });
    expect(summary.written).toEqual(["repo-specific-rule"]);
    expect(readCandidateMeta(join(candidatesDir(home), "repo-specific-rule"))?.scope).toBe(
      "gitlab.acme.com/team/api",
    );
  });

  it("skips when there is neither transcript nor evidence", async () => {
    const summary = await harvestSession(
      { sessionId: "s1", cwd: home, evidence: { pairs: [], recurrence: {} } },
      home,
      { runner: async () => "[]", listSkills: () => [], skillDirs: () => [] },
    );
    expect(summary.outcome).toBe("skipped");
  });

  it("fails closed on an unparseable reply and a dead runner", async () => {
    const bad = await harvestSession(job(), home, {
      runner: async () => "no lessons today, sorry!",
      listSkills: () => [],
      skillDirs: () => [],
    });
    expect(bad.outcome).toBe("error");
    expect(bad.error).toContain("unparseable");

    const dead = await harvestSession(job(), home, {
      runner: async () => {
        throw new Error("logged out");
      },
      listSkills: () => [],
      skillDirs: () => [],
    });
    expect(dead.outcome).toBe("error");
    expect(dead.written).toEqual([]);
  });

  it("redacts transcript secrets before they reach the prompt", async () => {
    const transcript = join(home, "sec.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        isSidechain: false,
        message: { role: "user", content: "use Bearer sk-proj-abcdef1234567890ABCDEFGH for the call" },
      }) + "\n",
    );
    let seenPrompt = "";
    const summary = await harvestSession(job({ transcriptPath: transcript }), home, {
      runner: async (prompt) => {
        seenPrompt = prompt;
        return "[]";
      },
      listSkills: () => [],
      skillDirs: () => [],
    });
    expect(seenPrompt).not.toContain("sk-proj-");
    expect(seenPrompt).toContain("[redacted:");
    expect(summary.redactedLines).toBe(1);
  });

  it("given the same lesson taught in an earlier session, when harvested again, then the candidate carries the repeat count", async () => {
    const teach = (text: string) => ({
      ...job(),
      evidence: { ...evidence, corrections: [{ at: "2026-08-01T00:00:00Z", kind: "convention", text }] },
    });
    const deps = (name: string) => ({
      runner: async () => JSON.stringify([rawItem({ name, quote: "never mock the database, use testcontainers" })]),
      remoteUrl: () => null,
      listSkills: () => [],
      skillDirs: () => [],
    });

    await harvestSession(teach("we never use mocks for the database here, use testcontainers"), home, deps("first-pass"));
    await harvestSession(teach("don't mock the database — use testcontainers"), home, deps("second-pass"));

    expect(readCandidateMeta(join(candidatesDir(home), "first-pass"))?.taughtBefore).toBeUndefined();
    expect(readCandidateMeta(join(candidatesDir(home), "second-pass"))?.taughtBefore).toBe(1);
  });

  it("given a repeated teaching, when the prompt is built, then the model is told how many earlier sessions taught it", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: {
        ...evidence,
        corrections: [{ at: "2026-08-01T00:00:00Z", kind: "convention", text: "never mock the database" }],
        echoes: [{ text: "never mock the database", priorSessions: 2, firstAt: "2026-07-01T00:00:00Z" }],
      },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("taught this in 2 earlier sessions, first on 2026-07-01");
  });

  it("given a re-teaching that produced nothing new, when harvested, then the pending candidate it duplicates is marked as repeated", async () => {
    const teach = (text: string, sessionId: string) => ({
      ...job({ sessionId }),
      evidence: { ...evidence, corrections: [{ at: "2026-08-01T00:00:00Z", kind: "convention", text }] },
    });
    const withReply = (reply: string) => ({
      runner: async () => reply,
      remoteUrl: () => null,
      listSkills: () => [],
      skillDirs: () => [],
    });
    const item = rawItem({
      name: "no-db-mocks",
      description: "Use when writing database tests — use testcontainers instead of mocks.",
      quote: undefined,
    });

    await harvestSession(
      teach("in this repo we never mock the database, use testcontainers", "s1"),
      home,
      withReply(JSON.stringify([item])),
    );
    await harvestSession(
      teach("don't mock the database — use testcontainers instead", "s2"),
      home,
      withReply("[]"),
    );

    expect(readCandidateMeta(join(candidatesDir(home), "no-db-mocks"))?.taughtBefore).toBe(2);
  });

  it("given an unrelated pending candidate, when a repeat is recorded, then it is left alone", async () => {
    const withReply = (reply: string) => ({
      runner: async () => reply,
      remoteUrl: () => null,
      listSkills: () => [],
      skillDirs: () => [],
    });
    const teach = (text: string, sessionId: string) => ({
      ...job({ sessionId }),
      evidence: { ...evidence, corrections: [{ at: "2026-08-01T00:00:00Z", kind: "convention", text }] },
    });
    const unrelated = rawItem({
      name: "run-migrations-first",
      description: "Use when deploying the api to staging.",
      quote: undefined,
    });

    await harvestSession(
      teach("in this repo we never mock the database, use testcontainers", "s1"),
      home,
      withReply(JSON.stringify([unrelated])),
    );
    const repeat = await harvestSession(
      teach("don't mock the database — use testcontainers instead", "s2"),
      home,
      withReply("[]"),
    );

    expect(repeat.outcome).toBe("harvested");
    expect(readCandidateMeta(join(candidatesDir(home), "run-migrations-first"))?.taughtBefore).toBeUndefined();
  });
});

describe("suggestedTarget routing (regression: a project lesson must never default to team)", () => {
  it("keeps project routing when the repo has no git remote", async () => {
    const transcript = join(home, "t2.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "tests live under test/" } }) + "\n",
    );
    // a team IS configured, and the model says this lesson is repo-specific
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ team: { repoUrl: "git@x:t/s.git", marketplaceName: "t" } }),
    );
    const reply = JSON.stringify([rawItem({ scope: "project", name: "tests-live-under-test-dir" })]);
    await harvestSession(
      { sessionId: "s9", cwd: home, transcriptPath: transcript, evidence },
      home,
      { runner: async () => reply, remoteUrl: () => null, listSkills: () => [], skillDirs: () => [] },
    );
    const meta = readCandidateMeta(join(candidatesDir(home), "tests-live-under-test-dir"))!;
    // scope collapses to "team" for the frontmatter (no remote to name) — but the
    // ROUTING must still follow the model's judgment, or a one-repo rule gets
    // published to the whole team by a bare `approve`.
    expect(meta.suggestedTarget).toBe("project");
  });
});
