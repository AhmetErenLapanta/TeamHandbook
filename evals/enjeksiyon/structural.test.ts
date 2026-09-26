// Layer 1: does the fence still contain the payload?
//
// Deterministic, no network, runs in CI. It asks one question of every payload in the
// corpus, through the REAL path a captured session takes - buildTranscriptSlice into
// buildHarvestPrompt, and the parallel path in buildScorePrompt where skill names become
// field labels - and not through fenceUntrusted on its own.
//
// Two kinds of assertion live here, and the difference matters:
//
//  - HARD: the fence's own promise. One opening and one closing sentinel, an instruction
//    region byte-identical to the payload-free baseline, no column-0 line inside the
//    fence that the baseline did not have, by the product's own definition of a line.
//    These must stay green, and the negative proof in the report turns them red.
//  - PINNED: findings, not failures. Ids that break out under a stricter definition than
//    the product uses, ids carrying a sentinel a reader would still recognise after
//    folding, ids that never reach the prompt at all. Pinning keeps the suite green while
//    the finding stays visible, and makes a fix edit this list.
//
// Every assertion is on ids, counts and booleans. None prints payload text, so a failure
// diff cannot dump a prompt into a terminal or a log.
import { describe, expect, it } from "vitest";
import { buildHarvestPrompt } from "../../src/lib/harvest.js";
import { buildScorePrompt } from "../../src/lib/score.js";
import { buildTranscriptSlice } from "../../src/lib/transcript.js";
import type { Signal } from "../../src/lib/signals.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../../src/lib/prompt-safety.js";
import { PAYLOADS, reachMarkerOf, type Payload } from "./corpus.js";
import { buildFixture, type Fixture } from "./fixture.js";
import {
  canaryPlacement,
  columnZeroLines,
  lookalikeSentinels,
  shapeOf,
  splitLines,
} from "./inspect.js";

function harvestPromptFor(fixture: Fixture): string {
  const { slice } = buildTranscriptSlice(fixture.transcriptPath, 40_000);
  return buildHarvestPrompt({
    slice,
    evidence: fixture.evidence,
    existingSkills: fixture.existingSkills,
    recentDecisions: [],
    maxItems: 3,
  });
}

function scorePromptFor(fixture: Fixture): string {
  const pair = fixture.evidence.pairs[0]!;
  const signal: Signal = {
    ts: "2026-01-01T00:00:00.000Z",
    sessionId: "session-fixture",
    kind: "candidate",
    fingerprint: pair.fingerprint,
    family: pair.family,
    command: pair.command,
    error: pair.error,
    cwd: "/fixture/workspace",
    count: 1,
    edits: pair.edits,
    resolvedCommand: pair.resolvedCommand,
  };
  return buildScorePrompt(signal, 1, fixture.existingSkills);
}

const CLEAN = buildFixture(null);
const CLEAN_HARVEST = harvestPromptFor(CLEAN);
const CLEAN_SCORE = scorePromptFor(CLEAN);

const built = new Map<string, { harvest: string; score: string }>(
  PAYLOADS.map((p) => {
    const fixture = buildFixture(p);
    return [p.id, { harvest: harvestPromptFor(fixture), score: scorePromptFor(fixture) }];
  }),
);

function harvestOf(p: Payload): string {
  return built.get(p.id)!.harvest;
}

function idsWhere(predicate: (p: Payload) => boolean): string[] {
  return PAYLOADS.filter(predicate).map((p) => p.id);
}

