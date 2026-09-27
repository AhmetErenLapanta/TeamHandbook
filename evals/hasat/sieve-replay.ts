// What would a different sieve rule have kept? Replayed over a finished run, for nothing.
//
//     npx vite-node evals/hasat/sieve-replay.ts -- --results evals/results/hasat
//
// A rule that only DROPS items is exactly replayable: it changes nothing about what the
// model proposed, so the items a finished run recorded are the same items it would have been
// handed. That is the whole reason a policy question about the sieve does not need a new
// measurement - and the reason a policy question about the PROMPT does, which is why nothing
// here pretends to answer one.
//
// It reads what the runner archives: `material-N/<session>.json` for every item with its
// scores and its sieve verdict, and `run-N.json` for the grader's verdict on which items sat
// on a planted lesson. The number that decides a rule is not how much it cuts - it is how
// much of what it cuts was a lesson the corpus had labelled.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarvestItem, HarvestKind } from "../../src/lib/harvest.js";

interface Recorded {
  run: number;
  sessionId: string;
  item: HarvestItem;
  kept: boolean;
  reason: string | null;
  /** label ids the grader said this item was the same lesson as */
  matched: string[];
}

function loadRun(dir: string, run: number): Recorded[] {
  const materialDir = join(dir, `material-${run}`);
  if (!existsSync(materialDir)) return [];
  // the grader's verdicts, keyed by session and item name
  const matched = new Map<string, string[]>();
  const runFile = join(dir, `run-${run}.json`);
  if (existsSync(runFile)) {
    const parsed = JSON.parse(readFileSync(runFile, "utf8")) as {
      sessions?: Array<{ sessionId?: string; unitId?: string; items?: Array<{ name: string; matchedLabels?: string[] }> }>;
      rows?: Array<{ sessionId?: string; unitId?: string; items?: Array<{ name: string; matchedLabels?: string[] }> }>;
    };
    for (const row of parsed.sessions ?? parsed.rows ?? []) {
      const id = row.sessionId ?? row.unitId ?? "";
      for (const item of row.items ?? []) matched.set(`${id}\u0000${item.name}`, item.matchedLabels ?? []);
    }
  }
  const out: Recorded[] = [];
  for (const file of readdirSync(materialDir).filter((f) => f.endsWith(".json"))) {
    const parsed = JSON.parse(readFileSync(join(materialDir, file), "utf8")) as {
      sessionId?: string;
      unitId?: string;
      items?: Array<{ kept: boolean; reason: string | null; item: HarvestItem }>;
    };
    const id = parsed.sessionId ?? parsed.unitId ?? file.replace(/\.json$/, "");
    for (const row of parsed.items ?? []) {
      out.push({
        run,
        sessionId: id,
        item: row.item,
        kept: row.kept,
        reason: row.reason ?? null,
        matched: matched.get(`${id}\u0000${row.item.name}`) ?? [],
      });
    }
  }
  return out;
}

/** A candidate rule, as a predicate over the items a run KEPT: true means this rule keeps it. */
interface Rule {
  name: string;
  /** decided per item, with the session's other kept items in hand for the lone-kind rule */
  keeps: (item: HarvestItem, siblings: HarvestItem[]) => boolean;
}

const RULES: Rule[] = [
  // Both (i) rows read a CLAIM. `withMeasuredRecurrence` raises the score to 2 on measured
  // evidence, but it only ever raises, so a 2 the model wrote on a hunch stays a 2 - and in a
  // recorded run of this package the echo list is injected empty, so nothing here was raised
  // at all. What a measured anchor would mean for THIS kind is a separate, and shorter,
  // question: the echo path needs a quote, which for a discovery no parser verifies, and the
  // pair path needs an error-fix's pair id. On the real queue not one of its discoveries
  // carries either.
  {
    name: "(i) an evidence anchor: recurrence >= 1, as claimed",
    keeps: (item) => (item.scores.recurrence ?? 0) >= 1,
  },
  {
    name: "(i) a strong anchor: recurrence == 2, as claimed",
    keeps: (item) => (item.scores.recurrence ?? 0) >= 2,
  },
  ...[5, 6, 7, 8, 9].map((floor) => ({
    name: `(ii) a floor of its own for discovery: total >= ${floor}`,
    keeps: (item: HarvestItem) => item.total >= floor,
  })),
  {
    name: "(iii) no discovery unless the session produced another kind",
    keeps: (_item: HarvestItem, siblings: HarvestItem[]) => siblings.some((s) => s.kind !== "discovery"),
  },
];

