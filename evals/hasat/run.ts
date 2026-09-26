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
import { SESSIONS, shuffledLabels } from "./corpus.js";
import type { CorpusSession, Label } from "./corpus.js";
import { buildSession } from "./session.js";
import { askGrader, buildDistractorPrompt, buildSameLessonPrompt, GRADER_MODEL } from "./grader.js";
import { band, controlYesRate, pool, rate } from "./metrics.js";
import { classifyRefusal, rawElements } from "./tiers.js";
import type { ItemRecord, Rates, SessionRun } from "./metrics.js";
import { DISTRACTOR_CONTROLS, GRADER_CASES } from "./grader-cases.js";

const execFileAsync = promisify(execFile);

/** The task's ceiling. Checked against a metered call, and the run refuses rather than
 * overspending: a number nobody authorised is not worth having. */
const BUDGET_USD = 40;
const CONCURRENCY = 4;
/** A stand-in remote, so a "project"-scoped item has something to collapse to other than
 * "team" - otherwise the scope a model chose is unreadable in the written candidate. */
const FIXTURE_REMOTE = "git@fixture.invalid:stand-in/repo.git";

interface Options {
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
  return {
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
  if (options.sessions.length === 0) return SESSIONS;
  return SESSIONS.filter((s) => options.sessions.includes(s.id));
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
    // nothing of this machine: no skill directory is read, and the remote is a stand-in
    skillDirs: () => [],
    listSkills: () => [],
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
    existingSkillNames: new Set<string>(),
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
    if (entry.kept) {
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

async function checkGrader(repeats: number): Promise<GraderCheck> {
  const trials = Array.from({ length: repeats }, (_, repeat) =>
    GRADER_CASES.map((testCase) => ({ repeat, testCase })),
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
  const majorityDisagreements = GRADER_CASES.filter((testCase) => {
    const yes = (yesCount.get(testCase.id) ?? 0) > repeats / 2;
    return yes !== testCase.expected;
  }).map((testCase) => testCase.id);
  return {
    perRepeat,
    cases: GRADER_CASES.length,
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
    existingSkills: [],
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
  console.log(`distractor capture       : ${r.distractorCapture.hits}/${r.distractorCapture.kept} = ${pct(rate(r.distractorCapture.hits, r.distractorCapture.kept))}`);
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
  console.log("label kind -> emitted kind:");
  for (const [labelKind, row] of Object.entries(r.confusion)) {
    console.log(`  ${labelKind.padEnd(11)} ${Object.entries(row).map(([k, v]) => `${k} ${v}`).join("  ")}`);
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
  const sessions = selected(options);
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
  console.log(`sessions                 : ${sessions.length}`);
  console.log(`runs                     : ${options.runs}`);

  if (options.checkOnly) {
    const only = await checkGrader(3);
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
  const graderCallsPerRun = sessions.reduce(
    (n, s) => n + defaultHarvestConfig.maxPerSession * 2 * Math.max(1, s.labels.length) + defaultHarvestConfig.maxPerSession * s.distractors.length,
    0,
  );
  const graderCheckCalls = options.graderCheck ? GRADER_CASES.length * 3 : 0;
  console.log(
    `projected calls          : ${sessions.length * options.runs} harvest, up to ` +
      `${graderCallsPerRun * options.runs + graderCallsPerRun + graderCheckCalls} grader ` +
      `(including the shuffled-label control and the grader check)`,
  );
  if (perHarvest !== null) {
    // The grader is metered per call at run time; here it is priced from the harvest
    // calibration divided down, which is an UPPER bound for a one-word reply on a cheaper
    // model. Deliberately pessimistic: the point of this check is to refuse, not to be
    // precise.
    const projected =
      perHarvest * sessions.length * options.runs +
      perHarvest * 0.5 * (graderCallsPerRun * options.runs + graderCallsPerRun + graderCheckCalls) +
      (shortCost ?? 0) + (longCost ?? 0);
    console.log(`projected spend (upper)  : $${projected.toFixed(2)} against a $${BUDGET_USD} ceiling`);
    if (projected > BUDGET_USD) {
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

  const graderCheck = options.graderCheck && options.grade ? await checkGrader(3) : null;
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
  let controlRates: Rates | null = null;
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
          outcomes.map((outcome, i) => ({ outcome, session: sessions[i]! })),
          CONCURRENCY,
          async ({ outcome, session }) => ({
            outcome,
            session,
            real: await gradeItems(session, outcome, (s) => s.labels),
            // The control reuses the SAME items - it costs grading, not harvesting - and
            // only on the first run, because it measures the grader, not the product.
            control: index === 0 ? await gradeItems(session, outcome, (s) => shuffled.get(s.id) ?? []) : null,
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
    const rates = pool(rows);
    runs.push({ index: index + 1, rates, sessions: rows });
    if (index === 0 && controlRows.length > 0) {
      controlRates = pool(controlRows);
      controlRows1 = controlRows;
    }
    printRates(`run ${index + 1}`, rates);
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
        ` - this is the number that has to be near zero. Read every precision figure above as` +
        ` inflated by roughly this much.`,
    );
  }

  const recalls = runs.map((r) => rate(r.rates.recall.all.found, r.rates.recall.all.total) ?? 0);
  const precisions = runs.map((r) => rate(r.rates.precision.all.onLabel, r.rates.precision.all.kept) ?? 0);
  const recallBand = band(recalls);
  const precisionBand = band(precisions);
  console.log("\n=== band over the runs (mean +/- 2 sample standard deviations) ===");
  console.log(`recall    : ${recalls.map((v) => v.toFixed(4)).join(" / ")}  mean ${recallBand.mean.toFixed(4)}  sd ${recallBand.sd.toFixed(4)}  band [${recallBand.low.toFixed(4)} ; ${recallBand.high.toFixed(4)}]`);
  console.log(`precision : ${precisions.map((v) => v.toFixed(4)).join(" / ")}  mean ${precisionBand.mean.toFixed(4)}  sd ${precisionBand.sd.toFixed(4)}  band [${precisionBand.low.toFixed(4)} ; ${precisionBand.high.toFixed(4)}]`);
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
        control: controlRates,
        controlYesRate: control,
        estimatedHarvestUsd,
        graderCheck,
        distractorControl,
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
