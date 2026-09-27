// What would this finished run have measured under a different sieve? Derived, for nothing.
//
//     npx vite-node evals/hasat/derive.ts -- --results evals/results/after-t1
//     npx vite-node evals/hasat/derive.ts -- --results evals/results/after-t1 --floor 8
//
// `sieve-replay.ts` next door answers a narrower question and can only ever cut: it reads the
// items a run KEPT and asks what a stricter rule would have removed. That is the wrong shape
// for a rule being withdrawn rather than added, because the items at issue are the ones the
// run dropped, and they are not in its input at all.
//
// This one reads both halves of the recorded material - every kept item and every dropped one,
// with its verdict - and puts the whole set back through the product's own
// `sieveHarvestItems`. So it derives in both directions: a floor imposed with `--floor` cuts,
// and a floor absent from today's product restores what an earlier one cut. That is what makes
// a run taken under a setting that shipped in no version still readable.
//
// It is exact only because the sieve rule at issue is a pure veto - it changes nothing about
// what the model proposed, so the items a finished run recorded are the items it would have
// been handed. Two rules it CANNOT derive, and the numbers say so rather than pretending:
// anything depending on the injected existing-skill list (the `duplicate` branch) or on the
// muted set, since neither is recorded per session. `--floor` therefore doubles as the
// self-check: given the setting a run was actually taken with, the derivation has to reproduce
// that run's kept set item for item, and the last line reports whether it did.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HarvestItem } from "../../src/lib/harvest.js";
import { defaultHarvestConfig, sieveHarvestItems } from "../../src/lib/harvest.js";
import { SESSIONS } from "./corpus.js";

/** Labels an injected skill already covers are out of every denominator, exactly as the
 * runner leaves them out: the right outcome for those is silence. */
const COVERED = new Set(SESSIONS.flatMap((s) => (s.labels ?? []).filter((l) => l.coveredBy).map((l) => l.id)));

interface Recorded {
  sessionId: string;
  items: HarvestItem[];
  /** what the run itself kept, so the derivation can be checked against it */
  keptNames: string[];
}

function loadRun(dir: string, run: number): { rows: Recorded[]; matched: Map<string, string[]>; denominator: number } | null {
  const materialDir = join(dir, `material-${run}`);
  const runFile = join(dir, `run-${run}.json`);
  if (!existsSync(materialDir) || !existsSync(runFile)) return null;
  const parsed = JSON.parse(readFileSync(runFile, "utf8")) as {
    sessions: Array<{ sessionId: string; reached: boolean; presence?: Array<{ labelId: string }>; items?: Array<{ name: string; matchedLabels?: string[] }> }>;
  };
  const matched = new Map<string, string[]>();
  let denominator = 0;
  for (const s of parsed.sessions) {
    for (const it of s.items ?? []) matched.set(`${s.sessionId}\u0000${it.name}`, it.matchedLabels ?? []);
    // a call that never reached the model puts its labels outside every denominator
    if (s.reached) denominator += (s.presence ?? []).filter((p) => !COVERED.has(p.labelId)).length;
  }
  const rows: Recorded[] = [];
  for (const file of readdirSync(materialDir).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(materialDir, file), "utf8")) as {
      sessionId: string;
      items?: Array<{ kept: boolean; item: HarvestItem }>;
    };
    rows.push({
      sessionId: m.sessionId,
      items: (m.items ?? []).map((x) => x.item),
      keptNames: (m.items ?? []).filter((x) => x.kept).map((x) => x.item.name),
    });
  }
  return { rows, matched, denominator };
}

function mean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function sd(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

function main(): void {
  const argv = process.argv.slice(2);
  const dir = argv[argv.indexOf("--results") + 1];
  if (argv.indexOf("--results") === -1 || !dir || !existsSync(dir)) {
    console.error("--results <dir>: a directory holding run-N.json and material-N/ from a finished run");
    process.exit(2);
  }
  const floor = argv.includes("--floor") ? Number(argv[argv.indexOf("--floor") + 1]) : null;

  const recalls: number[] = [], precisions: number[] = [], shares: number[] = [];
  let keptTotal = 0, discTotal = 0, mismatches = 0, restored = 0;
  for (let run = 1; ; run++) {
    const loaded = loadRun(dir, run);
    if (!loaded) break;
    let found = 0, kept = 0, onLabel = 0, discovery = 0;
    for (const row of loaded.rows) {
      // the floor is re-imposed here rather than inside the product, so the product stays the
      // thing being measured
      const offered = floor === null ? row.items : row.items.filter((i) => !(i.kind === "discovery" && i.total < floor));
      const result = sieveHarvestItems(offered, {
        existingSkillNames: new Set<string>(),
        muted: new Set<string>(),
        minScore: defaultHarvestConfig.minScore,
        maxPerSession: defaultHarvestConfig.maxPerSession,
      });
      const names = result.kept.map((i) => i.name);
      if (names.join("\u0000") !== row.keptNames.join("\u0000")) mismatches += 1;
      restored += names.filter((n) => !row.keptNames.includes(n)).length;
      const hits = new Set<string>();
      for (const item of result.kept) {
        kept += 1;
        if (item.kind === "discovery") discovery += 1;
        const labels = (loaded.matched.get(`${row.sessionId}\u0000${item.name}`) ?? []).filter((l) => !COVERED.has(l));
        if (labels.length > 0) onLabel += 1;
        for (const l of labels) hits.add(l);
      }
      found += hits.size;
    }
    keptTotal += kept;
    discTotal += discovery;
    recalls.push(found / loaded.denominator);
    precisions.push(onLabel / kept);
    shares.push(discovery / kept);
    console.log(
      `run ${run}: recall ${found}/${loaded.denominator} = ${(found / loaded.denominator).toFixed(4)}` +
        `   precision ${onLabel}/${kept} = ${(onLabel / kept).toFixed(4)}` +
        `   discovery ${discovery}/${kept} = ${((discovery / kept) * 100).toFixed(1)}%`,
    );
  }
  if (recalls.length === 0) {
    console.error(`no runs under ${dir}`);
    process.exit(2);
  }
  for (const [name, values] of [["recall   ", recalls], ["precision", precisions]] as const)
    console.log(`${name}: mean ${mean(values).toFixed(4)}  sd ${sd(values).toFixed(4)}  band [${(mean(values) - 2 * sd(values)).toFixed(4)} ; ${(mean(values) + 2 * sd(values)).toFixed(4)}]`);
  // pooled and per-run are different averages and the report has to name which it quotes
  console.log(`discovery share of kept: ${(mean(shares) * 100).toFixed(1)}% mean over runs, ${((discTotal / keptTotal) * 100).toFixed(1)}% pooled`);
  console.log(
    floor === null
      ? `derived with no kind floor (today's product); items restored that the recorded run had dropped: ${restored}`
      : `derived with a discovery floor of ${floor}; session-runs whose kept set differs from the recorded one: ${mismatches}` +
        (mismatches === 0 ? " - the derivation reproduces the run it is checked against" : " - READ NOTHING HERE until this is 0"),
  );
}

main();
