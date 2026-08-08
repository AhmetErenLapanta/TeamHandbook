import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  const result = decideCandidate(home, slug, cmd === "approve" ? "approved" : "rejected");
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(
    cmd === "approve"
      ? `Approved "${slug}". It stays in the queue; delivery (solo/team output) is the next pipeline stage.`
      : `Rejected "${slug}". It will not be delivered; its signal stays in the local ledger.`,
  );
}

main();
