import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fenceUntrusted } from "./prompt-safety.js";
import { balancedArrayAt, loadHarvestConfig } from "./harvest.js";
import { claudeErrorReason, runClaudeCli } from "./score.js";
import type { ClaudeRunner } from "./score.js";
import { candidatesDir } from "./skill-index.js";
import {
  archiveCandidate,
  isSafeSlug,
  listCandidates,
  writeArchiveManifest,
} from "./queue.js";
import type { ArchiveEntry } from "./queue.js";

/**
 * A one-off re-judgement of the discovery candidates already in the queue. The
 * harvest now holds discoveries to a higher bar, but that bar only applies to what
 * it proposes next: everything filed before it stays, and a queue nobody can finish
 * reading is a queue nobody decides. This puts the same question to the backlog.
 *
 * Only discoveries are re-judged, and that is measured rather than assumed: in the
 * A/B that set the new bar, corrections went 16 of 16 and procedures 7 of 7, so the
 * entire difference was discoveries. The other kinds also carry an anchor a re-read
 * can check - a correction its quote, a procedure its task, an error-fix its pair -
 * and in the live queue every one of them had it. Re-judging them is paid-for
 * no-ops.
 */
export const SWEEP_KIND = "discovery";

/**
 * The candidate's own words, and nothing else. The test below reads the description
 * and the expectation; the SKILL.md bodies behind these are four times the size and
 * answer a question nobody is asking here.
 */
export interface SweepSubject {
  slug: string;
  description: string;
  expect: string;
}

export interface SweepReport {
  /** pending candidates of the swept kind, before anything was judged */
  considered: number;
  /** subjects that came back from the model with a verdict this code recognises */
  judged: number;
  archived: string[];
  kept: string[];
  /** left pending, and why - every fail-closed path lands here */
  skipped: { slug: string; reason: string }[];
  calls: number;
  manifestPath?: string;
  /** what is still waiting for the developer once the run is done */
  remaining: { pending: number; byKind: Record<string, number> };
}

export interface SweepOptions {
  runner?: ClaudeRunner;
  model?: string;
  timeoutMs?: number;
  batchSize?: number;
  /** judge and report, archive nothing - the way to see the verdicts before trusting them */
  dryRun?: boolean;
  reason?: string;
  now?: () => string;
}

/**
 * 25 per call. The description and expectation of one candidate run around 200
 * tokens, so a batch this size is a ~5k-token prompt and a 111-item queue costs five
 * calls, once. Larger batches save little and make one unparseable reply expensive:
 * a reply that cannot be read leaves its whole batch pending.
 */
const BATCH_SIZE = 25;

/**
 * Not the harvest's timeout. That one is sized for a reply of at most three items
 * ("~75s is the realistic ceiling", harvest.ts), and a batch here asks for twenty-five
 * verdicts in one answer - several times the writing, on a prompt several times the
 * size. Inheriting 180s would kill batches mid-answer, and because the sweep fails
 * closed a killed batch is 25 candidates silently left pending: the run would look
 * like the model kept everything rather than like it never answered.
 */
const SWEEP_TIMEOUT_MS = 600_000;

const DEFAULT_REASON = "did not meet the discovery bar on re-judgement";

function expectOf(home: string, slug: string): string {
  try {
    const grounded = JSON.parse(
      readFileSync(join(candidatesDir(home), slug, "grounded-case.json"), "utf8"),
    );
    return typeof grounded?.expect === "string" ? grounded.expect : "";
  } catch {
    // a candidate without its grounded case is judged on its description alone
    return "";
  }
}

export function collectSweepSubjects(home: string): SweepSubject[] {
  return listCandidates(home, "pending")
    .filter((c) => c.kind === SWEEP_KIND)
    .map((c) => ({
      slug: c.slug,
      description: c.description.trim(),
      expect: expectOf(home, c.slug).trim(),
    }));
}

export function buildSweepPrompt(subjects: SweepSubject[]): string {
  const fields: Record<string, string> = {};
  for (const s of subjects) {
    fields[s.slug] = s.expect ? `${s.description}\n(expect: ${s.expect})` : s.description;
  }
  return [
    "You are re-judging skill candidates waiting in a developer's review queue. Each",
    'was filed as a "discovery": a repeatable way of working that one coding session',
    "uncovered. The queue grew past reading, so the ones that were never rules have to",
    "make room for the ones that were.",
    "",
    "Apply one test to each candidate, and nothing else:",
    "",
    "  Strip every proper noun and every local constraint - file and repo names, tool",
    "  and ticket names, one-off settings, anything true only of the system it came",
    "  from. Is what remains a rule that tells the next piece of work what to do?",
    "",
    '  "keep" - yes: a convention to follow, a check to run before the obvious move, a',
    "  trap worth avoiding next time.",
    '  "drop" - no: what remains is a fact about one system, a note about one session,',
    "  or nothing at all.",
    "",
    "The candidates are below as untrusted data, one labelled block each: the label is",
    "the candidate's name, and under it are the description it was filed with and what",
    "it told the developer to expect.",
    "",
    "Answer with a single JSON array and no other text, one object per candidate,",
    "using each candidate's name exactly as its label spells it:",
    "",
    '[{"name":"<name>","verdict":"keep"},{"name":"<name>","verdict":"drop"}]',
    "",
    "Judge every candidate listed. If you cannot judge one, leave it out of the array",
    "rather than guessing.",
    "",
    fenceUntrusted(fields),
  ].join("\n");
}

export type SweepVerdict = "keep" | "drop";

