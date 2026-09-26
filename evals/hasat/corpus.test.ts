// What has to hold about the corpus before any model is asked anything. Deterministic,
// free, and in the default suite: every one of these was a way an earlier version of a
// measurement in this repository quietly stopped measuring what it claimed to.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscriptTexts } from "../../src/lib/transcript.js";
import { SESSIONS } from "./corpus.js";
import { buildSession, writeTranscript } from "./session.js";
import { shuffledLabels } from "./corpus.js";
import { controlYesRate } from "./metrics.js";
import type { SessionRun } from "./metrics.js";
import { classifyRefusal } from "./tiers.js";

function fold(text: string): string {
  return text.toLowerCase().replace(/['’`"“”]/g, "").replace(/\s+/g, " ").trim();
}

function ngrams(text: string, n: number): Set<string> {
  const words = fold(text).replace(/[^a-z0-9çğıöşü ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

const ALL_LABELS = SESSIONS.flatMap((s) => s.labels.map((l) => ({ session: s, label: l })));

describe("the corpus is a measurement instrument", () => {
  it("has the spread the package claims: kinds, languages, positions, forms, and one session with no lesson", () => {
    expect(SESSIONS.length).toBeGreaterThanOrEqual(20);
    expect(SESSIONS.length).toBeLessThanOrEqual(30);
    expect(SESSIONS.filter((s) => s.labels.length === 0)).toHaveLength(1);
    for (const kind of ["correction", "procedure", "error-fix"] as const) {
      expect(ALL_LABELS.filter((e) => e.label.kind === kind).length, kind).toBeGreaterThanOrEqual(3);
    }
    for (const position of ["opening", "middle", "closing", "repeated"] as const) {
      expect(ALL_LABELS.filter((e) => e.label.position === position).length, position).toBeGreaterThanOrEqual(1);
    }
    for (const form of ["hard-never", "soft-henceforth", "implicit"] as const) {
      expect(ALL_LABELS.filter((e) => e.label.form === form).length, form).toBeGreaterThanOrEqual(3);
    }
    // Most sessions are in English; a few carry the developer's own language, because the
    // correction detectors carry it as data and the harvest prompt has to as well.
    expect(SESSIONS.filter((s) => s.language !== "en").length).toBeGreaterThanOrEqual(3);
    expect(SESSIONS.filter((s) => s.language === "en").length).toBeGreaterThan(SESSIONS.length / 2);
    for (const session of SESSIONS) {
      expect(session.labels.length, session.id).toBeLessThanOrEqual(3);
      expect(session.distractors.length, session.id).toBeGreaterThanOrEqual(1);
      expect(session.distractors.length, session.id).toBeLessThanOrEqual(3);
    }
  });

  it("gives every label and session a unique id, and every label a domain of its own", () => {
    expect(new Set(SESSIONS.map((s) => s.id)).size).toBe(SESSIONS.length);
    expect(new Set(ALL_LABELS.map((e) => e.label.id)).size).toBe(ALL_LABELS.length);
    // One domain per label. Two labels about the same subject would make the
    // shuffled-label control a hard question rather than a wrong one, so its near-zero
    // result would stop being evidence about the grader.
    expect(new Set(ALL_LABELS.map((e) => e.label.domain)).size).toBe(ALL_LABELS.length);
  });

  it("states each lesson in the developer's own turn and nowhere in the assistant's", () => {
    for (const { session, label } of ALL_LABELS) {
      const userTurns = session.turns.filter((t) => t.role === "user" && !t.meta && !t.sidechain);
      const carriers = userTurns.filter((t) => fold(t.text).includes(fold(label.anchor)));
      expect(carriers.length, `${label.id} anchor in user turns`).toBeGreaterThanOrEqual(1);
      for (const turn of session.turns.filter((t) => t.role === "assistant")) {
        expect(fold(turn.text).includes(fold(label.anchor)), `${label.id} anchor leaked into an assistant turn`).toBe(false);
      }
    }
  });

  it("never writes the canonical sentence of a lesson into an assistant turn", () => {
    // The label's own wording is the grader's reference, and the assistant's closing
    // summary is where it would leak: a summary that restates the label turns the whole
    // measurement into a copying test, because an item written from that summary passes
    // the grader without the model having extracted anything.
    //
    // The developer's own turn is held to a looser bound on purpose. A person stating a
    // rule and a one-sentence summary of that rule SHOULD share phrases - "takes a time
    // source as" is the rule - and forbidding that would mean writing user turns that no
    // person would type. What is forbidden there is the label sentence itself, so the
    // bound is eight words rather than five.
    for (const { session, label } of ALL_LABELS) {
      const strict = ngrams(label.lesson, 5);
      const loose = ngrams(label.lesson, 8);
      for (const turn of session.turns) {
        const reference = turn.role === "assistant" ? strict : loose;
        const overlap = [...ngrams(turn.text, turn.role === "assistant" ? 5 : 8)].filter((g) =>
          reference.has(g),
        );
        expect(overlap, `${label.id} canonical wording appears in a ${turn.role} turn`).toEqual([]);
      }
    }
  });

  it("carries no real path, internal identifier or non-public token", () => {
    const source = JSON.stringify(SESSIONS);
    // The repository is public. These are the shapes that have actually leaked into it
    // before: a machine path, and an identifier that only means something internally.
    expect(source).not.toMatch(/\/Users\//);
    expect(source).not.toMatch(/\/home\/[a-z]+\//);
    // A ticket reference is a leak when its prefix is a real one. The prefixes that must
    // not appear are deliberately NOT spelled out here: this repository scans its whole
    // tree for them, and an assertion that names them makes itself the violation. The
    // corpus has no reason to carry a ticket reference of any shape, so none is allowed.
    expect(source).not.toMatch(/\b[A-Z]{2,5}-\d+\b/);
    expect(source).not.toMatch(/\bK-\d+\b/i);
  });

  it("is read back by the product as the conversation it wrote, with the dropped lines dropped", () => {
    for (const session of SESSIONS) {
      const dir = mkdtempSync(join(tmpdir(), "th-hasat-test-"));
      try {
        const entries = readTranscriptTexts(writeTranscript(session, dir));
        expect(entries.length, session.id).toBeGreaterThan(0);
        const joined = entries.map((e) => e.text).join("\n");
        // a subagent line and a line Claude Code injected are both bookkeeping, and a
        // lesson read out of either would be a lesson nobody taught
        expect(joined).not.toMatch(/MARKER_SIDECHAIN_ONLY|MARKER_META_ONLY|MARKER_META_TWO/);
        // the tool_result lines carry no text block, so they never become a turn
        for (const turn of session.turns) {
          if (!turn.tool) continue;
          expect(joined.includes(turn.tool.result) && turn.tool.result.length > 12, session.id).toBe(false);
        }
        const conversational = session.turns.filter((t) => !t.meta && !t.sidechain).length;
        expect(entries.length, session.id).toBe(conversational);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("builds a job with substance and production-shaped evidence for every session", () => {
    for (const session of SESSIONS) {
      const home = mkdtempSync(join(tmpdir(), "th-hasat-home-test-"));
      try {
        const built = buildSession(session, home);
        // A session the hook would skip costs nothing and measures nothing, so a fixture
        // that fails this is a fixture that never reaches the model in production either.
        expect(built.substance, `${session.id} would be skipped as trivial`).toBe(true);
        expect(built.job.transcriptPath, session.id).toBeTruthy();
        expect(built.slice.length, session.id).toBeGreaterThan(0);
        // pair ids come from the product's own hashing, so an error-fix label has an
        // anchor `anchorIsSound` will actually accept
        for (const pair of built.job.evidence.pairs) {
          expect(pair.fingerprint, session.id).toMatch(/^[0-9a-f]{16}$/);
        }
        if (session.work.some((w) => w.kind === "bash-fail")) {
          const resolved = session.work.some((w) => w.kind === "bash-ok");
          if (resolved) expect(built.job.evidence.pairs.length, `${session.id} resolved no pair`).toBeGreaterThan(0);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });

  it("loses one lesson to the slicer with its prompt intact, and another to the prompt ceiling with its slice intact", () => {
    // The two structural cases, asserted by name and in both directions. Without them
    // every recall miss in the corpus is ambiguous between "the model did not find it" and
    // "it was never shown", and the report could only guess which.
    const presenceOf = (sessionId: string, labelId: string) => {
      const session = SESSIONS.find((s) => s.id === sessionId)!;
      const home = mkdtempSync(join(tmpdir(), "th-hasat-home-drop-"));
      try {
        return buildSession(session, home).presence.find((p) => p.labelId === labelId)!;
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    };

    const slicedOut = presenceOf("configuration-is-read-once-into-a-shape", "config-once");
    expect(slicedOut.inSlice, "the slice-loss fixture no longer loses its lesson to the budget").toBe(false);
    expect(slicedOut.inCorrections, "the slice-loss fixture must still reach the model through the recorded prompts").toBe(true);

    const cappedOut = presenceOf("a-flag-is-removed-by-the-person-who-added-it", "flag-removal");
    expect(cappedOut.inCorrections, "the prompt-ceiling fixture no longer loses its lesson to the 40-prompt ceiling").toBe(false);
    expect(cappedOut.inSlice, "the prompt-ceiling fixture must still reach the model through the slice").toBe(true);

    // And nowhere else, so a recall miss elsewhere is the model's or the sieve's.
    for (const session of SESSIONS) {
      if (session.id === "configuration-is-read-once-into-a-shape") continue;
      if (session.id === "a-flag-is-removed-by-the-person-who-added-it") continue;
      const home = mkdtempSync(join(tmpdir(), "th-hasat-home-full-"));
      try {
        for (const presence of buildSession(session, home).presence) {
          expect(presence.inSlice, `${session.id}/${presence.labelId} left the slice unexpectedly`).toBe(true);
          expect(presence.inCorrections, `${session.id}/${presence.labelId} left the recorded prompts unexpectedly`).toBe(true);
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }
  });


  it("gives the shuffled-label control a number that can move, and the refusal classifier one that can fail", () => {
    // Both of these guard against the same failure: a check that reports the right answer
    // for the wrong reason. An earlier version of the control read its rate off the pooled
    // metrics, where a match is only ever counted against a label of the item's OWN
    // session - so a control row, whose matches are all donor ids, reported zero whatever
    // the grader had said. A zero that cannot move is not evidence.
    const row = (matched: string[]): SessionRun => ({
      sessionId: "clock-injected-not-mocked",
      reached: true,
      outcome: "harvested",
      unparseable: false,
      ms: 0,
      costUsd: null,
      substance: true,
      promptsOffered: 1,
      correctionsKept: 1,
      correctionsTruncated: 0,
      redactedLines: 0,
      sliceChars: 1,
      presence: [],
      rawElements: 1,
      parseRejected: 0,
      refusals: {},
      refusalMirrorAgrees: true,
      items: [
        {
          name: "x",
          emittedKind: "correction",
          kept: true,
          matchedLabels: matched,
          matchedDistractors: [],
          graderUnreadable: 0,
        },
      ],
      written: [],
      rederivationAgrees: true,
    });
    const donors = shuffledLabels(SESSIONS);
    const donated = donors.get("clock-injected-not-mocked")!;
    expect(controlYesRate([row([])], donors)).toEqual({ yes: 0, pairs: donated.length });
    expect(controlYesRate([row([donated[0]!.id])], donors).yes).toBe(1);

    // And the refusal classifier: it has to refuse a correction whose quote is not in the
    // text the model was shown, which is the case it exists for.
    const grounding = { slice: "User: we never patch the clock", corrections: [], pairFingerprints: new Set<string>() };
    const base = {
      name: "n",
      description: "d",
      body: "b",
      expect: "e",
      scope: "team",
      scores: { recurrence: 0, unfindability: 1, generality: 1, durability: 1, costOfError: 1 },
    };
    expect(classifyRefusal({ ...base, kind: "correction", quote: "we never patch the clock" }, grounding)).toBe("accepted");
    expect(classifyRefusal({ ...base, kind: "correction", quote: "we always deploy on Friday" }, grounding)).toBe("ungrounded-quote");
    expect(classifyRefusal({ ...base, kind: "error-fix", source: "pair:0000000000000000" }, grounding)).toBe("unknown-pair");
    expect(classifyRefusal({ ...base, kind: "nonsense" }, grounding)).toBe("bad-kind");
    expect(classifyRefusal({ ...base, kind: "discovery", scope: "everyone" }, grounding)).toBe("schema");
  });

  it("deranges the corpus for the control without ever pairing two lessons about one subject", () => {
    const shuffled = shuffledLabels(SESSIONS);
    const withLabels = SESSIONS.filter((s) => s.labels.length > 0);
    expect(shuffled.size).toBe(withLabels.length);
    for (const session of withLabels) {
      const donated = shuffled.get(session.id)!;
      expect(donated.length, session.id).toBeGreaterThan(0);
      const own = new Set(session.labels.map((l) => l.id));
      const ownDomains = new Set(session.labels.map((l) => l.domain));
      for (const label of donated) {
        expect(own.has(label.id), `${session.id} was handed its own label`).toBe(false);
        expect(ownDomains.has(label.domain), `${session.id} was handed a same-subject label`).toBe(false);
      }
    }
  });
});
