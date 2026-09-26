// Turning the per-session records into the numbers the report carries, and into a band
// rather than a headline.
//
// Two rules about denominators, both of which a single average would hide:
//
//   - A session whose model call never happened is not a zero. `evals/run-suite.sh`
//     established that for the routing suite - a run that never reached the model scored
//     0.00 and moved the average as if the model had answered and got it wrong - and the
//     same rule applies here: an invocation failure leaves every denominator and is
//     reported as its own rate. An unparseable reply is NOT that: the model answered, the
//     answer was unusable, and that is a product outcome.
//   - The lesson-free session has no labels, so it is out of every recall denominator and
//     in every precision denominator. Everything kept there is noise by construction.
import type { HarvestKind } from "../../src/lib/harvest.js";
import type { SievedItem } from "../../src/lib/harvest.js";
import { SESSIONS } from "./corpus.js";
import type { Label, LabelKind } from "./corpus.js";

export interface ItemRecord {
  name: string;
  emittedKind: HarvestKind;
  kept: boolean;
  sieveReason?: SievedItem["reason"];
  /** label ids the grader said were the same lesson */
  matchedLabels: string[];
  /** distractor ids the grader said were this item's central claim */
  matchedDistractors: string[];
  graderUnreadable: number;
}

export interface SessionRun {
  sessionId: string;
  /** false only when the model call itself failed - see the denominator rule above */
  reached: boolean;
  outcome: "harvested" | "error" | "skipped";
  error?: string;
  unparseable: boolean;
  ms: number;
  costUsd: number | null;
  substance: boolean;
  promptsOffered: number;
  correctionsKept: number;
  correctionsTruncated: number;
  redactedLines: number;
  sliceChars: number;
  presence: Array<{ labelId: string; inSlice: boolean; inCorrections: boolean }>;
  /** elements in the model's array before any of them was validated */
  rawElements: number | null;
  /** elements `parseItem` refused: bad schema, ungrounded quote, unknown pair id */
  parseRejected: number;
  /** those refusals broken down by which anchor or field failed */
  refusals: Record<string, number>;
  /** the refusal classifier accepted exactly what the product's own parser kept */
  refusalMirrorAgrees: boolean;
  items: ItemRecord[];
  written: string[];
  /** re-deriving the sieve from the raw reply reproduced what the product wrote */
  rederivationAgrees: boolean;
}

const LABELS = new Map(
  SESSIONS.flatMap((s) => s.labels.map((l) => [l.id, { kind: l.kind, sessionId: s.id }] as const)),
);

export interface Rates {
  /** found / labels, over sessions whose model call happened */
  recall: Record<LabelKind | "all", { found: number; total: number }>;
  /** the same, counting a label the model proposed and the sieve then dropped */
  recallBeforeSieve: Record<LabelKind | "all", { found: number; total: number }>;
  /** kept items that sit on some label / kept items, by the kind the model EMITTED */
  precision: Record<HarvestKind | "all", { onLabel: number; kept: number }>;
  /** kept items whose central claim is a one-system fact */
  distractorCapture: { hits: number; kept: number };
  discoveryShare: { discovery: number; kept: number };
  sieveReasons: Record<string, number>;
  parseRejected: number;
  refusals: Record<string, number>;
  rawElements: number;
  /** label kind (rows) against the kind the model emitted for it (columns) */
  confusion: Record<string, Record<string, number>>;
  invalid: { runsNotReached: number; runs: number };
  unparseable: number;
  /**
   * "The model returned nothing" is three different outcomes and they need three different
   * fixes, so counting them together is how an adjustment gets aimed at the wrong thing:
   *
   *  - `modelEmpty` is an empty array from a session that HAD a lesson to find, which is
   *    the product's own yield problem;
   *  - `allRefused` is a session where the model proposed something and every element was
   *    refused before the sieve, which is an evidence problem, not a yield one;
   *  - `lessonFreeKept` is what came out of the session with no lesson in it, where the
   *    right answer is nothing and anything kept is pure noise.
   */
  modelEmpty: { sessions: number; labelled: number };
  allRefused: number;
  lessonFreeKept: number;
  graderUnreadable: number;
  costUsd: number;
  wallMs: number;
}

const KINDS: HarvestKind[] = ["correction", "procedure", "error-fix", "discovery"];
const LABEL_KINDS: LabelKind[] = ["correction", "procedure", "error-fix"];

function emptyRates(): Rates {
  const recall = { all: { found: 0, total: 0 } } as Rates["recall"];
  const before = { all: { found: 0, total: 0 } } as Rates["recallBeforeSieve"];
  for (const k of LABEL_KINDS) {
    recall[k] = { found: 0, total: 0 };
    before[k] = { found: 0, total: 0 };
  }
  const precision = { all: { onLabel: 0, kept: 0 } } as Rates["precision"];
  for (const k of KINDS) precision[k] = { onLabel: 0, kept: 0 };
  const confusion: Rates["confusion"] = {};
  for (const lk of LABEL_KINDS) {
    confusion[lk] = {};
    for (const k of KINDS) confusion[lk]![k] = 0;
  }
  return {
    recall,
    recallBeforeSieve: before,
    precision,
    distractorCapture: { hits: 0, kept: 0 },
    discoveryShare: { discovery: 0, kept: 0 },
    sieveReasons: {},
    parseRejected: 0,
    refusals: {},
    rawElements: 0,
    confusion,
    invalid: { runsNotReached: 0, runs: 0 },
    unparseable: 0,
    modelEmpty: { sessions: 0, labelled: 0 },
    allRefused: 0,
    lessonFreeKept: 0,
    graderUnreadable: 0,
    costUsd: 0,
    wallMs: 0,
  };
}

