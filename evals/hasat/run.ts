// The harvest measurement runner. Not a test: it spends money, needs the network, and its
// subject is a model rather than a function.
//
//     npx vite-node evals/hasat/run.ts -- --runs 3
//
// It calls the real `harvestSession` through the real `runClaudeCli`, once per corpus
// session per run, against a fresh isolated home each time. Nothing of this machine is
// read: the handbook home, the working directory, the git remote and the existing-skill
// list are all injected, and the child model call carries no tools, no MCP servers and
// none of this machine's settings.
//
// What it refuses to do:
//   - start when the installed CLI cannot isolate the child. An unisolated child loads
//     this repository and fires this plugin's own SessionStart hook inside the session
//     being measured, which was observed to suppress the harvest outright. A number taken
//     that way measures the notice, not the product.
//   - start when the projected spend exceeds the ceiling. The projection comes from a
//     metered calibration call of the same shape, not from an estimate.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  balancedArrayAt,
  buildHarvestPrompt,
  defaultHarvestConfig,
  harvestSession,
  parseHarvestResponse,
  sieveHarvestItems,
  withMeasuredRecurrence,
} from "../../src/lib/harvest.js";
import type { HarvestItem, SievedItem } from "../../src/lib/harvest.js";
import { slugifySkillName } from "../../src/lib/distill.js";
import { childIsolationArgs, childInvocation, claudeHelpText } from "../../src/lib/score.js";
import { redactSlice } from "../../src/lib/transcript.js";
import { SESSIONS, sessionsInTier, shuffledLabels } from "./corpus.js";
import type { CorpusSession, Label } from "./corpus.js";
import { buildSession } from "./session.js";
import { askGrader, buildDistractorPrompt, buildSameLessonPrompt, GRADER_MODEL } from "./grader.js";
import { band, controlYesRate, pool, rate } from "./metrics.js";
import { classifyRefusal, rawElements } from "./tiers.js";
import type { ItemRecord, Rates, SessionRun } from "./metrics.js";
import { DISTRACTOR_CONTROLS, GRADER_CASES } from "./grader-cases.js";
import { GRADER_CASES_TIER2 } from "./grader-cases-tier2.js";
import type { GraderCase } from "./grader-cases.js";
import { median, overlapAgainstOtherSessions, overlapRows } from "./overlap.js";

const execFileAsync = promisify(execFile);

/** The task's ceiling, overridable with `--budget` because a card's ceiling covers every
 * invocation it makes and this one is the second or third of them. Checked against a metered
 * call, and the run refuses rather than overspending: a number nobody authorised is not
 * worth having. */
const BUDGET_USD = 40;
const CONCURRENCY = 4;
/** How many sessions the shuffled-label control covers. Tier 1 ran it over all 24 for $1.50;
 * at tier-2 prompt sizes a full pass is several dollars and buys nothing extra, because the
 * control measures the grader rather than the corpus. */
const CONTROL_SESSIONS = 10;
/** A stand-in remote, so a "project"-scoped item has something to collapse to other than
 * "team" - otherwise the scope a model chose is unreadable in the written candidate. */
const FIXTURE_REMOTE = "git@fixture.invalid:stand-in/repo.git";

