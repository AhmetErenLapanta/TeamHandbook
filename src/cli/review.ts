import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveAndDeliver, formatApproveResult, projectTargetLabel } from "../lib/deliver.js";
import type { DeliveryOptions, DeliveryTarget } from "../lib/deliver.js";
import {
  decideCandidate,
  formatCandidateList,
  isSafeSlug,
  listArchiveManifests,
  listCandidates,
  readArchiveManifest,
  readCandidateMeta,
  restoreArchived,
} from "../lib/queue.js";
import { formatSweepReport, sweepQueue } from "../lib/sweep.js";
import { loadScoreConfig } from "../lib/score.js";
import { loadHarvestConfig } from "../lib/harvest.js";
import { pendingHarvestCount } from "../lib/notify.js";
import { lastPipelineRun } from "../lib/status.js";
import { handbookHome } from "../lib/session-state.js";
import { candidatesDir } from "../lib/skill-index.js";
import { displayPath } from "../lib/display-path.js";

function usage(): never {
  console.error(
    "usage: review.js <list|show <slug>|approve <slug...>|reject <slug...>|sweep|restore [manifest]> " +
      "[--all] [--never] [--archived] [--dry-run] [--to personal|project|team] [--update] [--as <name>]",
  );
  process.exit(2);
}

function showCandidate(home: string, slug: string): void {
  const dir = join(candidatesDir(home), slug);
  let skillMd: string;
  try {
    skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    console.error(`error: no candidate named "${slug}"`);
    process.exit(1);
  }
  const meta = readCandidateMeta(dir);
  const gate = meta?.gate;
  // A harvested lesson is measured against the harvest floor it already cleared;
  // only a /handbook:learn capture is measured against the learn threshold.
  const threshold =
    meta?.origin === "harvest" ? loadHarvestConfig(home).minScore : loadScoreConfig(home).threshold;
  const kind = meta?.kind ? `  [${meta.kind}]` : "";
  console.log(`candidate: ${slug}${kind}  [scope: ${meta?.scope ?? "?"}]  [status: ${meta?.status ?? "?"}]`);
  console.log(`location:  ${displayPath(dir)}`);
  if (gate) {
    const scores = Object.entries(gate.scores)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const dissent = gate.total < threshold ? `  - below the ${threshold}/10 bar` : "";
    console.log(`score:     ${gate.total}/10  (${scores})${dissent}`);
    if (gate.rationale) console.log(`rationale: ${gate.rationale}`);
  } else {
    console.log("score:     n/a");
  }
  // "Add it to a project" is offered for every candidate, whatever we suggest, and it
  // installs where the candidate was captured - which is not always the project the
  // reviewer is in. The dialog is built from this output, so the destination is printed
  // for all of them; only the suggestion below, when it already names it, makes this
  // line a repeat. It reads the cwd approveAndDeliver itself falls back to, so the
  // destination shown here is the one the copy will use.
  if (meta && meta.suggestedTarget !== "project") {
    console.log(`project:   ${projectTargetLabel(meta, process.cwd())}`);
  }
  if (meta?.suggestedTarget) {
    const where =
      meta.suggestedTarget === "personal"
        ? "keep for yourself (~/.claude/skills)"
        : meta.suggestedTarget === "project"
          ? projectTargetLabel(meta, process.cwd())
          : "share with the team (PR)";
    console.log(`suggested: ${where}`);
  }
  // Repetition is the strongest argument for keeping a lesson and the one the user
  // can confirm from memory - so it sits with the score, not inside the quote block
  // that only corrections have.
  if (meta?.taughtBefore) {
    console.log(`repeated:  you have told Claude this in ${meta.taughtBefore + 1} sessions`);
  }
  console.log("");
  console.log(skillMd.trimEnd());
  console.log("");
  console.log("── grounded case ──");
  try {
    const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    // A correction's receipt is the user's own sentence - show it first and
    // verbatim; it is the strongest evidence any candidate can carry.
    if (grounded.quote) {
      console.log(`you said:  "${grounded.quote}"`);
    }
    if (grounded.task) {
      console.log(`goal:      ${grounded.task.goal}`);
      (grounded.task.steps ?? []).forEach((s: string, i: number) => console.log(`  step ${i + 1}:  ${s}`));
      if (grounded.task.verification) console.log(`verified:  ${grounded.task.verification}`);
    } else if (grounded.command || grounded.error) {
      console.log(`failed:    ${grounded.command}`);
      console.log(`error:     ${String(grounded.error ?? "").split("\n").join("\n           ")}`);
      if (grounded.resolvedCommand) console.log(`resolved:  ${grounded.resolvedCommand}`);
      if (Array.isArray(grounded.edits) && grounded.edits.length) {
        console.log(`edits:     ${grounded.edits.join(", ")}`);
      }
    } else if (!grounded.quote) {
      console.log("(no command/error recorded - this skill came from the conversation)");
    }
    if (grounded.expect) console.log(`expect:    ${grounded.expect}`);
  } catch {
    console.log("(this candidate has no grounded case)");
  }
}

