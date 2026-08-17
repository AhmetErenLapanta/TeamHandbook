import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveAndDeliver } from "../lib/deliver.js";
import type { DeliveryTarget } from "../lib/deliver.js";
import {
  decideCandidate,
  formatCandidateList,
  isSafeSlug,
  listCandidates,
  readCandidateMeta,
} from "../lib/queue.js";
import { loadScoreConfig } from "../lib/score.js";
import { loadHarvestConfig } from "../lib/harvest.js";
import { pendingHarvestCount } from "../lib/notify.js";
import { lastPipelineRun } from "../lib/status.js";
import { handbookHome } from "../lib/session-state.js";
import { candidatesDir } from "../lib/skill-index.js";

function usage(): never {
  console.error(
    "usage: review.js <list|show <slug>|approve <slug...>|reject <slug...>> [--all] [--never] [--to personal|project|team]",
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
  console.log(`location:  ${dir}`);
  if (gate) {
    const scores = Object.entries(gate.scores)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    const dissent = gate.total < threshold ? `  — below the ${threshold}/10 bar` : "";
    console.log(`score:     ${gate.total}/10  (${scores})${dissent}`);
    if (gate.rationale) console.log(`rationale: ${gate.rationale}`);
  } else {
    console.log("score:     n/a");
  }
  if (meta?.suggestedTarget) {
    const where =
      meta.suggestedTarget === "personal"
        ? "keep for yourself (~/.claude/skills)"
        : meta.suggestedTarget === "project"
          ? "this project's .claude/skills"
          : "share with the team (PR)";
    console.log(`suggested: ${where}`);
  }
  // Repetition is the strongest argument for keeping a lesson and the one the user
  // can confirm from memory — so it sits with the score, not inside the quote block
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
    // A correction's receipt is the user's own sentence — show it first and
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
      console.log("(no command/error recorded — this skill came from the conversation)");
    }
    if (grounded.expect) console.log(`expect:    ${grounded.expect}`);
  } catch {
    console.log("(this candidate has no grounded case)");
  }
}

function approveOne(home: string, slug: string, to?: DeliveryTarget): void {
  const result = approveAndDeliver(home, slug, undefined, undefined, undefined, undefined, undefined, to);
  if (!result.ok) {
    console.error(`error (${slug}): ${result.error}`);
    return;
  }
  if (result.mode === "team") {
    // What the reader needs is not "it worked" but what is now true and what is left for
    // them: a request exists, it carries the version teammates update to, and nothing
    // reaches anyone until a human merges it.
    const bump = result.version ? ` It also raises the handbook to v${result.version}, which is what makes teammates' copies refresh.` : "";
    if (result.prUrl) {
      console.log(`Shared "${slug}" with the team: ${result.prUrl}`);
      console.log(`Merge that request and every teammate gets it at their next session.${bump}`);
    } else {
      console.log(`Shared "${slug}" with the team on branch ${result.branch}.${bump}`);
      if (result.prError) console.log(`It could not open the request for you (${result.prError}) — install and sign in to gh or glab and it will next time.`);
      if (result.manualUrl) console.log(`Open it here, then merge: ${result.manualUrl}`);
    }
  } else if (result.mode === "personal") {
    console.log(
      `Kept "${slug}" for you at ${result.deliveredTo}. ` +
        `Claude will load it in every project from your next session.`,
    );
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
  // Accept both `--to personal` and `--to=personal`. Silently ignoring the `=`
  // spelling would fall back to the candidate's suggested target — which is often
  // "team" — so "keep this to myself" could publish to the team instead.
  const inlineTo = args.find((a) => a.startsWith("--to="));
  const toIndex = args.indexOf("--to");
  const toRaw = inlineTo ? inlineTo.slice("--to=".length) : toIndex !== -1 ? args[toIndex + 1] : undefined;
  const to =
    toRaw === "personal" || toRaw === "project" || toRaw === "team" ? (toRaw as DeliveryTarget) : undefined;
  if ((toIndex !== -1 || inlineTo) && !to) usage();
  const positional = args.filter((a, i) => !a.startsWith("--") && (toIndex === -1 || i !== toIndex + 1));
  const [cmd = "list", ...slugArgs] = positional;
  const home = handbookHome();
  if (cmd === "list") {
    const pending = listCandidates(home, "pending");
    console.log(formatCandidateList(pending));
    if (pending.length === 0) {
      const scoring = pendingHarvestCount(home);
      if (scoring > 0) {
        console.log(`(${scoring} session(s) are still being harvested in the background — try again in a minute.)`);
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
    if (cmd === "approve") approveOne(home, slug, to);
    else rejectOne(home, slug, never);
  }
}

main();
