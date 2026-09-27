// Does anything stop a lesson the developer ALREADY has a skill for, when that skill is
// called something else?
//
//     npx vite-node evals/hasat/duplicate-branch.ts -- --dry-run
//     npx vite-node evals/hasat/duplicate-branch.ts -- --runs 3
//
// Two things are supposed to stop it, and the sibling measurement could only ever exercise
// one of them. The prompt says to propose nothing that overlaps an existing skill; the sieve
// drops an item whose slug already exists. In the dense corpus the model stopped all nine
// covered cases by itself, so the sieve's `duplicate` branch was handed nothing and stayed
// unmeasured across two tiers.
//
// So here the covering skill is deliberately named NOTHING like the lesson it covers - the
// case the corpus next door avoids on purpose, where its covering skills are "named as the
// harvest would most plausibly name that lesson itself" to give the slug comparison a fair
// chance. A developer's own skill library is full of names like these: the rule is in the
// description, and the name is whatever they called it that afternoon.
//
// The sessions are three whose lesson came back in every run of the last measurement, so a
// silence here is the injected skill doing something rather than the session being hard.
//
// What it reports, per session per run:
//   - did the model propose the lesson anyway (the grader's own same-lesson question);
//   - if it did, what stopped the item: the sieve's `duplicate` rule, some other sieve rule,
//     or nothing at all and it reached the queue.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestSession, parseHarvestResponse, sieveHarvestItems, withMeasuredRecurrence } from "../../src/lib/harvest.js";
import type { HarvestItem, SievedItem } from "../../src/lib/harvest.js";
import { defaultHarvestConfig } from "../../src/lib/harvest.js";
import { childIsolationArgs } from "../../src/lib/score.js";
import type { SkillSummary } from "../../src/lib/skill-index.js";
import { SESSIONS } from "./corpus.js";
import type { CorpusSession, Label } from "./corpus.js";
import { buildSession } from "./session.js";
import { askGrader, buildSameLessonPrompt } from "./grader.js";

const FIXTURE_REMOTE = "git@fixture.invalid:stand-in/repo.git";

/**
 * The covering skill, per session: the session's own lesson, written as a real skill
 * description, under a name the harvest would never choose for it. Written before the run.
 */
const COVERING: Array<{ sessionId: string; labelId: string; skill: SkillSummary }> = [
  {
    sessionId: "a-unit-test-that-reached-the-network",
    labelId: "no-socket-in-unit-tests",
    skill: {
      name: "keep-the-fast-suite-offline",
      description:
        "Use when a test needs something that is not in the process: put the outbound call behind a seam and hand the test a stub at that seam, and leave the tests that need a real connection to the integration suite.",
    },
  },
  {
    sessionId: "a-migration-that-could-not-be-undone",
    labelId: "reversible-before-merge",
    skill: {
      name: "schema-change-checklist",
      description:
        "Use before a schema change merges: apply it to a copy of the real schema, run its reverse, apply it again, and split it in two when the reverse would lose information.",
    },
  },
  {
    sessionId: "rows-are-not-deleted-in-one-step",
    labelId: "deletion-procedure",
    skill: {
      name: "taking-something-out-in-stages",
      description:
        "Use when removing a field, column or endpoint: stop writing it, wait out the readers, keep a copy of the data, and only then take the thing itself away.",
    },
  },
];

interface Row {
  run: number;
  sessionId: string;
  labelId: string;
  /** the call reached the model. A call that timed out proposes nothing, which is the same
   * shape as the covering skill working, and counting it as one would credit the skill with a
   * silence it had no part in. One of these three sessions is the slowest in the corpus. */
  reached: boolean;
  /** the grader said one of the items the model proposed is this lesson */
  proposed: boolean;
  /** and it reached the queue */
  kept: boolean;
  /** the sieve rule that stopped it, when one did */
  stoppedBy: SievedItem["reason"] | null;
  itemNames: string[];
  costUsd: number;
}

