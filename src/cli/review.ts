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
import { handbookHome } from "../lib/session-state.js";
import { candidatesDir } from "../lib/skill-index.js";

function usage(): never {
  console.error("usage: review.js <list|show|approve|reject> [slug] [--never]");
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
  console.log(`candidate: ${slug}  [scope: ${meta?.scope ?? "?"}]  [status: ${meta?.status ?? "?"}]`);
  if (gate) {
    const scores = Object.entries(gate.scores)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
    console.log(`gate:      ${gate.total}/10  (${scores})`);
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

function main(): void {
  const args = process.argv.slice(2);
  const never = args.includes("--never");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [cmd = "list", slug] = positional;
  const home = handbookHome();
  if (cmd === "list") {
    console.log(formatCandidateList(listCandidates(home, "pending")));
    return;
  }
  if (!slug || !isSafeSlug(slug)) usage();
  if (cmd === "show") {
    showCandidate(home, slug);
    return;
  }
  if (cmd !== "approve" && cmd !== "reject") usage();
  if (cmd === "approve") {
    const result = approveAndDeliver(home, slug);
    if (!result.ok) {
      console.error(`error: ${result.error}`);
      process.exit(1);
    }
    if (result.mode === "team") {
      if (result.prUrl) {
        console.log(`Approved "${slug}" and opened a PR to the team skill base: ${result.prUrl}`);
      } else {
        console.log(`Approved "${slug}" and pushed branch ${result.branch} to the team skill base.`);
        if (result.manualUrl) console.log(`Open the PR here: ${result.manualUrl}`);
      }
    } else {
      console.log(`Approved "${slug}" and installed it at ${result.deliveredTo}.`);
    }
    return;
  }
  const result = decideCandidate(home, slug, "rejected", undefined, { mute: never });
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  if (never) {
    console.log(
      `Rejected "${slug}" and muted its fingerprint — this learning will not be suggested again.`,
    );
  } else {
    console.log(
      `Rejected "${slug}". If the same learning recurs it may be suggested again; use "reject ${slug} --never" to silence it permanently.`,
    );
  }
}

main();