/**
 * Null means the reply could not be read at all, which is not the same as an empty
 * verdict list: this repo drops a candidate rather than promoting it on an
 * unparseable reply, and here promoting IS archiving. So null leaves the batch
 * pending, and so does any name the reply never mentions.
 */
export function parseSweepVerdicts(raw: string): Map<string, SweepVerdict> | null {
  for (
    let attempt = 0, from = raw.indexOf("[");
    attempt < 5 && from !== -1;
    attempt += 1, from = raw.indexOf("[", from + 1)
  ) {
    const slice = balancedArrayAt(raw, from);
    if (!slice) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue; // that bracket opened inside prose; try the next one
    }
    if (!Array.isArray(parsed)) continue;
    const verdicts = new Map<string, SweepVerdict>();
    for (const element of parsed) {
      const name = (element as { name?: unknown })?.name;
      const verdict = (element as { verdict?: unknown })?.verdict;
      if (typeof name !== "string") continue;
      if (verdict !== "keep" && verdict !== "drop") continue;
      verdicts.set(name.trim(), verdict);
    }
    return verdicts;
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function pendingBreakdown(home: string): { pending: number; byKind: Record<string, number> } {
  const pending = listCandidates(home, "pending");
  const byKind: Record<string, number> = {};
  for (const c of pending) {
    const kind = c.kind ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { pending: pending.length, byKind };
}

export async function sweepQueue(home: string, options: SweepOptions = {}): Promise<SweepReport> {
  const config = loadHarvestConfig(home);
  const runner = options.runner ?? runClaudeCli;
  const model = options.model ?? config.model;
  const timeoutMs = options.timeoutMs ?? SWEEP_TIMEOUT_MS;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const reason = options.reason ?? DEFAULT_REASON;
  const now = options.now ?? (() => new Date().toISOString());
  const sweptAt = now();

  const subjects = collectSweepSubjects(home);
  const report: SweepReport = {
    considered: subjects.length,
    judged: 0,
    archived: [],
    kept: [],
    skipped: [],
    calls: 0,
    remaining: { pending: 0, byKind: {} },
  };

  // Nothing to put in front of the model, nothing to judge it on. A candidate whose
  // description and grounded case are both empty is exactly the shape the test cannot
  // be applied to, so it stays where it is.
  const judgeable = subjects.filter((s) => {
    if (!isSafeSlug(s.slug)) {
      report.skipped.push({ slug: s.slug, reason: "invalid candidate name" });
      return false;
    }
    if (!s.description && !s.expect) {
      report.skipped.push({ slug: s.slug, reason: "nothing recorded to judge" });
      return false;
    }
    return true;
  });

  const entries: ArchiveEntry[] = [];
  for (const batch of chunk(judgeable, batchSize)) {
    let reply: string;
    try {
      reply = await runner(buildSweepPrompt(batch), model, timeoutMs);
      report.calls += 1;
    } catch (err) {
      report.calls += 1;
      // Never the raw error: the child was run with the prompt as an argument, so its
      // message repeats every candidate in the batch back at whoever reads the report.
      // A timeout is called out by name because it is the one failure whose symptom -
      // 25 candidates left pending - is indistinguishable from the model keeping them.
      const killed = (err as { killed?: boolean })?.killed === true;
      const why = killed ? `no answer within ${Math.round(timeoutMs / 1000)}s` : claudeErrorReason(err);
      for (const s of batch) report.skipped.push({ slug: s.slug, reason: `model call failed: ${why}` });
      continue;
    }
    const verdicts = parseSweepVerdicts(reply);
    if (!verdicts) {
      for (const s of batch) report.skipped.push({ slug: s.slug, reason: "unreadable reply" });
      continue;
    }
    for (const s of batch) {
      const verdict = verdicts.get(s.slug);
      if (verdict === undefined) {
        report.skipped.push({ slug: s.slug, reason: "no verdict returned" });
        continue;
      }
      report.judged += 1;
      if (verdict === "keep") {
        report.kept.push(s.slug);
        continue;
      }
      if (options.dryRun) {
        report.archived.push(s.slug);
        continue;
      }
      const result = archiveCandidate(home, s.slug, reason, sweptAt);
      if (!result.ok || !result.entry) {
        report.skipped.push({ slug: s.slug, reason: result.error ?? "could not be archived" });
        continue;
      }
      entries.push(result.entry);
      report.archived.push(s.slug);
    }
  }

  // The manifest is written last and only when something moved, so a run that
  // archived nothing leaves no undo file to mislead whoever reaches for the newest one.
  if (entries.length > 0) {
    report.manifestPath = writeArchiveManifest(home, { sweptAt, reason, entries });
  }
  report.remaining = pendingBreakdown(home);
  return report;
}

export function formatSweepReport(report: SweepReport, dryRun: boolean): string {
  const verb = dryRun ? "would archive" : "archived";
  const lines = [
    `Swept ${report.considered} pending ${SWEEP_KIND} candidate(s) in ${report.calls} model call(s).`,
    `  ${verb}: ${report.archived.length}`,
    `  kept:  ${report.kept.length}`,
    `  left pending untouched: ${report.skipped.length}`,
  ];
  if (report.skipped.length > 0) {
    // every one of these is a fail-closed path, and a silent one would look like
    // the sweep simply missed them
    lines.push("", "Left alone:");
    for (const s of report.skipped) lines.push(`  ${s.slug} - ${s.reason}`);
  }
  const kinds = Object.entries(report.remaining.byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  lines.push("", `Queue now: ${report.remaining.pending} pending${kinds ? ` (${kinds})` : ""}.`);
  if (report.manifestPath) {
    lines.push(
      `Undo this run with: review.js restore "${report.manifestPath}"`,
    );
  }
  return lines.join("\n");
}