function approveOne(home: string, slug: string, to?: DeliveryTarget, options: DeliveryOptions = {}): void {
  const result = approveAndDeliver(
    home,
    slug,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    to,
    undefined,
    options,
  );
  if (!result.ok) {
    // A collision is the product asking a question, not the product breaking, and the two
    // read differently to whoever is relaying this. Both are failures for the exit code,
    // because in both cases nothing was delivered and the candidate is still waiting.
    console.error(
      result.collision
        ? `not delivered (${slug}): ${result.error}`
        : `error (${slug}): ${result.error}`,
    );
    // v0.7.0 exited 0 here, so anything reading the exit code called a refusal a success.
    // That was survivable while a refusal meant "nothing happened"; it is not now that a
    // refusal is a decision point the user has to be brought back to.
    process.exitCode = 1;
    return;
  }
  console.log(formatApproveResult(slug, result));
}

function rejectOne(home: string, slug: string, never: boolean): void {
  const result = decideCandidate(home, slug, "rejected", undefined, { mute: never });
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (never && result.muted) {
    console.log(`Rejected "${slug}" and muted its fingerprint - this learning will not be suggested again.`);
  } else if (never) {
    console.log(`Rejected "${slug}", but it has no recorded fingerprint, so it could not be muted.`);
  } else {
    console.log(
      `Rejected "${slug}". If the same learning recurs it may be suggested again; use "reject ${slug} --never" to silence it permanently.`,
    );
  }
}

/**
 * The archive, shown only when asked for. The default list stays the pending queue:
 * an archived candidate is one the developer chose not to be shown, and putting it
 * back on the review screen would undo the only thing archiving does.
 */
function listArchived(home: string): void {
  console.log(formatCandidateList(listCandidates(home, "archived"), Date.now(), "Archived"));
}

async function sweep(home: string, dryRun: boolean): Promise<void> {
  const report = await sweepQueue(home, { dryRun });
  console.log(formatSweepReport(report, dryRun));
}