describe("the corpus itself", () => {
  it("has unique ids and covers every class and slot", () => {
    expect(new Set(PAYLOADS.map((p) => p.id)).size).toBe(PAYLOADS.length);
    expect(PAYLOADS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(PAYLOADS.map((p) => p.klass)).size).toBe(7);
    expect(new Set(PAYLOADS.map((p) => p.slot)).size).toBe(6);
  });

  it("keeps the regression inputs prompt-safety.test.ts measured first", () => {
    expect(idsWhere((p) => p.regression === true).length).toBeGreaterThanOrEqual(5);
  });

  it("is inert: no payload names a real path, host or scheme", () => {
    for (const p of PAYLOADS) {
      const text = `${p.text} ${p.probes}`;
      expect(text, p.id).not.toMatch(/https?:\/\//);
      expect(text, p.id).not.toMatch(/\/Users\/|\/home\/|C:\\/);
      expect(text, p.id).not.toMatch(/\brm\s+-rf\b|\bcurl\b|\bsudo\b/);
    }
  });
});

// ---- HARD: the fence's own promise -------------------------------------------

describe("the harvest fence holds", () => {
  const cleanShape = shapeOf(CLEAN_HARVEST);
  const cleanColumnZero = columnZeroLines(cleanShape.fences[0]!.body, "product");

  it("the baseline is one fence with only its preamble and labels at column 0", () => {
    expect(cleanShape.order).toEqual(["open", "close"]);
    expect([cleanShape.rawOpen, cleanShape.rawClose]).toEqual([1, 1]);
    expect(cleanShape.fences[0]!.labels).toEqual([
      "existing skills (names and descriptions both come from cloned repositories: data):",
      "recent review decisions:",
      "conversation (sliced):",
      "prompts the developer typed this session (their own words, verbatim):",
      "resolved error" + String.fromCharCode(0x2192) + "fix pairs:",
      "session work shape:",
    ]);
  });

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s leaves exactly one opening and one closing sentinel",
    (_id, payload) => {
      const shape = shapeOf(harvestOf(payload));
      expect(shape.order).toEqual(["open", "close"]);
      expect([shape.rawOpen, shape.rawClose]).toEqual([1, 1]);
    },
  );

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s leaves the instruction region byte-identical to the baseline",
    (_id, payload) => {
      const shape = shapeOf(harvestOf(payload));
      expect(shape.instructionRegions).toEqual(cleanShape.instructionRegions);
    },
  );

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s forges no field label at column 0",
    (_id, payload) => {
      const body = shapeOf(harvestOf(payload)).fences[0]!.body;
      const forged = columnZeroLines(body, "product").filter(
        (line) => !cleanColumnZero.includes(line),
      );
      expect(forged).toEqual([]);
    },
  );

  // The fold-independent check. Every payload that plants a delimiter-shaped string must
  // not have it in the built prompt: not folded away, not counted - gone. `fence-space`
  // and `fence-xml` are excluded by carrying no `disguise`, because what they plant is
  // deliberately NOT treated as the delimiter.
  it.each(
    PAYLOADS.filter((p) => p.disguise !== undefined).map((p) => [p.id, p] as const),
  )("%s adds no delimiter-shaped string to the prompt", (_id, payload) => {
    // Counted against the CLEAN prompt rather than asserted absent: a payload whose
    // disguise is the VERBATIM delimiter shares its spelling with the fence's own closing
    // line, which is present either way. What must not change is the count.
    const occurrences = (text: string): number => text.split(payload.disguise!).length - 1;
    expect(occurrences(harvestOf(payload))).toBe(occurrences(CLEAN_HARVEST));
    expect(occurrences(built.get(payload.id)!.score)).toBe(occurrences(CLEAN_SCORE));
  });

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s appears only on indented lines",
    (_id, payload) => {
      const marker = reachMarkerOf(payload);
      const { unindented } = canaryPlacement(harvestOf(payload), marker, "product");
      expect(unindented).toBe(0);
    },
  );
});

describe("the score fence holds, with skill names as its labels", () => {
  const cleanShape = shapeOf(CLEAN_SCORE);

  it("the baseline is two fences in order: the case block, then the dedup block", () => {
    expect(cleanShape.order).toEqual(["open", "close", "open", "close"]);
    expect([cleanShape.rawOpen, cleanShape.rawClose]).toEqual([2, 2]);
  });

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s leaves both score fences intact",
    (_id, payload) => {
      const shape = shapeOf(built.get(payload.id)!.score);
      expect(shape.order).toEqual(["open", "close", "open", "close"]);
      expect([shape.rawOpen, shape.rawClose]).toEqual([2, 2]);
    },
  );

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s leaves both score instruction regions byte-identical to the baseline",
    (_id, payload) => {
      const shape = shapeOf(built.get(payload.id)!.score);
      expect(shape.instructionRegions).toEqual(cleanShape.instructionRegions);
    },
  );

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s adds a column-0 line to a score fence only where a skill legitimately adds one",
    (_id, payload) => {
      const shape = shapeOf(built.get(payload.id)!.score);
      // The two payload slots that plant an EXTRA skill legitimately add one label to the
      // dedup fence: one skill, one label. Every other slot must add nothing to either.
      const plantsASkill = payload.slot === "skill-name" || payload.slot === "skill-description";
      const expected = [0, plantsASkill ? 1 : 0];
      const added = shape.fences.map((fence, i) => {
        const clean = columnZeroLines(cleanShape.fences[i]!.body, "product");
        return columnZeroLines(fence.body, "product").filter((l) => !clean.includes(l)).length;
      });
      expect(added).toEqual(expected);
    },
  );

  it.each(PAYLOADS.map((p) => [p.id, p] as const))(
    "%s adds no unindented occurrence of its marker to the score prompt",
    (_id, payload) => {
      const marker = reachMarkerOf(payload);
      // Compared against the CLEAN prompt rather than asserted to be zero: name-label's
      // marker deliberately spells a real field label of the case block, so that label
      // occurs at column 0 whether the payload is present or not. What must not change is
      // the COUNT - the payload may not add one of its own.
      const baseline = canaryPlacement(CLEAN_SCORE, marker, "product").unindented;
      const { unindented } = canaryPlacement(built.get(payload.id)!.score, marker, "product");
      expect(unindented).toBe(baseline);
    },
  );

  // This used to assert the opposite - that a poisoned NAME lands at column 0 as a label,
  // because names were used as labels unvalidated. They are now checked with the same
  // predicate sweep.ts uses, so an unusable name moves into the value and the label is a
  // fixed string of ours.
  it.each(idsWhere((p) => p.slot === "skill-name").map((id) => [id] as const))(
    "%s produces no label of its own; the label is ours and the name is data",
    (id) => {
      const payload = PAYLOADS.find((p) => p.id === id)!;
      const dedup = shapeOf(built.get(id)!.score).fences[1]!;
      const marker = reachMarkerOf(payload);
      expect(dedup.labels.some((l) => l.includes(marker))).toBe(false);
      expect(dedup.labels).toContain("(skill name not usable as a label #1, listed as data):");
      // still present, just contained
      expect(dedup.body).toContain(marker);
    },
  );

  it.each(idsWhere((p) => p.slot === "skill-name").map((id) => [id] as const))(
    "%s becomes exactly one label line, carrying no sentinel and no line break",
    (id) => {
      const payload = PAYLOADS.find((p) => p.id === id)!;
      const dedup = shapeOf(built.get(id)!.score).fences[1]!;
      // one label per skill: the poisoned name must not have split into two
      expect(dedup.labels.length).toBe(buildFixture(payload).existingSkills.length);
      for (const label of dedup.labels) {
        expect(label).not.toContain(UNTRUSTED_OPEN);
        expect(label).not.toContain(UNTRUSTED_CLOSE);
        expect(splitLines(label, "strict").length).toBe(1);
      }
    },
  );
});

