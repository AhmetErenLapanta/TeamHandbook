import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { archiveCandidate, readCandidateMeta, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
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

// What the model was actually shown. parseHarvestResponse now needs it: an item
// whose anchor cannot be found in this text is refused.
const grounding = {
  slice: "User: we keep feature flags in config, never env vars",
  corrections: ["we keep feature flags in config, never env vars"],
  pairFingerprints: new Set(["abcdefabcdefabcd"]),
};

describe("parseHarvestResponse", () => {
  it("parses a valid array and computes totals", () => {
    const parsed = parseHarvestResponse(JSON.stringify([rawItem()]), grounding);
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
    expect(parseHarvestResponse(raw, grounding)).toHaveLength(1);
  });

  it("fails closed on non-JSON and non-array replies", () => {
    expect(parseHarvestResponse("I could not find any lessons.", grounding)).toBeNull();
    expect(parseHarvestResponse('{"kind":"correction"}', grounding)).toBeNull();
    expect(parseHarvestResponse("[not json", grounding)).toBeNull();
  });

  it("accepts an empty array as a valid answer", () => {
    expect(parseHarvestResponse("[]", grounding)).toEqual([]);
  });
  it("given prose after the array containing a bracket, when parsed, then the array is still read", () => {
    const raw =
      '```json\n[]\n```\n\nNothing new here — see [the earlier note] for why.';

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given a bracket in the prose BEFORE the array, when parsed, then the real array is found", () => {
    const item = {
      kind: "correction",
      name: "n",
      description: "Use when ...",
      body: "b",
      expect: "e",
      quote: "we keep feature flags in config, never env vars",
      scope: "team",
      scores: { recurrence: 1, unfindability: 1, generality: 1, durability: 1, costOfError: 1 },
      total: 5,
    };
    const raw = `Looking at [the session] I found this:\n\n[${JSON.stringify(item)}]`;

    expect(parseHarvestResponse(raw, grounding)).toHaveLength(1);
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

    expect(parseHarvestResponse(JSON.stringify([item]), grounding)).toHaveLength(1);
  });

  it("given a reply with no array at all, when parsed, then it fails closed", () => {
    expect(parseHarvestResponse("I could not find anything worth keeping.", grounding)).toBeNull();
  });

  it("given a correction with no quote, when parsed, then it is refused", () => {
    const raw = JSON.stringify([rawItem({ quote: undefined })]);

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given a correction quoting words nobody typed, when parsed, then it is refused", () => {
    const raw = JSON.stringify([rawItem({ quote: "we always deploy straight to production" })]);

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given a quote that differs only in case and spacing, when parsed, then it still counts", () => {
    const raw = JSON.stringify([rawItem({ quote: "We Keep   Feature Flags In Config, Never Env Vars" })]);

    expect(parseHarvestResponse(raw, grounding)).toHaveLength(1);
  });

  it("given a quote the model re-punctuated, when parsed, then it is refused on purpose", () => {
    // Deliberately strict. Of 32 quotes real sessions produced, 31 matched exactly
    // and 1 through its elisions; none needed a looser rule, so a quote that is not
    // what was typed is treated as the model not quoting.
    const raw = JSON.stringify([rawItem({ quote: "We keep feature flags in config -- never env vars!" })]);

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given a long quote whose middle the model elided, when parsed, then every piece is checked and it survives", () => {
    // measured on a real session: a 717-character teaching came back as its opening
    // and closing sentences joined by "...", and an exact-match check refused it
    const elided = rawItem({
      quote: "we keep feature flags in config ... never env vars",
    });

    expect(parseHarvestResponse(JSON.stringify([elided]), grounding)).toHaveLength(1);
  });

  it("given an elided quote with a piece nobody typed, when parsed, then it is still refused", () => {
    const halfInvented = rawItem({
      quote: "we keep feature flags in config ... and we deploy straight to production",
    });

    expect(parseHarvestResponse(JSON.stringify([halfInvented]), grounding)).toEqual([]);
  });

  it("given a quote too short to mean anything, when parsed, then it is refused", () => {
    const raw = JSON.stringify([rawItem({ quote: "we keep" })]);

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given an error-fix naming a pair the session never produced, when parsed, then it is refused", () => {
    const invented = rawItem({
      kind: "error-fix",
      name: "invented-fix",
      quote: undefined,
      source: "pair:0123456789abcdef",
    });

    expect(parseHarvestResponse(JSON.stringify([invented]), grounding)).toEqual([]);
  });

  it("given an error-fix with no source at all, when parsed, then it is refused", () => {
    const raw = JSON.stringify([rawItem({ kind: "error-fix", name: "sourceless", quote: undefined })]);

    expect(parseHarvestResponse(raw, grounding)).toEqual([]);
  });

  it("given an error-fix naming a real pair, when parsed, then it survives", () => {
    const grounded = rawItem({
      kind: "error-fix",
      name: "real-fix",
      quote: undefined,
      source: "pair:abcdefabcdefabcd",
    });

    expect(parseHarvestResponse(JSON.stringify([grounded]), grounding)).toHaveLength(1);
  });

  it("given a discovery, when parsed, then no anchor is demanded of it", () => {
    const raw = JSON.stringify([rawItem({ kind: "discovery", name: "d", quote: undefined })]);

    expect(parseHarvestResponse(raw, grounding)).toHaveLength(1);
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

  it("given three discoveries, when sieved, then only one survives the kind quota", () => {
    const items = [
      item({ kind: "discovery", name: "first-discovery" }),
      item({ kind: "discovery", name: "second-discovery" }),
      item({ kind: "discovery", name: "third-discovery" }),
    ];

    const { kept, dropped } = sieveHarvestItems(items, context);

    expect(kept.map((i) => i.name)).toEqual(["first-discovery"]);
    expect(dropped.map((d) => [d.item.name, d.reason])).toEqual([
      ["second-discovery", "kind-quota"],
      ["third-discovery", "kind-quota"],
    ]);
  });

  it("given a lower-scoring discovery emitted first, when sieved, then IT is the one kept", () => {
    // The whole point of the quota running before the sort. The model is asked for
    // items in priority order; the score is not a better judge of which discovery to
    // keep, so the first one wins even though a later one scores higher.
    const weakFirst = item({
      kind: "discovery",
      name: "emitted-first",
      scores: { recurrence: 0, unfindability: 1, generality: 1, durability: 1, costOfError: 1 },
      total: 4,
    });
    const strongLater = item({
      kind: "discovery",
      name: "emitted-later",
      scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 2, costOfError: 2 },
      total: 10,
    });

    const { kept, dropped } = sieveHarvestItems([weakFirst, strongLater], context);

    expect(kept.map((i) => i.name)).toEqual(["emitted-first"]);
    expect(dropped).toEqual([{ item: strongLater, reason: "kind-quota" }]);
  });

  it("given a first discovery that fails a veto, when sieved, then it does not burn the quota slot", () => {
    // The quota runs after the vetoes on purpose: an item that was never going to be
    // written must not cost the one slot a real discovery could have used.
    const doomed = item({ kind: "discovery", name: "leaky", body: "token=sk-proj-abcdef1234567890ABCDEFGH" });
    const real = item({ kind: "discovery", name: "real-one" });

    const { kept, dropped } = sieveHarvestItems([doomed, real], context);

    expect(kept.map((i) => i.name)).toEqual(["real-one"]);
    expect(dropped.map((d) => d.reason)).toEqual(["secret"]);
  });

  it("given the quota and the per-session cap both bite, when sieved, then each drop keeps its own reason", () => {
    const items = [
      item({ kind: "discovery", name: "kept-discovery", scores: { recurrence: 0, unfindability: 1, generality: 1, durability: 1, costOfError: 1 }, total: 4 }),
      item({ kind: "discovery", name: "second-discovery", total: 10 }),
      item({ kind: "correction", name: "strong-correction", total: 9 }),
      item({ kind: "correction", name: "weaker-correction", total: 8 }),
    ];

    const { kept, dropped } = sieveHarvestItems(items, { ...context, maxPerSession: 2 });

    expect(kept.map((i) => i.name)).toEqual(["strong-correction", "weaker-correction"]);
    expect(dropped.map((d) => [d.item.name, d.reason]).sort()).toEqual([
      ["kept-discovery", "over-cap"],
      ["second-discovery", "kind-quota"],
    ]);
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

  it("given a prompt repeated across sessions, when the prompt is built, then the model is pushed to look at it", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: {
        ...evidence,
        corrections: [{ at: "x", text: "we never use Lombok" }],
        echoes: [{ text: "we never use Lombok", priorSessions: 1, firstAt: "2026-07-01T00:00:00Z" }],
      },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("typed in earlier sessions too");
    expect(prompt).toContain("we never use Lombok");
  });

  it("given the session may have been in any language, when the prompt is built, then the skill is asked for in English and the quote is not", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence,
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("in English, even when the session was");
    expect(prompt).toContain("keep the developer's own");
  });

  it("given a prompt that was never repeated, when the prompt is built, then it is still handed over verbatim", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: { ...evidence, corrections: [{ at: "x", text: "we never use Lombok" }] },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    // the guarantee this block exists for: a rule stated ONCE, which slicing can drop
    expect(prompt).toContain("we never use Lombok");
    expect(prompt).toContain("rule rather than asking for a task");
    expect(prompt).not.toContain("typed in earlier sessions too");
  });

  it("given the prompt is built, then discovery is defined as a way of working, not a fact", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence,
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("a repeatable way of working this session uncovered");
    expect(prompt).toContain("change how the NEXT piece of work is done");
    expect(prompt).not.toContain("a non-obvious convention, environment quirk, or trap uncovered");
    // measured: without this line the model relabelled procedures as discoveries
    // (procedure 7 -> 2, discovery 22 -> 24 across 17 replayed sessions)
    expect(prompt).toContain("is a procedure, not a discovery");
    // the quota is enforced in the sieve either way, but saying so makes the model's
    // own ordering - which is what the quota keeps - worth something
    expect(prompt).toContain("At most ONE");
  });

  it("given the prompt is built, then the two exclusions are stated as exclusions, not as a score hint", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence,
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("anything a stronger model would already get right on its own");
    expect(prompt).toContain("only states a fact about ONE system");
    // the old wording invited the model to keep them with a low score
    expect(prompt).not.toContain("README/tests score low");
  });

  it("given the new criterion, when the prompt is built, then it sits in the instructions and not inside the fence", () => {
    const prompt = buildHarvestPrompt({
      slice: "User: never use Lombok here",
      evidence,
      existingSkills: [{ name: "old-skill", description: "d" }],
      recentDecisions: [],
      maxItems: 3,
    });

    // a rule the model must OBEY cannot live in the block it is told to treat as
    // untrusted data, or the session text could rewrite it
    const fence = prompt.indexOf(UNTRUSTED_OPEN);
    expect(fence).toBeGreaterThan(-1);
    for (const sentence of [
      "a repeatable way of working this session uncovered",
      "anything a stronger model would already get right on its own",
      "only states a fact about ONE system",
    ]) {
      expect(prompt.indexOf(sentence)).toBeGreaterThan(-1);
      expect(prompt.indexOf(sentence)).toBeLessThan(fence);
    }
  });

  it("given the proper-name-strip test, when the prompt is built, then it sits in the instructions and not inside the fence", () => {
    const prompt = buildHarvestPrompt({
      slice: "User: never use Lombok here",
      evidence,
      existingSkills: [{ name: "old-skill", description: "d" }],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("Does a rule that still says what to do survive?");
    const fence = prompt.indexOf(UNTRUSTED_OPEN);
    const sentence = prompt.indexOf("strip every proper name and local, machine-");
    expect(fence).toBeGreaterThan(-1);
    expect(sentence).toBeGreaterThan(-1);
    expect(sentence).toBeLessThan(fence);
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
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "we keep feature flags in config, never env vars. always run make fmt before committing" } }) + "\n",
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
    // the error-fix item now outranks the correction: its pair recurred 3× in the
    // ledger, which is measured evidence, so recurrence is set to 2 rather than left
    // at whatever the model claimed
    expect(summary.written).toEqual(["fix-npm-snapshot", "prefer-config-feature-flags"]);

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

  it("scopes to the edited repository when the session was opened on the umbrella directory", async () => {
    const reply = JSON.stringify([rawItem({ scope: "project", name: "repo-specific-rule" })]);
    const umbrellaJob = job({
      cwd: "/dev/work",
      evidence: {
        ...evidence,
        pairs: [{ ...evidence.pairs[0]!, edits: ["/dev/work/mcp-server/src/Tool.kt"] }],
      },
    });

    const summary = await harvestSession(umbrellaJob, home, {
      runner: async () => reply,
      remoteUrl: (dir) =>
        dir === "/dev/work/mcp-server/src" ? "git@gitlab.acme.com:team/mcp-server.git" : null,
      listSkills: () => [],
      skillDirs: () => [],
    });

    expect(summary.written).toEqual(["repo-specific-rule"]);
    expect(readCandidateMeta(join(candidatesDir(home), "repo-specific-rule"))?.scope).toBe(
      "gitlab.acme.com/team/mcp-server",
    );
  });

  it("stays on team scope when the umbrella session edited two repositories", async () => {
    const reply = JSON.stringify([rawItem({ scope: "project", name: "cross-repo-rule" })]);
    const umbrellaJob = job({
      cwd: "/dev/work",
      evidence: {
        ...evidence,
        pairs: [
          {
            ...evidence.pairs[0]!,
            edits: ["/dev/work/mcp-server/src/Tool.kt", "/dev/work/ai-client/src/Chat.kt"],
          },
        ],
      },
    });

    const summary = await harvestSession(umbrellaJob, home, {
      runner: async () => reply,
      remoteUrl: (dir) =>
        dir === "/dev/work/mcp-server/src"
          ? "git@gitlab.acme.com:team/mcp-server.git"
          : dir === "/dev/work/ai-client/src"
            ? "git@gitlab.acme.com:team/ai-client.git"
            : null,
      listSkills: () => [],
      skillDirs: () => [],
    });

    expect(summary.written).toEqual(["cross-repo-rule"]);
    expect(readCandidateMeta(join(candidatesDir(home), "cross-repo-rule"))?.scope).toBe("team");
  });

  it("skips when there is neither transcript nor evidence", async () => {
    const summary = await harvestSession(
      { sessionId: "s1", cwd: home, evidence: { pairs: [], recurrence: {} } },
      home,
      { runner: async () => "[]", listSkills: () => [], skillDirs: () => [] },
    );
    expect(summary.outcome).toBe("skipped");
  });

  it("given recorded prompts but no transcript and no pair, when harvested, then no model call is made", async () => {
    let called = false;

    const summary = await harvestSession(
      {
        sessionId: "s1",
        cwd: home,
        evidence: {
          pairs: [],
          recurrence: {},
          corrections: [{ at: "2026-08-11T00:00:00Z", text: "what does this function do" }],
        },
      },
      home,
      {
        runner: async () => {
          called = true;
          return "[]";
        },
        listSkills: () => [],
        skillDirs: () => [],
      },
    );

    expect(summary.outcome).toBe("skipped");
    expect(called).toBe(false);
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
      runner: async () => JSON.stringify([rawItem({ name, quote: "we never mock the database, use testcontainers" })]),
      remoteUrl: () => null,
      listSkills: () => [],
      skillDirs: () => [],
    });

    await harvestSession(teach("in this repo we never mock the database, use testcontainers"), home, deps("first-pass"));
    await harvestSession(teach("again, we never mock the database, use testcontainers"), home, deps("second-pass"));

    expect(readCandidateMeta(join(candidatesDir(home), "first-pass"))?.taughtBefore).toBeUndefined();
    expect(readCandidateMeta(join(candidatesDir(home), "second-pass"))?.taughtBefore).toBe(1);
  });

  it("given a repeated teaching, when the prompt is built, then the model is told how many earlier sessions taught it", () => {
    const prompt = buildHarvestPrompt({
      slice: "",
      evidence: {
        ...evidence,
        corrections: [{ at: "2026-08-01T00:00:00Z", text: "never mock the database" }],
        echoes: [{ text: "never mock the database", priorSessions: 2, firstAt: "2026-07-01T00:00:00Z" }],
      },
      existingSkills: [],
      recentDecisions: [],
      maxItems: 3,
    });

    expect(prompt).toContain("also typed in 2 earlier sessions, first on 2026-07-01");
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
      quote: "we never mock the database, use testcontainers",
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
      kind: "procedure",
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
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "tests live under test/, and we keep feature flags in config, never env vars" } }) + "\n",
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