function restore(home: string, file?: string): void {
  // no argument means the most recent run, which is what "undo that sweep" means to
  // anyone who just ran one
  const target = file ?? listArchiveManifests(home).at(-1);
  if (!target) {
    console.error("error: no archive manifest to restore from");
    process.exit(1);
  }
  const manifest = readArchiveManifest(target);
  if (!manifest) {
    // The one path here that is NOT shortened: this is the string the user retries the
    // command with, and readArchiveManifest opens it with readFileSync, which does not
    // expand "~" any more than a shell does inside the quotes it would be pasted in.
    console.error(`error: "${target}" is not a readable archive manifest`);
    process.exit(1);
  }
  const result = restoreArchived(home, manifest);
  console.log(`Restored ${result.restored.length} candidate(s) from ${displayPath(target)}.`);
  for (const s of result.skipped) console.log(`  skipped ${s.slug} - ${s.reason}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const never = args.includes("--never");
  const all = args.includes("--all");
  const archived = args.includes("--archived");
  const dryRun = args.includes("--dry-run");
  // Accept both `--to personal` and `--to=personal`. Silently ignoring the `=`
  // spelling would fall back to the candidate's suggested target - which is often
  // "team" - so "keep this to myself" could publish to the team instead. Written once
  // for every flag that takes a value, because --as arrived with the same trap and the
  // index bookkeeping below is what stops its value being read as a slug.
  const consumed = new Set<number>();
  const valueOf = (flag: string): string | undefined => {
    const inline = args.find((a) => a.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const at = args.indexOf(flag);
    if (at === -1) return undefined;
    consumed.add(at + 1);
    return args[at + 1];
  };
  const given = (flag: string): boolean => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  const toRaw = valueOf("--to");
  const to =
    toRaw === "personal" || toRaw === "project" || toRaw === "team" ? (toRaw as DeliveryTarget) : undefined;
  if (given("--to") && !to) usage();
  const as = valueOf("--as");
  if (given("--as") && (!as || !isSafeSlug(as))) usage();
  // `--update` takes no value. Accepting `--update=true` as true would mean accepting
  // `--update=false` as true as well, so the spelling is refused out loud instead: silently
  // ignoring it is what made "overwrite it" read as "give it a suffix".
  if (args.some((a) => a.startsWith("--update="))) usage();
  const update = args.includes("--update");
  const positional = args.filter((a, i) => !a.startsWith("--") && !consumed.has(i));
  const [cmd = "list", ...slugArgs] = positional;
  const home = handbookHome();
  if (cmd === "sweep") {
    await sweep(home, dryRun);
    return;
  }
  if (cmd === "restore") {
    restore(home, slugArgs[0]);
    return;
  }
  if (cmd === "list") {
    if (archived) {
      listArchived(home);
      return;
    }
    const pending = listCandidates(home, "pending");
    console.log(formatCandidateList(pending));
    if (pending.length === 0) {
      const scoring = pendingHarvestCount(home);
      if (scoring > 0) {
        console.log(`(${scoring} session(s) are still being harvested in the background - try again in a minute.)`);
      } else {
        // An empty queue after a productive day usually means the gate scored and
        // rejected - say so, so the review screen is a signal of life, not a dead end.
        const reject = lastPipelineRun(home)?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
        if (reject) {
          const score = reject.total !== undefined ? `${reject.total}/10` : "n/a";
          const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "below the bar";
          console.log(
            `(The most recent capture was scored but didn't clear the gate: ${score} - ${why}. Nothing is waiting for you.)`,
          );
        }
      }
    }
    return;
  }
  if (cmd !== "approve" && cmd !== "reject") {
    // single-slug commands
    if (cmd === "show" && slugArgs[0] && isSafeSlug(slugArgs[0])) {
      showCandidate(home, slugArgs[0]);
      return;
    }
    usage();
  }
  // approve/reject accept one or more slugs, or --all for every pending candidate
  const slugs = all ? listCandidates(home, "pending").map((c) => c.slug) : slugArgs;
  if (slugs.length === 0 || slugs.some((s) => !isSafeSlug(s))) usage();
  // Both flags are answers to a refusal about ONE name, so neither may be spread over a
  // batch. A new name would install the last candidate over the ones before it, and
  // `--all --update` would overwrite every colliding skill the team has on a single word -
  // which is the consent model of this whole command turned inside out.
  if ((as || update) && slugs.length > 1) usage();
  const options = { ...(update ? { update } : {}), ...(as ? { as } : {}) };
  for (const slug of slugs) {
    if (cmd === "approve") approveOne(home, slug, to, options);
    else rejectOne(home, slug, never);
  }
}

// no explicit exit: stdout to a pipe flushes asynchronously, and exiting on the
// promise would truncate a long `list` or `show`
main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
