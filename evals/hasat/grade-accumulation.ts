// Grade what a shared-home pass actually wrote, against the lessons its sessions carried.
//
//     npx vite-node evals/hasat/grade-accumulation.ts -- --home <the home the pass kept>
//
// `queue-accumulation.ts` answers a question about volume and names without spending a cent
// on grading, and that is the right split for what it is for. But "the session wrote one item
// instead of three" has two readings - the queue suppressed a repeat, or it suppressed the
// session's own lesson - and only the grader can tell them apart. So this pass reads the
// candidates that run left on disk and asks the same same-lesson question the corpus
// measurement asks, so the two numbers can be set beside each other.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarvestItem } from "../../src/lib/harvest.js";
import { pooledInTier } from "./corpus.js";
import type { Label } from "./corpus.js";
import { askGrader, buildSameLessonPrompt } from "./grader.js";

/** A candidate on disk, read back into the shape the grader question takes. */
function itemFrom(dir: string, slug: string): { item: HarvestItem; sessionId: string } | null {
  const meta = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8")) as {
    sessionId?: string;
    description?: string;
    kind?: HarvestItem["kind"];
    gate?: { total?: number; scores?: Record<string, number> };
  };
  const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
  const grounded = existsSync(join(dir, "grounded-case.json"))
    ? (JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8")) as { expect?: string; quote?: string })
    : {};
  const body = skillMd.split(/\n---\n/).slice(1).join("\n---\n").split("\n## Grounded case")[0]?.trim() ?? "";
  if (!meta.sessionId) return null;
  return {
    sessionId: meta.sessionId.replace(/^fixture-/, ""),
    item: {
      kind: meta.kind ?? "discovery",
      name: slug,
      description: meta.description ?? "",
      body,
      expect: grounded.expect ?? "",
      scope: "team",
      scores: meta.gate?.scores ?? {},
      total: meta.gate?.total ?? 0,
      ...(grounded.quote ? { quote: grounded.quote } : {}),
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = argv[argv.indexOf("--home") + 1];
  if (!home || !existsSync(join(home, "candidates"))) {
    console.error("--home <dir>: the home a queue-accumulation pass kept");
    process.exit(2);
  }
  const base = join(home, "candidates");
  const written = readdirSync(base).filter((d) => existsSync(join(base, d, "candidate.json")));
  const rows: Array<{ sessionId: string; labelId: string; found: boolean; by: string | null }> = [];
  const items = written.map((slug) => itemFrom(join(base, slug), slug)).filter((x): x is NonNullable<typeof x> => !!x);
  let cost = 0;
  let unreadable = 0;

  // The selection the pass itself runs, so a session it never harvested cannot read as a
  // miss - which is what a run over every session in the corpus would have reported.
  const ran = pooledInTier(2);
  for (const session of ran) {
    const mine = items.filter((i) => i.sessionId === session.id);
    for (const label of session.labels) {
      let by: string | null = null;
      for (const { item } of mine) {
        const verdict = await askGrader(buildSameLessonPrompt(item, label as Label));
        cost += verdict.costUsd ?? 0;
        if (verdict.unreadable) unreadable += 1;
        if (verdict.yes) {
          by = item.name;
          break;
        }
      }
      rows.push({ sessionId: session.id, labelId: label.id, found: by !== null, by });
    }
  }
  const labels = new Map(ran.flatMap((s) => s.labels.map((l) => [l.id, l] as const)));
  const scored = rows.filter((r) => !labels.get(r.labelId)?.coveredBy);
  console.log(`\nper label, in one shared-home pass:`);
  for (const row of rows) {
    const label = labels.get(row.labelId)!;
    console.log(
      `  ${row.labelId.padEnd(36)} ${label.coveredBy ? "covered (out of the denominator)" : row.found ? "found" : "MISSED"}` +
        `${row.by ? `  as ${row.by}` : ""}`,
    );
  }
  console.log(
    `\nrecall in one shared-home pass: ${scored.filter((r) => r.found).length}/${scored.length}` +
      ` (items written: ${items.length}; grader spend $${cost.toFixed(3)}; unreadable verdicts ${unreadable})`,
  );
  writeFileSync(join(home, "graded.json"), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`, "utf8");
}

void main();