function main(): void {
  const argv = process.argv.slice(2);
  const dir = argv[argv.indexOf("--results") + 1];
  if (!dir || !existsSync(dir)) {
    console.error("--results <dir>: a finished run's output directory (material-N/ and run-N.json)");
    process.exit(2);
  }
  const kind = (argv.includes("--kind") ? argv[argv.indexOf("--kind") + 1] : "discovery") as HarvestKind;
  const rows: Recorded[] = [];
  for (let run = 1; run <= 9; run++) rows.push(...loadRun(dir, run));
  const kept = rows.filter((r) => r.kept);
  if (kept.length === 0) {
    console.error(`no kept items under ${dir}`);
    process.exit(2);
  }
  const target = kept.filter((r) => r.item.kind === kind);
  // Is a replay of a VETO exact over this material? Only while the sieve that ran dropped
  // nothing and no session-run proposed two items of a quota'd kind. Otherwise a veto frees
  // the quota's slot and an item the quota dropped comes back, which a predicate over the
  // kept items cannot model - and the reader has to be told rather than left to assume.
  const dropped = rows.filter((r) => !r.kept);
  const twoOfAKind = [...new Set(
    rows
      .filter((r) => r.item.kind === kind)
      .map((r) => `${r.run}/${r.sessionId}`)
      .filter((key, i, all) => all.indexOf(key) !== i),
  )];
  const exact = dropped.length === 0 && twoOfAKind.length === 0;
  const onLabel = (rs: Recorded[]) => rs.filter((r) => r.matched.length > 0).length;
  console.log(`${dir}`);
  console.log(`kept items       : ${kept.length} over ${new Set(kept.map((r) => `${r.run}/${r.sessionId}`)).size} session-runs`);
  console.log(
    exact
      ? `replay           : EXACT - the sieve that ran dropped nothing (${rows.length} items, all kept) and no` +
          ` session-run proposed two ${kind} items, so a veto cannot free a quota slot here`
      : `replay           : APPROXIMATE - ${dropped.length} items were dropped by the sieve that ran` +
          `${twoOfAKind.length > 0 ? ` and ${twoOfAKind.length} session-runs proposed two ${kind} items` : ""},` +
          ` so a veto can free a quota slot and an item counted as cut may come back. Read the cuts as an upper bound.`,
  );
  console.log(`of kind ${kind.padEnd(9)}: ${target.length} (${((100 * target.length) / kept.length).toFixed(1)}%), of which ${onLabel(target)} sit on a planted lesson`);
  console.log(`\nwhat each candidate rule would cut, and what it would cost:`);
  console.log(`${"rule".padEnd(64)} cuts        of those, on a planted lesson`);
  const bySession = new Map<string, HarvestItem[]>();
  for (const r of kept) {
    const key = `${r.run}/${r.sessionId}`;
    bySession.set(key, [...(bySession.get(key) ?? []), r.item]);
  }
  for (const rule of RULES) {
    const cut = target.filter((r) => !rule.keeps(r.item, bySession.get(`${r.run}/${r.sessionId}`) ?? []));
    const emptied = new Set(
      cut
        .filter((r) => (bySession.get(`${r.run}/${r.sessionId}`) ?? []).every((i) => cut.some((c) => c.item === i)))
        .map((r) => `${r.run}/${r.sessionId}`),
    );
    console.log(
      `${rule.name.padEnd(64)} ${`${cut.length}/${target.length}`.padEnd(11)} ${String(onLabel(cut)).padEnd(4)}` +
        `  ${emptied.size > 0 ? `[${emptied.size} session-runs left with nothing]` : ""}`,
    );
  }
  console.log(
    `\nThe column that decides this is the right-hand one. A rule that cuts volume and no\n` +
      `planted lesson is a rule this corpus can defend; one that cuts a planted lesson is not,\n` +
      `whatever it does to the volume. What no corpus can tell you is how much of the UNLABELLED\n` +
      `remainder was worth keeping - the report that reads these numbers classifies it by hand.`,
  );
}

main();
