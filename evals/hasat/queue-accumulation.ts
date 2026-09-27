// Does a queue that already holds a lesson stop the next session from proposing it again?
//
//     npx vite-node evals/hasat/queue-accumulation.ts -- --dry-run
//     npx vite-node evals/hasat/queue-accumulation.ts
//
// The measurement next door saw one lesson come back thirty times under twenty-six names -
// but every session there runs in a FRESH home, which is required of it: a shared one would
// make the first fixture's teachings the second's echoes and its candidates the next one's
// "recent review decisions", so the fixtures would measure each other rather than the
// product. That is exactly why it cannot answer this question. Nothing in that run could
// have suppressed a second proposal.
//
// Production accumulates. `harvestSession` injects the twenty most recent non-archived
// candidates into the prompt and tells the model not to re-propose them, and
// `recordAndMatchTeachings` remembers what the developer has said before. So this runs the
// dense corpus the way a real machine runs it: ONE home, sessions in order, harvest only.
//
// It grades nothing. Whether two items are the same lesson is a question for the grader over
// there; what this answers is cheaper and sharper - with the queue in front of it, does the
// model write a candidate whose own slug is already in that queue, and how large does the
// queue get. The item names it wrote are printed so the same clustering the report does by
// hand can be done against them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestSession } from "../../src/lib/harvest.js";
import { listCandidates } from "../../src/lib/queue.js";
import { childIsolationArgs } from "../../src/lib/score.js";
import { pooledInTier } from "./corpus.js";
import { buildSession } from "./session.js";

const FIXTURE_REMOTE = "git@fixture.invalid:stand-in/repo.git";

interface Row {
  sessionId: string;
  /** candidates the prompt carried as "recent review decisions" when this session ran */
  decisionsInjected: number;
  outcome: string;
  written: string[];
  /** a written candidate whose slug was already taken in the queue: the model proposed a
   * name the prompt had just told it not to re-propose */
  slugCollisions: string[];
  dropped: Array<{ name: string; reason: string }>;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const only = (() => {
    const i = argv.indexOf("--sessions");
    return i === -1 ? [] : (argv[i + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  })();
  const sessions = pooledInTier(2).filter((s) => only.length === 0 || only.includes(s.id));
  const outDir = join(process.cwd(), "evals", "results", "queue-accumulation");
  mkdirSync(outDir, { recursive: true });

  const isolation = await childIsolationArgs();
  if (isolation.length === 0) {
    console.error(
      "the installed claude CLI cannot isolate the child, so the child would inherit this\n" +
        "repository and this plugin's own hooks. Refusing to run.",
    );
    process.exit(2);
  }

  // ONE home for the whole pass - the opposite of the sibling runner, and the point of this
  // measurement. Written the same way: the product's own config override, not a patched
  // constant.
  const home = mkdtempSync(join(tmpdir(), "th-queue-accum-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ harvest: { model: "sonnet" } }), "utf8");
  console.log(`sessions   : ${sessions.length} (tier 2, in corpus order)`);
  console.log(`home       : one, shared, as production has one`);
  console.log(`grading    : none - see the header`);
  if (dryRun) {
    console.log("\n--dry-run: nothing spent. Each session would be harvested once, in order.");
    return;
  }

  const rows: Row[] = [];
  for (const session of sessions) {
    const before = listCandidates(home).filter((c) => c.status !== "archived");
    const taken = new Set(before.map((c) => c.slug));
    const built = buildSession(session, home);
    const summary = await harvestSession(built.job, home, {
      skillDirs: () => [],
      listSkills: () => session.existingSkills ?? [],
      remoteUrl: () => FIXTURE_REMOTE,
    });
    const written = summary.written ?? [];
    // `uniqueSlug` suffixes a name already in the queue rather than refusing it, so the
    // collision is visible in the slug the candidate ended up with.
    const collisions = written.filter((slug) => /-\d+$/.test(slug) && taken.has(slug.replace(/-\d+$/, "")));
    rows.push({
      sessionId: session.id,
      decisionsInjected: Math.min(20, before.length),
      outcome: summary.outcome,
      written,
      slugCollisions: collisions,
      dropped: summary.dropped ?? [],
    });
    console.log(
      `${session.id.padEnd(50)} queue in ${String(before.length).padStart(3)} | injected ${String(Math.min(20, before.length)).padStart(2)} | wrote ${written.length}${collisions.length > 0 ? ` | RE-PROPOSED ${collisions.join(", ")}` : ""}`,
    );
  }

  const queue = listCandidates(home);
  console.log(`\nqueue after ${rows.length} sessions: ${queue.length} candidates`);
  const byKind: Record<string, number> = {};
  for (const c of queue) byKind[c.kind ?? "(none)"] = (byKind[c.kind ?? "(none)"] ?? 0) + 1;
  console.log(`by kind: ${Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const collisions = rows.flatMap((r) => r.slugCollisions);
  console.log(
    `candidates whose slug was already in the queue: ${collisions.length}` +
      (collisions.length > 0 ? ` (${collisions.join(", ")})` : " - the model never re-used a name it was shown"),
  );
  const echoed = queue.filter((c) => (c.taughtBefore ?? 0) > 0);
  console.log(`candidates marked as taught in an earlier session: ${echoed.length}`);
  console.log(`\nevery slug, in the order it was written (cluster these by hand):`);
  for (const row of rows) {
    if (row.written.length === 0) {
      console.log(`  ${row.sessionId}: (nothing)`);
      continue;
    }
    console.log(`  ${row.sessionId}:`);
    for (const slug of row.written) {
      const meta = queue.find((c) => c.slug === slug);
      console.log(`      ${slug} [${meta?.kind ?? "?"}] ${meta?.description ?? ""}`);
    }
  }
  writeFileSync(
    join(outDir, "accumulation.json"),
    `${JSON.stringify({ at: new Date().toISOString(), rows, queue }, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nwritten to ${join(outDir, "accumulation.json")}`);
  // Deliberately not deleted: the queue itself is the result, and every candidate's own
  // SKILL.md is under `candidates/` for reading.
  console.log(`home kept for reading: ${home}`);
}

void main();