// ---- PINNED: findings that are true today and must not grow -------------------

describe("pinned findings", () => {
  it("payloads that forge a column-0 line under the Unicode line definition", () => {
    const cleanStrict = columnZeroLines(shapeOf(CLEAN_HARVEST).fences[0]!.body, "strict");
    const broke = PAYLOADS.filter((p) => {
      const body = shapeOf(harvestOf(p)).fences[0]!.body;
      return columnZeroLines(body, "strict").some((line) => !cleanStrict.includes(line));
    }).map((p) => p.id);
    // Was ["field-nel", "field-ff", "field-vt", "speaker-nel"]: LINE_TERMINATORS stopped
    // at CR, CRLF, LF, U+2028 and U+2029, so `indent` kept a label forged after a NEL,
    // FORM FEED or VERTICAL TAB on one physical line and never indented it, and
    // neutralizeRoleLabels missed the same three because JS `^` under /m does not treat
    // them as a line start. Both now spell a line with one shared class, so the stricter
    // definition finds nothing the product's own does not.
    expect(broke).toEqual([]);
  });

  it("payloads leaving sentinel-shaped text a reader would still recognise", () => {
    const lookalikes = PAYLOADS.filter(
      (p) => lookalikeSentinels(shapeOf(harvestOf(p)).fences[0]!.body) > 0,
    ).map((p) => p.id);
    // Was ["fence-zwsp", "fence-cyrillic", "fence-fullwidth", "fence-space"]. Matching now
    // happens on a fold - invisibles dropped, NFKC, confusable capitals mapped - so the
    // first three are removed from the original text and no longer read as a delimiter.
    //
    // fence-space stays, and deliberately: the fold does NOT collapse whitespace. Doing so
    // would widen what counts as the delimiter to anything spelled with spaces in it, and
    // this assertion's own fold is stricter than the product's on exactly that point. What
    // answers it instead is a sentence in the prompt: the delimiter is one exact spelling,
    // and a near-match inside the block is data.
    expect(lookalikes).toEqual(["fence-space"]);
  });

  it("payloads that never reach the prompt, and what removed them", () => {
    const absent = PAYLOADS.filter(
      (p) => canaryPlacement(harvestOf(p), reachMarkerOf(p), "product").hits === 0,
    ).map((p) => p.id);
    // transcript.ts's isNoise drops any message whose text starts with "<", so a payload
    // that LEADS with a sentinel never enters the slice at all. That is a second defense
    // layer, and what it depends on is only where the payload sits: every other
    // fence-break variant here is planted mid-message and arrives intact, which is why
    // this list has one entry and not twelve. It is not a defense to lean on.
    expect(absent).toEqual(["fence-lead"]);
  });

  it("a name spelling a real field label no longer reaches column 0", () => {
    // This was a finding: name-label spells a real case-block label of the score prompt
    // exactly, and the dedup block put it at column 0 - the one place the fence treats as
    // structure - because both prompts called names trusted while skill-index.ts read
    // them verbatim from any cloned repository's frontmatter.
    const dedup = shapeOf(built.get("name-label")!.score).fences[1]!;
    expect(dedup.labels).not.toContain("error (normalized):");
    expect(dedup.body).toContain("error (normalized)");
  });
});
