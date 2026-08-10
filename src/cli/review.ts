import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveAndDeliver } from "../lib/deliver.js";
import {
  decideCandidate,
  formatCandidateList,
  isSafeSlug,
  listCandidates,
  readCandidateMeta,
} from "../lib/queue.js";
import { loadScoreConfig } from "../lib/score.js";
import { pendingBatchCount } from "../lib/notify.js";
import { lastPipelineRun } from "../lib/status.js";
import { handbookHome } from "../lib/session-state.js";
import { candidatesDir } from "../lib/skill-index.js";

function usage(): never {
  console.error("usage: review.js <list|show <slug>|approve <slug...>|reject <slug...>> [--all] [--never]");
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
  const threshold = loadScoreConfig(home).threshold;
  console.log(`candidate: ${slug}  [scope: ${meta?.scope ?? "?"}]  [status: ${meta?.status ?? "?"}]`);
  console.log(`location:  ${dir}`);
  if (gate) {
    const scores = Object.entries(gate.scores)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const dissent = gate.total < threshold ? `  — below the ${threshold}/10 threshold` : "";
    console.log(`gate:      ${gate.total}/10  (${scores})${dissent}`);
    if (gate.rationale) console.log(`rationale: ${gate.rationale}`);
  } else {
    console.log("gate:      n/a");
  }
  console.log("");
  console.log(skillMd.trimEnd());
  console.log("");
  console.log("── grounded case ──");
  try {
    const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    if (grounded.task) {
      console.log(`goal:      ${grounded.task.goal}`);
      (grounded.task.steps ?? []).forEach((s: string, i: number) => console.log(`  step ${i + 1}:  ${s}`));
      if (grounded.task.verification) console.log(`verified:  ${grounded.task.verification}`);
    } else {
      console.log(`failed:    ${grounded.command}`);
      console.log(`error:     ${String(grounded.error ?? "").split("\n").join("\n           ")}`);
      if (grounded.resolvedCommand) console.log(`resolved:  ${grounded.resolvedCommand}`);
      if (Array.isArray(grounded.edits) && grounded.edits.length) {
        console.log(`edits:     ${grounded.edits.join(", ")}`);
      }
    }
    if (grounded.expect) console.log(`expect:    ${grounded.expect}`);
  } catch {
    console.log("(this candidate has no grounded case)");
  }
}

function approveOne(home: string, slug: string): void {
  const result = approveAndDeliver(home, slug);
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (result.mode === "team") {
    if (result.prUrl) {
      console.log(`Approved "${slug}" and opened a PR to the team skill base: ${result.prUrl}`);
    } else {
      console.log(`Approved "${slug}" and pushed branch ${result.branch} to the team skill base.`);
      if (result.prError) console.log(`Auto-PR skipped (${result.prError}) — install/authenticate gh or glab to open PRs automatically.`);
      if (result.manualUrl) console.log(`Open the PR here: ${result.manualUrl}`);
    }
  } else {
    if (result.warning) console.log(`Note: ${result.warning}`);
    const loads = result.originProject
      ? `Claude will load it in ${result.originProject} (where it was captured) next session`
      : "Claude will load it next session";
    console.log(
      `Approved "${slug}" and installed it at ${result.deliveredTo}. ` +
        `${loads}. Commit this directory so the skill travels with the repo.`,
    );
  }
}

function rejectOne(home: string, slug: string, never: boolean): void {
  const result = decideCandidate(home, slug, "rejected", undefined, { mute: never });
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (never && result.muted) {
    console.log(`Rejected "${slug}" and muted its fingerprint — this learning will not be suggested again.`);
  } else if (never) {
    console.log(`Rejected "${slug}", but it has no recorded fingerprint, so it could not be muted.`);
  } else {
    console.log(
      `Rejected "${slug}". If the same learning recurs it may be suggested again; use "reject ${slug} --never" to silence it permanently.`,
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const never = args.includes("--never");
  const all = args.includes("--all");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [cmd = "list", ...slugArgs] = positional;
  const home = handbookHome();
  if (cmd === "list") {
    const pending = listCandidates(home, "pending");
    console.log(formatCandidateList(pending));
    if (pending.length === 0) {
      const scoring = pendingBatchCount(home);
      if (scoring > 0) {
        console.log(`(${scoring} captured pair(s) are still being scored in the background — try again in a minute.)`);
      } else {
        // An empty queue after a productive day usually means the gate scored and
        // rejected — say so, so the review screen is a signal of life, not a dead end.
        const reject = lastPipelineRun(home)?.outcomes?.filter((o) => o.outcome === "reject").at(-1);
        if (reject) {
          const score = reject.total !== undefined ? `${reject.total}/10` : "n/a";
          const why = reject.duplicateOf ? `duplicate of "${reject.duplicateOf}"` : reject.rationale ?? "below the bar";
          console.log(
            `(The most recent capture was scored but didn't clear the gate: ${score} — ${why}. Nothing is waiting for you.)`,
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
  for (const slug of slugs) {
    if (cmd === "approve") approveOne(home, slug);
    else rejectOne(home, slug, never);
  }
}

main();
