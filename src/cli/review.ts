import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveAndDeliver } from "../lib/deliver.js";
import { decideCandidate, formatCandidateList, isSafeSlug, listCandidates } from "../lib/queue.js";
import { handbookHome } from "../lib/session-state.js";
import { candidatesDir } from "../lib/skill-index.js";

function usage(): never {
  console.error("usage: review.js <list|show|approve|reject> [slug]");
  process.exit(2);
}

function main(): void {
  const [cmd = "list", slug] = process.argv.slice(2);
  const home = handbookHome();
  if (cmd === "list") {
    console.log(formatCandidateList(listCandidates(home, "pending")));
    return;
  }
  if (!slug || !isSafeSlug(slug)) usage();
  if (cmd === "show") {
    const dir = join(candidatesDir(home), slug);
    try {
      console.log(readFileSync(join(dir, "SKILL.md"), "utf8"));
      console.log("--- grounded-case.json ---");
      console.log(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    } catch {
      console.error(`error: no candidate named "${slug}"`);
      process.exit(1);
    }
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
  const result = decideCandidate(home, slug, "rejected");
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(`Rejected "${slug}". It will not be delivered; its signal stays in the local ledger.`);
}

main();