describe("the archive must not swallow the recent-decisions window", () => {
  it("given an archived backlog larger than the window, when a session is harvested, then the real decisions still reach the prompt", async () => {
    const seed = (slug: string, status: CandidateMeta["status"], createdAt: string): void => {
      const dir = join(candidatesDir(home), slug);
      mkdirSync(dir, { recursive: true });
      writeCandidateMeta(dir, {
        slug,
        status: status === "archived" ? "pending" : status,
        createdAt,
        scope: "team",
        description: `${slug} description`,
        fingerprint: `fp-${slug}`,
        sessionId: "s0",
        gate: null,
      });
      if (status === "archived") archiveCandidate(home, slug, "swept");
    };
    // 30 archived candidates, all NEWER than the one real decision: unfiltered, the
    // twenty-wide window is entirely theirs and the prompt's "do not re-propose
    // anything you have already decided" silently stops naming any decision
    for (let i = 0; i < 30; i++) seed(`swept-${i}`, "archived", `2026-09-1${i % 10}T00:00:00Z`);
    seed("really-rejected", "rejected", "2026-08-01T00:00:00Z");

    const transcript = join(home, "t-window.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "always run make fmt before committing" } }) + "\n",
    );
    let seen = "";
    await harvestSession(
      { sessionId: "s-window", cwd: home, transcriptPath: transcript, evidence },
      home,
      {
        runner: async (prompt) => {
          seen = prompt;
          return "[]";
        },
        remoteUrl: () => null,
        listSkills: () => [],
        skillDirs: () => [],
      },
    );

    expect(seen).toContain("really-rejected [rejected]");
    expect(seen).not.toContain("swept-0");
  });
});