interface Options {
  /** which tiers to measure. Required, and there is no default on purpose: the two are
   * never pooled, they cost differently, and an invocation that silently ran both would
   * spend twice what the reader of the command expected. */
  tiers: Array<1 | 2>;
  budget: number;
  runs: number;
  model: string;
  sessions: string[];
  grade: boolean;
  graderCheck: boolean;
  dryRun: boolean;
  outDir: string;
  /** where this run's replies and items are archived, per run */
  materialDir?: string;
  /** run the grader agreement check and stop, spending nothing on the harvest */
  checkOnly: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const tiers = (get("--tier") ?? "")
    .split(",")
    .map((t) => Number(t.trim()))
    .filter((t): t is 1 | 2 => t === 1 || t === 2);
  return {
    tiers,
    budget: Number(get("--budget") ?? String(BUDGET_USD)),
    runs: Number(get("--runs") ?? "3"),
    model: get("--model") ?? defaultHarvestConfig.model,
    sessions: (get("--sessions") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    grade: !argv.includes("--no-grade"),
    graderCheck: !argv.includes("--no-grader-check"),
    dryRun: argv.includes("--dry-run"),
    checkOnly: argv.includes("--grader-check-only"),
    outDir: get("--out") ?? join(process.cwd(), "evals", "results", "hasat"),
  };
}

function selected(options: Options): CorpusSession[] {
  if (options.sessions.length > 0) return SESSIONS.filter((s) => options.sessions.includes(s.id));
  return options.tiers.flatMap((tier) => sessionsInTier(tier));
}

/** A fresh home per session per run. Sharing one would make each fixture the previous
 * one's echo and its candidate the next one's "recent review decision". */
function freshHome(model: string): string {
  const home = mkdtempSync(join(tmpdir(), "th-hasat-home-"));
  // The product's own override path, rather than a patched constant.
  writeFileSync(join(home, "config.json"), JSON.stringify({ harvest: { model } }), "utf8");
  return home;
}

interface RunOutcome {
  run: SessionRun;
  /** every item the product saw, kept or dropped, so the grader can be asked about both */
  items: Array<{ item: HarvestItem; kept: boolean; reason?: SievedItem["reason"] }>;
}

async function harvestOne(session: CorpusSession, options: Options): Promise<RunOutcome> {
  const home = freshHome(options.model);
  const built = buildSession(session, home);
  const started = Date.now();
  let raw = "";
  let callFailed = false;

  const summary = await harvestSession(built.job, home, {
    runner: async (prompt, model, timeoutMs) => {
      const { runClaudeCli } = await import("../../src/lib/score.js");
      try {
        raw = await runClaudeCli(prompt, model, timeoutMs);
      } catch (err) {
        callFailed = true;
        throw err;
      }
      return raw;
    },
    // nothing of this machine: no skill directory is read, and the remote is a stand-in.
    // The existing-skill list is the fixture's own - empty through tier 1, three to five in
    // tier 2 - because what the model is told already exists changes what it proposes, and
    // the sieve's duplicate rule cannot fire against an empty set.
    skillDirs: () => [],
    listSkills: () => session.existingSkills ?? [],
    remoteUrl: () => FIXTURE_REMOTE,
  });
  const ms = Date.now() - started;

  const grounding = {
    slice: built.slice,
    corrections: (built.job.evidence.corrections ?? []).map((c) => c.text),
    pairFingerprints: new Set(built.job.evidence.pairs.map((p) => p.fingerprint)),
  };
  const parsed = summary.outcome === "error" && callFailed ? [] : (parseHarvestResponse(raw, grounding) ?? []);
  const elements = callFailed ? null : rawElements(raw);
  const refusals: Record<string, number> = {};
  for (const element of elements ?? []) {
    const verdict = classifyRefusal(element, grounding);
    if (verdict === "accepted") continue;
    refusals[verdict] = (refusals[verdict] ?? 0) + 1;
  }
  // The mirror is checked, not trusted: it has to accept exactly as many elements as the
  // product's own parser kept, or the refusal breakdown is describing a parser that did
  // not run.
  const accepted = (elements ?? []).filter((e) => classifyRefusal(e, grounding) === "accepted").length;
  const refusalMirrorAgrees = elements === null || accepted === parsed.length;
  const measured = parsed.map((i) => withMeasuredRecurrence(i, [], built.job.evidence.recurrence));
  const { kept, dropped } = sieveHarvestItems(measured, {
    existingSkillNames: new Set((session.existingSkills ?? []).map((skill) => skill.name)),
    muted: new Set<string>(),
    minScore: defaultHarvestConfig.minScore,
    maxPerSession: defaultHarvestConfig.maxPerSession,
  });
  // The re-derivation is not decoration: it is what lets the four tiers below be trusted.
  // If it disagrees with what the product wrote, the tier counts are describing a
  // different sieve than the one that ran, and the report has to say so.
  const rederived = kept.map((i) => slugifySkillName(i.name)).filter((s): s is string => !!s);
  const rederivationAgrees =
    summary.outcome !== "harvested" ||
    (rederived.length === summary.written.length &&
      rederived.every((slug, i) => summary.written[i]?.startsWith(slug)));

  const items: Array<{ item: HarvestItem; kept: boolean; reason?: SievedItem["reason"] }> = [
    ...kept.map((item) => ({ item, kept: true })),
    ...dropped.map((d) => ({ item: d.item, kept: false, reason: d.reason })),
  ];

  // The material every later reading depends on, kept because a record of counts cannot be
  // audited: the hand-labelled grader cases are built from real items, the refusal
  // breakdown is checked against real refused elements, and a disputed verdict is settled
  // by reading the item it was about. The reply goes through the product's own line-by-line
  // secret redaction first - the model can echo secret-shaped text out of any session - and
  // `evals/results/` is not committed.
  if (options.materialDir) {
    mkdirSync(options.materialDir, { recursive: true });
    writeFileSync(
      join(options.materialDir, `${session.id}.json`),
      `${JSON.stringify(
        {
          sessionId: session.id,
          // What the model was actually shown. Without it an item cannot be classified as
          // invented rather than found, which is the judgement the report has to make by hand.
          slice: built.slice,
          reply: redactSlice(raw).clean,
          refusedElements: (elements ?? []).filter((e) => classifyRefusal(e, grounding) !== "accepted"),
          items: items.map((entry) => ({ kept: entry.kept, reason: entry.reason ?? null, item: entry.item })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return {
    run: {
      sessionId: session.id,
      reached: !callFailed,
      outcome: summary.outcome,
      ...(summary.error ? { error: summary.error } : {}),
      unparseable: summary.error === "unparseable harvest response",
      ms,
      costUsd: null,
      substance: built.substance,
      promptsOffered: built.promptsOffered,
      correctionsKept: built.correctionsKept,
      correctionsTruncated: built.correctionsTruncated,
      redactedLines: built.redactedLines,
      sliceChars: built.slice.length,
      presence: built.presence,
      rawElements: elements === null ? null : elements.length,
      parseRejected: elements === null ? 0 : Math.max(0, elements.length - parsed.length),
      refusals,
      refusalMirrorAgrees,
      items: [],
      written: summary.written,
      rederivationAgrees,
    },
    items,
  };
}

// ── grading ─────────────────────────────────────────────────────────────────

/** One grader question and its answer, kept so a number in the report can be argued with
 * rather than only read. The item is named, never quoted: a decisions file is read by
 * whoever is auditing, and a produced item is model output derived from session text. */
export interface Decision {
  sessionId: string;
  item: string;
  question: "same-lesson" | "is-this-fact";
  against: string;
  yes: boolean;
  unreadable: boolean;
  raw: string;
}

async function gradeItems(
  session: CorpusSession,
  outcome: RunOutcome,
  labelsFor: (s: CorpusSession) => Label[],
  /**
   * Whether to ask the distractor question at all. It is asked on the FIRST run only.
   *
   * It measures a property of the kept items - is this item's central claim one system's fact -
   * and 23 dense sessions produce about as many kept items in one run as tier 1's whole corpus
   * produced in three, so a second and third pass buys precision this package cannot use. What
   * it costs is a third of the tier's grading budget, which went to the third measured run
   * instead. The rate is reported with its own denominator so it cannot be read as covering
   * all three runs.
   */
  askDistractors: boolean,
): Promise<{ records: ItemRecord[]; costUsd: number; decisions: Decision[] }> {
  const labels = labelsFor(session);
  const records: ItemRecord[] = [];
  const decisions: Decision[] = [];
  let costUsd = 0;
  for (const entry of outcome.items) {
    const matchedLabels: string[] = [];
    const matchedDistractors: string[] = [];
    let unreadable = 0;
    for (const label of labels) {
      const verdict = await askGrader(buildSameLessonPrompt(entry.item, label));
      decisions.push({
        sessionId: session.id,
        item: entry.item.name,
        question: "same-lesson",
        against: label.id,
        yes: verdict.yes,
        unreadable: verdict.unreadable,
        raw: verdict.raw,
      });
      if (verdict.costUsd !== null) costUsd += verdict.costUsd;
      if (verdict.unreadable) unreadable += 1;
      else if (verdict.yes) matchedLabels.push(label.id);
    }
    // Only a KEPT item is asked the distractor question: the distractor rate answers
    // "what did the product put in front of the user", and a dropped item was not put
    // anywhere. It also halves the grading bill.
    if (entry.kept && askDistractors) {
      for (const distractor of session.distractors) {
        const verdict = await askGrader(buildDistractorPrompt(entry.item, distractor));
        decisions.push({
          sessionId: session.id,
          item: entry.item.name,
          question: "is-this-fact",
          against: distractor.id,
          yes: verdict.yes,
          unreadable: verdict.unreadable,
          raw: verdict.raw,
        });
        if (verdict.costUsd !== null) costUsd += verdict.costUsd;
        if (verdict.unreadable) unreadable += 1;
        else if (verdict.yes) matchedDistractors.push(distractor.id);
      }
    }
    records.push({
      name: entry.item.name,
      emittedKind: entry.item.kind,
      kept: entry.kept,
      ...(entry.reason ? { sieveReason: entry.reason } : {}),
      matchedLabels,
      matchedDistractors,
      distractorsAsked: askDistractors,
      graderUnreadable: unreadable,
    });
  }
  return { records, costUsd, decisions };
}

// ── grader agreement ────────────────────────────────────────────────────────

/** The hand-labelled pairs, run through the exact production call. A grader that leans
 * towards yes inflates precision, so its own agreement is measured before its numbers are
 * read at all. */
export interface GraderCheck {
  /** agreement per repeat, because the bar is per repeat: pooling three repeats into one
   * fraction lets two clean repeats carry a third that failed, and the bar was written
   * against a single pass over the pairs */
  perRepeat: number[];
  cases: number;
  worstRepeat: number;
  /** a pair whose majority verdict across the repeats disagrees with the label */
  majorityDisagreements: string[];
  costUsd: number;
  disagreements: Array<{ repeat: number; id: string; expected: boolean; got: boolean; unreadable: boolean }>;
}

async function checkGrader(repeats: number, cases: GraderCase[]): Promise<GraderCheck> {
  const trials = Array.from({ length: repeats }, (_, repeat) =>
    cases.map((testCase) => ({ repeat, testCase })),
  ).flat();
  const verdicts = await inBatches(trials, CONCURRENCY, async ({ repeat, testCase }) => ({
    repeat,
    testCase,
    verdict: await askGrader(buildSameLessonPrompt(testCase.item, testCase.label)),
  }));
  const perRepeat = Array.from({ length: repeats }, () => 0);
  const yesCount = new Map<string, number>();
  const disagreements: GraderCheck["disagreements"] = [];
  let costUsd = 0;
  for (const { repeat, testCase, verdict } of verdicts) {
    if (verdict.costUsd !== null) costUsd += verdict.costUsd;
    const agreed = !verdict.unreadable && verdict.yes === testCase.expected;
    if (agreed) perRepeat[repeat] = (perRepeat[repeat] ?? 0) + 1;
    else disagreements.push({ repeat: repeat + 1, id: testCase.id, expected: testCase.expected, got: verdict.yes, unreadable: verdict.unreadable });
    if (verdict.yes) yesCount.set(testCase.id, (yesCount.get(testCase.id) ?? 0) + 1);
  }
  const majorityDisagreements = cases.filter((testCase) => {
    const yes = (yesCount.get(testCase.id) ?? 0) > repeats / 2;
    return yes !== testCase.expected;
  }).map((testCase) => testCase.id);
  return {
    perRepeat,
    cases: cases.length,
    worstRepeat: perRepeat.length ? Math.min(...perRepeat) : 0,
    majorityDisagreements,
    costUsd,
    disagreements,
  };
}

/**
 * Can the distractor question fire at all? Asked with synthetic items that are nothing but a
 * one-system fact, and every answer has to be YES. Without it, the "no kept item's central
 * claim was a one-system fact" result is indistinguishable from a question that never says yes
 * - the identical hole that the shuffled-label control was found to have.
 */
async function checkDistractorGrader(): Promise<{ yes: number; total: number; costUsd: number; missed: string[] }> {
  const verdicts = await inBatches(DISTRACTOR_CONTROLS, CONCURRENCY, async (control) => {
    const session = SESSIONS.find((s) => s.id === control.sessionId);
    const distractor = session?.distractors.find((d) => d.id === control.distractorId);
    if (!distractor) return { control, verdict: null };
    return { control, verdict: await askGrader(buildDistractorPrompt(control.item, distractor)) };
  });
  let yes = 0;
  let costUsd = 0;
  const missed: string[] = [];
  for (const { control, verdict } of verdicts) {
    if (!verdict) {
      missed.push(`${control.id} (distractor not found)`);
      continue;
    }
    if (verdict.costUsd !== null) costUsd += verdict.costUsd;
    if (verdict.yes && !verdict.unreadable) yes += 1;
    else missed.push(control.id);
  }
  return { yes, total: DISTRACTOR_CONTROLS.length, costUsd, missed };
}

/**
 * Which hand-labelled pairs the grader is checked against for this invocation.
 *
 * A tier-2 pair asks the harder question - "is this the same lesson as one nobody stated" -
 * and the tier-1 set cannot stand in for it: agreement on ten pairs about voiced rules says
 * nothing about a grader reading an item against a sentence that appears nowhere in the
 * session. Both sets are used when both tiers are measured.
 */
function graderCasesFor(options: Options): GraderCase[] {
  if (options.sessions.length > 0) return [...GRADER_CASES, ...GRADER_CASES_TIER2];
  return [
    ...(options.tiers.includes(1) ? GRADER_CASES : []),
    ...(options.tiers.includes(2) ? GRADER_CASES_TIER2 : []),
  ];
}

/** The bar is per repeat, and the worst repeat is the one reported against it. */
function reportGraderCheck(check: GraderCheck): void {
  console.log(
    `\ngrader agreement         : ${check.perRepeat.map((n) => `${n}/${check.cases}`).join(" / ")}` +
      `  worst repeat ${check.worstRepeat}/${check.cases}` +
      `\n  majority verdict disagrees on: ${check.majorityDisagreements.join(", ") || "nothing"}` +
      (check.disagreements.length
        ? `\n  individual disagreements: ${check.disagreements.map((d) => `r${d.repeat}:${d.id}${d.unreadable ? " (unreadable)" : ""}`).join(", ")}`
        : ""),
  );
}

function reportDistractorControl(check: { yes: number; total: number; missed: string[] }): void {
  console.log(
    `distractor control       : ${check.yes}/${check.total} synthetic fact-only items answered YES` +
      (check.missed.length ? `  MISSED: ${check.missed.join(", ")}` : "") +
      `\n  a distractor-capture rate of zero is only readable when this is ${check.total}/${check.total}.`,
  );
}

// ── calibration ─────────────────────────────────────────────────────────────

/** Meter one call of the shape this package sends, at the prompt length given. Not the
 * product path - the product reads plain text - but the only way to put a real number on
 * the run instead of an estimate. */
async function meterHarvestCall(prompt: string, model: string): Promise<number | null> {
  const invocation = childInvocation({ prompt, model, helpText: await claudeHelpText() });
  try {
    const { stdout } = await execFileAsync("claude", [...invocation.args, "--output-format", "json"], {
      timeout: defaultHarvestConfig.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      cwd: invocation.cwd,
      env: invocation.env,
    });
    const parsed: unknown = JSON.parse(stdout);
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of [...events].reverse()) {
      const cost = (event as { total_cost_usd?: unknown })?.total_cost_usd;
      if (typeof cost === "number") return cost;
    }
    return null;
  } catch {
    return null;
  } finally {
    invocation.done();
  }
}

function promptFor(session: CorpusSession): string {
  const home = freshHome(defaultHarvestConfig.model);
  const built = buildSession(session, home);
  return buildHarvestPrompt({
    slice: built.slice,
    evidence: built.job.evidence,
    existingSkills: session.existingSkills ?? [],
    recentDecisions: [],
    maxItems: defaultHarvestConfig.maxPerSession,
  });
}

// ── reporting ───────────────────────────────────────────────────────────────

function pct(value: number | null): string {
  return value === null ? "  n/a " : `${(value * 100).toFixed(1)}%`;
}

function printRates(label: string, r: Rates): void {
  console.log(`\n--- ${label} ---`);
  console.log("recall by label kind (a kept item the grader matched):");
  for (const kind of ["correction", "procedure", "error-fix", "all"] as const) {
    const cell = r.recall[kind]!;
    const before = r.recallBeforeSieve[kind]!;
    console.log(
      `  ${kind.padEnd(11)} ${String(cell.found).padStart(3)}/${String(cell.total).padEnd(3)} = ${pct(rate(cell.found, cell.total))}` +
        `   before the sieve ${before.found}/${before.total} = ${pct(rate(before.found, before.total))}`,
    );
  }
  console.log("precision by the kind the model emitted (kept items on a label of their own session):");
  for (const kind of ["correction", "procedure", "error-fix", "discovery", "all"] as const) {
    const cell = r.precision[kind]!;
    console.log(`  ${kind.padEnd(11)} ${String(cell.onLabel).padStart(3)}/${String(cell.kept).padEnd(3)} = ${pct(rate(cell.onLabel, cell.kept))}`);
  }
  console.log(
    `distractor capture       : ${r.distractorCapture.hits}/${r.distractorCapture.kept} = ${pct(rate(r.distractorCapture.hits, r.distractorCapture.kept))}` +
      (r.distractorCapture.asked
        ? ""
        : "  NOT ASKED in this run - the question is put on the first run only, so this zero is not a result"),
  );
  console.log(`discovery share of kept  : ${r.discoveryShare.discovery}/${r.discoveryShare.kept} = ${pct(rate(r.discoveryShare.discovery, r.discoveryShare.kept))}`);
  console.log(`model emitted / refused  : ${r.rawElements} elements, ${r.parseRejected} refused before the sieve`);
  console.log(`  refused because         : ${Object.entries(r.refusals).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`sieve reasons            : ${Object.entries(r.sieveReasons).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  console.log(`model said nothing       : ${r.modelEmpty.sessions}/${r.modelEmpty.labelled} sessions that HAD a lesson to find`);
  console.log(`every element refused    : ${r.allRefused} sessions`);
  console.log(`kept from the lesson-free session : ${r.lessonFreeKept} (anything here is noise by construction)`);
  console.log(`unparseable replies      : ${r.unparseable}`);
  console.log(`calls that never reached : ${r.invalid.runsNotReached}/${r.invalid.runs}`);
  console.log(`grader unreadable        : ${r.graderUnreadable}`);
  if (r.covered.labels > 0) {
    console.log(
      `lessons an existing skill covers : ${r.covered.labels}` +
        `  proposed anyway ${r.covered.proposed}` +
        `  reached the queue ${r.covered.keptOnLabel}` +
        `  stopped by the sieve's duplicate rule ${r.covered.droppedAsDuplicate}` +
        `\n  the right outcome for these is silence; they are in no recall denominator.`,
    );
  }
  console.log("recall by how the lesson was stated:");
  for (const [form, cell] of Object.entries(r.recallByForm)) {
    if (cell.total === 0) continue;
    console.log(`  ${form.padEnd(16)} ${String(cell.found).padStart(3)}/${String(cell.total).padEnd(3)} = ${pct(rate(cell.found, cell.total))}`);
  }
  console.log("recall per cell of the kind-against-form table (the cells tier 1 left empty):");
  for (const [cellName, cell] of Object.entries(r.recallByCell)) {
    if (cell.total === 0) continue;
    console.log(`  ${cellName.padEnd(28)} ${String(cell.found).padStart(3)}/${String(cell.total).padEnd(3)} = ${pct(rate(cell.found, cell.total))}`);
  }
  console.log("label kind -> emitted kind:");
  for (const [labelKind, row] of Object.entries(r.confusion)) {
    console.log(`  ${labelKind.padEnd(11)} ${Object.entries(row).map(([k, v]) => `${k} ${v}`).join("  ")}`);
  }
}

// ── what the corpus is, before anything is asked of a model ─────────────────
//
// Free, deterministic and printed at the top of every invocation, because tier 1's
// published number needed a line saying how legible its corpus was and did not have one
// until an independent review measured it afterwards. The same numbers are in
// `summary.json`, so the report quotes the tool rather than a hand count.

function tiersOf(sessions: CorpusSession[]): Array<1 | 2> {
  return [1, 2].filter((tier) => sessions.some((s) => s.tier === tier)) as Array<1 | 2>;
}

interface TierShape {
  tier: 1 | 2;
  sessions: number;
  labels: number;
  covered: number;
  sliceMedian: number;
  sliceShareOfCap: number;
  userTurnsMedian: number;
  lessonTurnShareMedian: number;
  recordedPromptsMedian: number;
  existingSkillsMedian: number;
  /** content-word overlap between a label's canonical sentence and the session, and the
   * same against ANOTHER session, which is the baseline that makes it readable */
  overlapBestTurnMean: number;
  overlapBestTurnMax: number;
  overlapNullBestTurnMean: number;
}

function corpusShape(sessions: CorpusSession[]): TierShape[] {
  return tiersOf(sessions).map((tier) => {
    const inTier = sessions.filter((s) => s.tier === tier);
    const built = inTier.map((session) => {
      const home = freshHome(defaultHarvestConfig.model);
      const b = buildSession(session, home);
      const users = session.turns.filter((t) => t.role === "user" && !t.meta && !t.sidechain);
      const userChars = users.reduce((n, t) => n + t.text.length, 0);
      const carriers = session.labels.map((label) =>
        users
          .filter((t) => t.text.toLowerCase().includes(label.anchor.toLowerCase()))
          .reduce((n, t) => n + t.text.length, 0),
      );
      return {
        slice: b.slice.length,
        users: users.length,
        lessonShare: carriers.length > 0 && userChars > 0 ? Math.max(...carriers) / userChars : 0,
        prompts: b.correctionsKept,
        skills: (session.existingSkills ?? []).length,
      };
    });
    const rows = overlapRows(inTier);
    const nullRows = overlapAgainstOtherSessions(inTier);
    const sliceMedian = median(built.map((b) => b.slice));
    return {
      tier,
      sessions: inTier.length,
      labels: inTier.reduce((n, s) => n + s.labels.length, 0),
      covered: inTier.reduce((n, s) => n + s.labels.filter((l) => l.coveredBy).length, 0),
      sliceMedian,
      sliceShareOfCap: sliceMedian / defaultHarvestConfig.transcriptCharCap,
      userTurnsMedian: median(built.map((b) => b.users)),
      lessonTurnShareMedian: median(built.filter((b) => b.lessonShare > 0).map((b) => b.lessonShare)),
      recordedPromptsMedian: median(built.map((b) => b.prompts)),
      existingSkillsMedian: median(built.map((b) => b.skills)),
      overlapBestTurnMean: rows.reduce((n, r) => n + r.bestTurn, 0) / Math.max(1, rows.length),
      overlapBestTurnMax: Math.max(0, ...rows.map((r) => r.bestTurn)),
      overlapNullBestTurnMean: nullRows.reduce((n, r) => n + r.bestTurn, 0) / Math.max(1, nullRows.length),
    };
  });
}

function reportCorpusShape(sessions: CorpusSession[]): void {
  for (const shape of corpusShape(sessions)) {
    console.log(
      `\ntier ${shape.tier} corpus        : ${shape.sessions} sessions, ${shape.labels} labels` +
        ` (${shape.covered} of them already covered by an injected skill)` +
        `\n  slice to the model      : median ${shape.sliceMedian} chars = ${(shape.sliceShareOfCap * 100).toFixed(1)}% of the ${defaultHarvestConfig.transcriptCharCap}-char cap` +
        `\n  developer turns         : median ${shape.userTurnsMedian}, of which median ${shape.recordedPromptsMedian} short enough to be recorded as prompts` +
        `\n  the turn with the lesson: median ${(shape.lessonTurnShareMedian * 100).toFixed(1)}% of everything the developer typed` +
        `\n  existing skills injected: median ${shape.existingSkillsMedian}` +
        `\n  label wording in session: best single turn overlap mean ${shape.overlapBestTurnMean.toFixed(2)}, max ${shape.overlapBestTurnMax.toFixed(2)}` +
        ` (same measure against ANOTHER session: ${shape.overlapNullBestTurnMean.toFixed(2)}, which is the floor)`,
    );
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.tiers.length === 0 && options.sessions.length === 0) {
    console.error(
      "which tier? --tier 1 is the legible corpus the published band was taken on, --tier 2\n" +
        "the dense one. They are reported apart and never pooled, and they cost differently, so\n" +
        "there is no default: pass --tier 1, --tier 2, --tier 1,2, or name sessions with\n" +
        "--sessions.",
    );
    process.exit(2);
  }
  const sessions = selected(options);
  if (sessions.length === 0) {
    console.error("no session matched the selection.");
    process.exit(2);
  }
  mkdirSync(options.outDir, { recursive: true });

  // Preflight, before a cent is spent. An older CLI that cannot isolate the child would
  // run this whole package against a session polluted by this repository and this
  // plugin's own hook output.
  const isolation = await childIsolationArgs();
  if (isolation.length === 0) {
    console.error(
      "the installed claude CLI does not support the child isolation flags, so the child would\n" +
        "inherit this repository, this machine's settings and this plugin's own hooks. That was\n" +
        "measured to suppress the harvest outright, so no number taken this way is a product\n" +
        "result. Refusing to run.",
    );
    process.exit(2);
  }
  // A belt on top of the injected home: nothing in this package should ever read the real
  // one, and a helper that forgot its `home` parameter would silently do so.
  process.env.TEAMHANDBOOK_HOME = mkdtempSync(join(tmpdir(), "th-hasat-envhome-"));
  console.log(`child isolation flags    : ${isolation.join(" ")}`);
  console.log(`harvest model            : ${options.model}`);
  console.log(`grader model             : ${GRADER_MODEL}`);
  console.log(`sessions                 : ${sessions.length} (${tiersOf(sessions).map((t) => `tier ${t}: ${sessions.filter((s) => s.tier === t).length}`).join(", ")})`);
  console.log(`runs                     : ${options.runs}`);
  reportCorpusShape(sessions);

  if (options.checkOnly) {
    const only = await checkGrader(3, graderCasesFor(options));
    reportGraderCheck(only);
    const positive = await checkDistractorGrader();
    reportDistractorControl(positive);
    console.log(`metered spend : $${(only.costUsd + positive.costUsd).toFixed(4)}`);
    writeFileSync(
      join(options.outDir, "grader-check.json"),
      `${JSON.stringify({ at: new Date().toISOString(), graderModel: GRADER_MODEL, ...only, distractorControl: positive }, null, 2)}\n`,
      "utf8",
    );
    return;
  }

  // Calibrate at both ends of the corpus: the two long sessions send a prompt several
  // times the size of the short ones, and a single calibration would price a call nobody
  // makes for half the corpus.
  const bySize = [...sessions].sort((a, b) => promptFor(a).length - promptFor(b).length);
  const shortest = bySize[0]!;
  const longest = bySize[bySize.length - 1]!;
  const shortPrompt = promptFor(shortest);
  const longPrompt = promptFor(longest);
  const shortCost = await meterHarvestCall(shortPrompt, options.model);
  const longCost = await meterHarvestCall(longPrompt, options.model);
  console.log(
    `calibration              : ${shortest.id} ${shortPrompt.length} chars $${shortCost?.toFixed(4) ?? "n/a"}; ` +
      `${longest.id} ${longPrompt.length} chars $${longCost?.toFixed(4) ?? "n/a"}`,
  );

  const perHarvest = shortCost !== null && longCost !== null ? (shortCost + longCost) / 2 : null;
  // Grading dominates the count: up to maxPerSession kept items and as many dropped ones,
  // each against every label of its session, plus a distractor question per kept item.
  // Labels are asked on every run; distractors on the first only (see gradeItems).
  const labelCallsPerRun = sessions.reduce(
    (n, s) => n + defaultHarvestConfig.maxPerSession * 2 * Math.max(1, s.labels.length),
    0,
  );
  const distractorCalls = sessions.reduce(
    (n, s) => n + defaultHarvestConfig.maxPerSession * s.distractors.length,
    0,
  );
  const graderCallsPerRun = labelCallsPerRun + distractorCalls;
  const graderCheckCalls = options.graderCheck ? graderCasesFor(options).length * 3 : 0;
  console.log(
    `projected calls          : ${sessions.length * options.runs} harvest, up to ` +
      `${labelCallsPerRun * options.runs + distractorCalls + labelCallsPerRun + graderCheckCalls} grader ` +
      `(including the shuffled-label control and the grader check)`,
  );
  // The grader is priced from a METERED grader call, not from the harvest calibration
  // divided down. That divided-down figure was written when a harvest prompt was five
  // thousand characters; at tier-2 density it prices a one-word reply on a cheap model at
  // six cents and projects the run at twice the ceiling, so the guard would refuse every
  // dense run on arithmetic rather than on cost. A pessimistic guard that cannot pass is not
  // a guard.
  // Any pair of the shape the grader is asked about; the tier-1 set stands in while the
  // tier-2 set is still being built out of a pilot run's material.
  const graderProbeCase = graderCasesFor(options)[0] ?? GRADER_CASES[0];
  const graderProbe = graderProbeCase
    ? await askGrader(buildSameLessonPrompt(graderProbeCase.item, graderProbeCase.label))
    : null;
  const perGrader = graderProbe?.costUsd ?? (perHarvest === null ? null : perHarvest * 0.5);
  console.log(
    `grader calibration       : $${perGrader?.toFixed(5) ?? "n/a"} per call` +
      `${graderProbe?.costUsd == null ? " (estimated from the harvest calibration; the metered probe did not report a cost)" : " metered"}`,
  );
  if (perHarvest !== null && perGrader !== null) {
    const projected =
      perHarvest * sessions.length * options.runs +
      perGrader *
        (labelCallsPerRun * options.runs + distractorCalls + labelCallsPerRun + graderCheckCalls) +
      (shortCost ?? 0) + (longCost ?? 0) + (graderProbe?.costUsd ?? 0);
    console.log(`projected spend (upper)  : $${projected.toFixed(2)} against a $${options.budget} ceiling`);
    if (projected > options.budget) {
      console.error(
        `refusing to run: the projection above exceeds the ceiling. Narrow the run with\n` +
          `--sessions or --runs, or raise the ceiling deliberately.`,
      );
      process.exit(2);
    }
  } else {
    console.log("projected spend          : not measurable (the calibration call did not report a cost)");
  }
  if (options.dryRun) {
    console.log("\n--dry-run: stopping before the measured runs.");
    return;
  }

  // Fail closed on the grader's own test set. A tier whose hand-labelled pairs are missing
  // would report agreement 0/0, which reads as "nothing disagreed" and is the same shape of
  // unfalsifiable zero the shuffled-label control was found to have. The bar is ten pairs per
  // tier because that is the bar the tier-1 check was set at and passed.
  const graderCases = graderCasesFor(options);
  if (options.grade && options.graderCheck && graderCases.length < 10) {
    console.error(
      `the grader has only ${graderCases.length} hand-labelled pairs for this selection, and its\n` +
        "agreement cannot be read below ten. Add pairs from a pilot run's material (every one a\n" +
        "verbatim output, never an invented item), or pass --no-grader-check deliberately and say\n" +
        "in the report that the grader was unmeasured for this tier.",
    );
    process.exit(2);
  }
  const graderCheck = options.graderCheck && options.grade ? await checkGrader(3, graderCases) : null;
  if (graderCheck) reportGraderCheck(graderCheck);
  const distractorControl = options.graderCheck && options.grade ? await checkDistractorGrader() : null;
  if (distractorControl) reportDistractorControl(distractorControl);

  const shuffled = shuffledLabels(sessions);
  // The harvest calls are NOT metered: the product path reads plain text, so asking the CLI
  // for JSON there would price a call the product does not make. They are estimated from the
  // calibration instead, and the two numbers are reported apart so nobody reads an estimate
  // as a measurement.
  const estimatedHarvestUsd = perHarvest === null ? null : perHarvest * sessions.length * options.runs;
  const runs: Array<{ index: number; rates: Rates; sessions: SessionRun[] }> = [];
  let controlRows1: SessionRun[] | null = null;
  let totalCost = (shortCost ?? 0) + (longCost ?? 0) + (graderCheck?.costUsd ?? 0) + (distractorControl?.costUsd ?? 0);

  for (let index = 0; index < options.runs; index++) {
    const runOptions = { ...options, materialDir: join(options.outDir, `material-${index + 1}`) };
    const outcomes = await inBatches(sessions, CONCURRENCY, (session) => harvestOne(session, runOptions));
    const decisions: Decision[] = [];
    // Graded in batches for the same reason the harvest calls are: a corpus of this size
    // produces a few hundred grader questions per run, and answering them one at a time
    // takes longer than the harvest it is grading.
    const graded = options.grade
      ? await inBatches(
          outcomes.map((outcome, i) => ({ outcome, session: sessions[i]!, position: i })),
          CONCURRENCY,
          async ({ outcome, session, position }) => ({
            outcome,
            session,
            real: await gradeItems(session, outcome, (s) => s.labels, index === 0 || session.tier === 1),
            // The control reuses the SAME items - it costs grading, not harvesting - and
            // only on the first run, because it measures the grader, not the product. At
            // tier-2 density it is also capped at the first `CONTROL_SESSIONS` sessions of the
            // selection: a full second pass is a third of this package's whole budget, and the
            // number it produces is a property of the grader, which does not need every
            // session to be readable. How many sessions it covers is printed with it.
            // Tier 1 keeps the method its published band was taken with: the control over
            // every session, and the distractor question on every run. The two budget trims
            // below are tier-2 only, because a trim that quietly applied to tier 1 would make
            // the published number and a future re-run of it two different measurements.
            control:
              index === 0 && (session.tier === 1 || position < CONTROL_SESSIONS)
                ? await gradeItems(session, outcome, (s) => shuffled.get(s.id) ?? [], false)
                : null,
          }),
        )
      : outcomes.map((outcome, i) => ({ outcome, session: sessions[i]!, real: null, control: null }));

    const rows: SessionRun[] = [];
    const controlRows: SessionRun[] = [];
    for (const entry of graded) {
      if (entry.real) {
        totalCost += entry.real.costUsd;
        entry.outcome.run.items = entry.real.records;
        decisions.push(...entry.real.decisions);
      }
      if (entry.control) {
        totalCost += entry.control.costUsd;
        controlRows.push({ ...entry.outcome.run, items: entry.control.records });
        decisions.push(...entry.control.decisions.map((d) => ({ ...d, against: `control:${d.against}` })));
      }
      rows.push(entry.outcome.run);
    }
    writeFileSync(
      join(options.outDir, `decisions-${index + 1}.jsonl`),
      decisions.map((d) => JSON.stringify(d)).join("\n") + "\n",
      "utf8",
    );
    const rates = pool(rows, sessions);
    runs.push({ index: index + 1, rates, sessions: rows });
    if (index === 0 && controlRows.length > 0) controlRows1 = controlRows;
    // Only when one tier is in play. With both selected this table would pool them, and the
    // per-tier tables printed at the end are the ones to read.
    if (tiersOf(sessions).length === 1) printRates(`run ${index + 1}`, rates);
    writeFileSync(
      join(options.outDir, `run-${index + 1}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), model: options.model, rates, sessions: rows }, null, 2)}\n`,
      "utf8",
    );
  }

  // Deliberately NOT printed through printRates: those rates count a match only against a
  // label of the item's own session, so a control row scores zero there whatever the grader
  // said. Printing that table would publish an unfalsifiable zero as if it were a result.
  const control = controlRows1 ? controlYesRate(controlRows1, shuffled) : null;
  if (control) {
    console.log(
      `\nshuffled-label YES rate  : ${control.yes}/${control.pairs} = ${pct(rate(control.yes, control.pairs))}` +
        ` over the first ${Math.min(CONTROL_SESSIONS, sessions.length)} sessions of the selection` +
        ` - this is the number that has to be near zero. Read every precision figure above as` +
        ` inflated by roughly this much.`,
    );
  }

  // Per tier, and never pooled across them: the two corpora differ in density, in how the
  // lesson is stated and in what the model was told already exists, so one mean over both
  // would describe a corpus nobody built.
  const perTier = tiersOf(sessions).map((tier) => {
    const ids = new Set(sessions.filter((s) => s.tier === tier).map((s) => s.id));
    const tierRuns = runs.map((r) => ({
      index: r.index,
      rates: pool(r.sessions.filter((row) => ids.has(row.sessionId)), sessions),
    }));
    const recalls = tierRuns.map((r) => rate(r.rates.recall.all.found, r.rates.recall.all.total) ?? 0);
    const precisions = tierRuns.map((r) => rate(r.rates.precision.all.onLabel, r.rates.precision.all.kept) ?? 0);
    return { tier, recalls, precisions, recallBand: band(recalls), precisionBand: band(precisions), tierRuns };
  });
  console.log("\n=== band over the runs, per tier (mean +/- 2 sample standard deviations) ===");
  for (const t of perTier) {
    console.log(`tier ${t.tier} recall    : ${t.recalls.map((v) => v.toFixed(4)).join(" / ")}  mean ${t.recallBand.mean.toFixed(4)}  sd ${t.recallBand.sd.toFixed(4)}  band [${t.recallBand.low.toFixed(4)} ; ${t.recallBand.high.toFixed(4)}]`);
    console.log(`tier ${t.tier} precision : ${t.precisions.map((v) => v.toFixed(4)).join(" / ")}  mean ${t.precisionBand.mean.toFixed(4)}  sd ${t.precisionBand.sd.toFixed(4)}  band [${t.precisionBand.low.toFixed(4)} ; ${t.precisionBand.high.toFixed(4)}]`);
    if (perTier.length > 1) {
      for (const r of t.tierRuns) printRates(`tier ${t.tier}, run ${r.index}`, r.rates);
    }
  }
  const recalls = perTier[0]!.recalls;
  const precisions = perTier[0]!.precisions;
  const recallBand = perTier[0]!.recallBand;
  const precisionBand = perTier[0]!.precisionBand;
  console.log(
    `\nspend         : $${totalCost.toFixed(2)} metered (grader, calibration, grader check)` +
      ` + ${estimatedHarvestUsd === null ? "an unmeasurable" : `$${estimatedHarvestUsd.toFixed(2)} estimated`}` +
      ` for ${sessions.length * options.runs} harvest calls at the calibrated rate` +
      (estimatedHarvestUsd === null ? "" : ` = $${(totalCost + estimatedHarvestUsd).toFixed(2)} for this invocation`),
  );
  console.log(`wall          : ${Math.round(runs.reduce((n, r) => n + r.rates.wallMs, 0) / 1000)}s summed over harvest calls`);

  const mirrorDisagreed = runs.flatMap((r) =>
    r.sessions.filter((s) => !s.refusalMirrorAgrees).map((s) => `run ${r.index}: ${s.sessionId}`),
  );
  console.log(
    `refusal mirror      : ${mirrorDisagreed.length === 0 ? "accepts exactly what the product's parser kept" : `DISAGREES on ${mirrorDisagreed.join(", ")} - read the refusal breakdown as unreliable`}`,
  );
  const disagreed = runs.flatMap((r) => r.sessions.filter((s) => !s.rederivationAgrees).map((s) => `run ${r.index}: ${s.sessionId}`));
  console.log(
    `sieve re-derivation : ${disagreed.length === 0 ? "agrees with what the product wrote everywhere" : `DISAGREES on ${disagreed.join(", ")} - the tier counts describe a different sieve than the one that ran`}`,
  );

  writeFileSync(
    join(options.outDir, "summary.json"),
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        model: options.model,
        graderModel: GRADER_MODEL,
        sessions: sessions.map((s) => s.id),
        runs: runs.map((r) => ({ index: r.index, rates: r.rates })),
        // The pooled table for the control rows is deliberately NOT written: `pool` only
        // counts a match against a label of the item's own session, so a control row scores
        // zero there whatever the grader said. Keeping it in the summary meant an
        // unfalsifiable zero sat in the artifact next to the number that can actually move.
        controlYesRate: control,
        estimatedHarvestUsd,
        graderCheck,
        distractorControl,
        perTier: perTier.map((t) => ({
          tier: t.tier,
          recalls: t.recalls,
          precisions: t.precisions,
          recallBand: t.recallBand,
          precisionBand: t.precisionBand,
          runs: t.tierRuns.map((r) => ({ index: r.index, rates: r.rates })),
        })),
        corpusShape: corpusShape(sessions),
        recallBand,
        precisionBand,
        meteredCostUsd: Number(totalCost.toFixed(4)),
        calibration: { shortest: shortest.id, shortCost, longest: longest.id, longCost },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\nwrote ${join(options.outDir, "summary.json")}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
