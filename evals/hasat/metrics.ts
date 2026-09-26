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
import type { CorpusSession, Form, Label, LabelKind } from "./corpus.js";

export interface ItemRecord {
  name: string;
  emittedKind: HarvestKind;
  kept: boolean;
  sieveReason?: SievedItem["reason"];
  /** label ids the grader said were the same lesson */
  matchedLabels: string[];
  /** distractor ids the grader said were this item's central claim */
  matchedDistractors: string[];
  /** whether the distractor question was put for this item at all - it is asked on the first
   * run only, and an unasked question must not look like a negative answer */
  distractorsAsked?: boolean;
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

/** The cells of the kind-against-form table, as `kind/form` keys. Tier 1 left five of them
 * empty and could therefore not say which of two nested attributes its misses belonged to,
 * which is the flaw tier 2 exists to remove - so the table is computed by the tool rather
 * than assembled by hand for a report. */
export type CrossCell = `${LabelKind}/${Form}`;

export interface Rates {
  /** found / labels, over sessions whose model call happened */
  recall: Record<LabelKind | "all", { found: number; total: number }>;
  /** the same, counting a label the model proposed and the sieve then dropped */
  recallBeforeSieve: Record<LabelKind | "all", { found: number; total: number }>;
  /** recall by how the lesson was stated, which is the axis tier 2 adds `unstated` to */
  recallByForm: Record<Form, { found: number; total: number }>;
  /** recall per cell of the kind-against-form table */
  recallByCell: Record<string, { found: number; total: number }>;
  /** kept items that sit on some label / kept items, by the kind the model EMITTED */
  precision: Record<HarvestKind | "all", { onLabel: number; kept: number }>;
  /** kept items whose central claim is a one-system fact. `asked` is false on the runs where
   * the question was not put at all, so a rate of zero there cannot be read as a result - the
   * denominator is kept items and it fills whether the question was asked or not. */
  distractorCapture: { hits: number; kept: number; asked: boolean };
  discoveryShare: { discovery: number; kept: number };
  /**
   * The labels an existing skill already covers, where the right answer is silence.
   *
   * They are out of every recall denominator: counting a suppressed lesson as a recall miss
   * would score the product for obeying its own prompt. What is counted instead is whether
   * anything came back for them at all, and by which route it was stopped - the model
   * declining to propose it, or the sieve dropping an item whose slug already existed. Tier
   * 1 could measure neither, because the list of existing skills it injected was empty.
   */
  covered: {
    labels: number;
    /** the model proposed something the grader matched to the covered lesson */
    proposed: number;
    /** and it survived to the queue, which is the failure this measures */
    keptOnLabel: number;
    /** or the sieve's duplicate rule stopped it */
    droppedAsDuplicate: number;
  };
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
const FORMS: Form[] = ["hard-never", "soft-henceforth", "implicit", "unstated"];

function emptyRates(): Rates {
  const recall = { all: { found: 0, total: 0 } } as Rates["recall"];
  const before = { all: { found: 0, total: 0 } } as Rates["recallBeforeSieve"];
  for (const k of LABEL_KINDS) {
    recall[k] = { found: 0, total: 0 };
    before[k] = { found: 0, total: 0 };
  }
  const recallByForm = {} as Rates["recallByForm"];
  for (const f of FORMS) recallByForm[f] = { found: 0, total: 0 };
  const recallByCell: Rates["recallByCell"] = {};
  for (const k of LABEL_KINDS) for (const f of FORMS) recallByCell[`${k}/${f}`] = { found: 0, total: 0 };
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
    recallByForm,
    recallByCell,
    precision,
    distractorCapture: { hits: 0, kept: 0, asked: false },
    discoveryShare: { discovery: 0, kept: 0 },
    covered: { labels: 0, proposed: 0, keptOnLabel: 0, droppedAsDuplicate: 0 },
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
export function pool(runs: SessionRun[], corpus: CorpusSession[] = SESSIONS): Rates {
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
    const session = corpus.find((s) => s.id === run.sessionId);
    // A label an existing skill already covers is not a lesson this session is asked to
    // yield, so it counts for neither "the model said nothing about a session that had a
    // lesson" nor recall.
    const toFind = (session?.labels ?? []).filter((l) => !l.coveredBy);
    const labelled = toFind.length > 0;
    if (labelled) {
      r.modelEmpty.labelled += 1;
      // keyed on what the MODEL emitted, not on what survived: a session whose single
      // proposal was refused for fabricated evidence is not a session the model was silent in
      if (run.rawElements === 0) r.modelEmpty.sessions += 1;
    }
    if ((run.rawElements ?? 0) > 0 && run.parseRejected === run.rawElements) r.allRefused += 1;
    // Only the session that carries NO label at all: a session whose single label is
    // covered by an existing skill is a suppression case, counted above, and its kept items
    // are reported there rather than as noise from a session with nothing in it.
    if ((session?.labels.length ?? 0) === 0) {
      r.lessonFreeKept += run.items.filter((i) => i.kept).length;
    }
    r.parseRejected += run.parseRejected;
    r.rawElements += run.rawElements ?? 0;
    for (const [reason, n] of Object.entries(run.refusals)) {
      r.refusals[reason] = (r.refusals[reason] ?? 0) + n;
    }

    for (const label of session?.labels ?? []) {
      const onAnyLabel = run.items.filter((i) => i.matchedLabels.includes(label.id));
      if (label.coveredBy) {
        r.covered.labels += 1;
        if (onAnyLabel.length > 0) r.covered.proposed += 1;
        if (onAnyLabel.some((i) => i.kept)) r.covered.keptOnLabel += 1;
        if (onAnyLabel.some((i) => !i.kept && i.sieveReason === "duplicate")) {
          r.covered.droppedAsDuplicate += 1;
        }
        continue;
      }
      const kind = label.kind;
      const cell = `${label.kind}/${label.form}`;
      r.recallByForm[label.form]!.total += 1;
      r.recallByCell[cell] ??= { found: 0, total: 0 };
      r.recallByCell[cell]!.total += 1;
      r.recall[kind]!.total += 1;
      r.recall.all.total += 1;
      r.recallBeforeSieve[kind]!.total += 1;
      r.recallBeforeSieve.all.total += 1;
      const onAny = onAnyLabel;
      if (onAny.some((i) => i.kept)) {
        r.recall[kind]!.found += 1;
        r.recall.all.found += 1;
        r.recallByForm[label.form]!.found += 1;
        r.recallByCell[cell]!.found += 1;
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
      if (item.distractorsAsked) r.distractorCapture.asked = true;
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