/** Pool one run's sessions into one set of rates. Pooling within a run and then taking a
 * band over runs, rather than averaging per-session rates, keeps a session with one label
 * from weighing as much as a session with three. */
export function pool(runs: SessionRun[]): Rates {
  const r = emptyRates();
  for (const run of runs) {
    r.invalid.runs += 1;
    r.wallMs += run.ms;
    if (run.costUsd !== null) r.costUsd += run.costUsd;
    if (!run.reached) {
      r.invalid.runsNotReached += 1;
      continue;
    }
    if (run.unparseable) r.unparseable += 1;
    const session = SESSIONS.find((s) => s.id === run.sessionId);
    const labelled = (session?.labels.length ?? 0) > 0;
    if (labelled) {
      r.modelEmpty.labelled += 1;
      // keyed on what the MODEL emitted, not on what survived: a session whose single
      // proposal was refused for fabricated evidence is not a session the model was silent in
      if (run.rawElements === 0) r.modelEmpty.sessions += 1;
    }
    if ((run.rawElements ?? 0) > 0 && run.parseRejected === run.rawElements) r.allRefused += 1;
    if (!labelled) r.lessonFreeKept += run.items.filter((i) => i.kept).length;
    r.parseRejected += run.parseRejected;
    r.rawElements += run.rawElements ?? 0;
    for (const [reason, n] of Object.entries(run.refusals)) {
      r.refusals[reason] = (r.refusals[reason] ?? 0) + n;
    }

    for (const label of session?.labels ?? []) {
      const kind = label.kind;
      r.recall[kind]!.total += 1;
      r.recall.all.total += 1;
      r.recallBeforeSieve[kind]!.total += 1;
      r.recallBeforeSieve.all.total += 1;
      const onAny = run.items.filter((i) => i.matchedLabels.includes(label.id));
      if (onAny.some((i) => i.kept)) {
        r.recall[kind]!.found += 1;
        r.recall.all.found += 1;
      }
      if (onAny.length > 0) {
        r.recallBeforeSieve[kind]!.found += 1;
        r.recallBeforeSieve.all.found += 1;
        for (const item of onAny) r.confusion[kind]![item.emittedKind]! += 1;
      }
    }

    for (const item of run.items) {
      r.graderUnreadable += item.graderUnreadable;
      if (!item.kept) {
        const reason = item.sieveReason ?? "unknown";
        r.sieveReasons[reason] = (r.sieveReasons[reason] ?? 0) + 1;
        continue;
      }
      r.precision.all.kept += 1;
      r.precision[item.emittedKind]!.kept += 1;
      // A kept item counts as on-label when it sits on a label of THIS session. A match
      // against a label from elsewhere is what the shuffled-label control measures, and
      // it must never be able to raise precision here.
      const own = new Set((session?.labels ?? []).map((l) => l.id));
      if (item.matchedLabels.some((id) => own.has(id))) {
        r.precision.all.onLabel += 1;
        r.precision[item.emittedKind]!.onLabel += 1;
      }
      if (item.matchedDistractors.length > 0) r.distractorCapture.hits += 1;
      r.distractorCapture.kept += 1;
      if (item.emittedKind === "discovery") r.discoveryShare.discovery += 1;
      r.discoveryShare.kept += 1;
    }
  }
  return r;
}

export function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/**
 * Mean and an empirical two-standard-deviation band over the runs, sample standard
 * deviation (n-1 in the denominator), which is the method the routing suite's own baseline
 * record uses. Three runs is the floor, not a comfort: a single run of anything that calls
 * a model is not a headline, and this repo has measured two runs of the same package
 * disagreeing on more than half of its cases.
 */
export function band(values: number[]): { mean: number; sd: number; low: number; high: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  return { mean, sd, low: mean - 2 * sd, high: mean + 2 * sd };
}

export function labelKindOf(labelId: string): LabelKind | null {
  return LABELS.get(labelId)?.kind ?? null;
}

export function sessionOfLabel(labelId: string): string | null {
  return LABELS.get(labelId)?.sessionId ?? null;
}

/**
 * The shuffled-label control as a RATE, computed from the verdicts themselves.
 *
 * Reading it off `pool()` instead would have made it unfalsifiable: `pool` counts a match
 * only against a label of the item's OWN session, so a control row - whose matches are all
 * donor ids - reports zero whatever the grader said. A zero that cannot move is not
 * evidence, and the whole point of this control is that it could come back non-zero.
 */
export function controlYesRate(
  rows: SessionRun[],
  donors: Map<string, Label[]>,
): { yes: number; pairs: number } {
  let yes = 0;
  let pairs = 0;
  for (const row of rows) {
    const donated = donors.get(row.sessionId) ?? [];
    pairs += row.items.length * donated.length;
    for (const item of row.items) yes += item.matchedLabels.length;
  }
  return { yes, pairs };
}