async function harvestOnce(
  session: CorpusSession,
  covering: SkillSummary,
): Promise<{ items: Array<{ item: HarvestItem; kept: boolean; reason?: SievedItem["reason"] }>; reached: boolean }> {
  const home = mkdtempSync(join(tmpdir(), "th-dupe-home-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ harvest: { model: "sonnet" } }), "utf8");
  const built = buildSession(session, home);
  // The session's own list, with the covering skill in place of one of them, so the list
  // stays the three-to-five the tier injects rather than growing by one.
  const existing = [covering, ...(session.existingSkills ?? []).slice(1)];
  let raw = "";
  let failed = false;
  await harvestSession(built.job, home, {
    runner: async (prompt, model, timeoutMs) => {
      const { runClaudeCli } = await import("../../src/lib/score.js");
      try {
        raw = await runClaudeCli(prompt, model, timeoutMs);
      } catch {
        failed = true;
        throw new Error("claude call failed");
      }
      return raw;
    },
    skillDirs: () => [],
    listSkills: () => existing,
    remoteUrl: () => FIXTURE_REMOTE,
  });
  if (failed) return { items: [], reached: false };
  const parsed =
    parseHarvestResponse(raw, {
      slice: built.slice,
      corrections: (built.job.evidence.corrections ?? []).map((c) => c.text),
      pairFingerprints: new Set(built.job.evidence.pairs.map((p) => p.fingerprint)),
    }) ?? [];
  const measured = parsed.map((i) => withMeasuredRecurrence(i, [], built.job.evidence.recurrence));
  const { kept, dropped } = sieveHarvestItems(measured, {
    existingSkillNames: new Set(existing.map((s) => s.name)),
    muted: new Set<string>(),
    minScore: defaultHarvestConfig.minScore,
    maxPerSession: defaultHarvestConfig.maxPerSession,
  });
  return {
    reached: true,
    items: [
      ...kept.map((item) => ({ item, kept: true })),
      ...dropped.map((d) => ({ item: d.item, kept: false, reason: d.reason })),
    ],
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const runs = Number(argv[argv.indexOf("--runs") + 1] ?? "3") || 3;
  const outDir = join(process.cwd(), "evals", "results", "duplicate-branch");
  mkdirSync(outDir, { recursive: true });

  const isolation = await childIsolationArgs();
  if (isolation.length === 0) {
    console.error("the installed claude CLI cannot isolate the child. Refusing to run.");
    process.exit(2);
  }
  console.log(`sessions : ${COVERING.length}, each with a covering skill under an unrelated name`);
  console.log(`runs     : ${runs}  (${COVERING.length * runs} harvest calls)`);
  for (const c of COVERING) {
    const session = SESSIONS.find((s) => s.id === c.sessionId);
    if (!session) throw new Error(`no session ${c.sessionId}`);
    if (!session.labels.some((l) => l.id === c.labelId)) throw new Error(`no label ${c.labelId}`);
    console.log(`  ${c.labelId.padEnd(28)} covered by "${c.skill.name}"`);
  }
  if (dryRun) {
    console.log("\n--dry-run: nothing spent.");
    return;
  }

  const rows: Row[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const c of COVERING) {
      const session = SESSIONS.find((s) => s.id === c.sessionId)!;
      const label = session.labels.find((l) => l.id === c.labelId)!;
      const { items, reached } = await harvestOnce(session, c.skill);
      let proposed = false;
      let kept = false;
      let stoppedBy: SievedItem["reason"] | null = null;
      let cost = 0;
      for (const entry of items) {
        const verdict = await askGrader(buildSameLessonPrompt(entry.item, label as Label));
        cost += verdict.costUsd ?? 0;
        if (!verdict.yes) continue;
        proposed = true;
        if (entry.kept) kept = true;
        else stoppedBy = entry.reason ?? null;
      }
      rows.push({
        run,
        sessionId: session.id,
        labelId: label.id,
        reached,
        proposed,
        kept,
        stoppedBy,
        itemNames: items.map((i) => `${i.item.name}${i.kept ? "" : ` (dropped: ${i.reason})`}`),
        costUsd: cost,
      });
      console.log(
        `run ${run}  ${label.id.padEnd(28)} ${reached ? "" : "CALL FAILED "}proposed=${proposed}` +
          ` kept=${kept} stoppedBy=${stoppedBy ?? "-"}  items: ${items.map((i) => i.item.name).join(", ") || "(none)"}`,
      );
    }
  }
  const scored = rows.filter((r) => r.reached);
  const proposedN = scored.filter((r) => r.proposed).length;
  const keptN = scored.filter((r) => r.kept).length;
  const dupN = scored.filter((r) => r.stoppedBy === "duplicate").length;
  console.log(`\nthe model proposed the covered lesson anyway : ${proposedN}/${scored.length}`);
  console.log(`it reached the queue                         : ${keptN}/${scored.length}`);
  console.log(`the sieve's duplicate rule stopped it        : ${dupN}/${scored.length}`);
  console.log(`calls that never reached the model           : ${rows.length - scored.length}/${rows.length}`);
  console.log(`grader spend                                 : $${rows.reduce((n, r) => n + r.costUsd, 0).toFixed(3)}`);
  writeFileSync(join(outDir, "duplicate-branch.json"), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`, "utf8");
}

void main();
