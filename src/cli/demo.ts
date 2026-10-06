import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDemo, demoListing, draftDemoWorkflow, isDemoRepo } from "../lib/demo.js";

// The recorded draft sits at the plugin root rather than inside the bundle, as a SKILL.md anyone
// can open and read before trusting the demo, and the test holding it to the format gate reads
// that same file.
const RECORDED = fileURLToPath(new URL("../demo/recorded-draft.md", import.meta.url));

const USAGE = `usage: node dist/demo.js start
       node dist/demo.js recorded <repository>
       node dist/demo.js live <repository>

start builds a scratch repository and lists the work its history repeats; nothing is sent.
recorded drafts the first workflow from a draft that ships with the plugin; nothing is sent.
live drafts it with your own claude CLI, which is one model call.`;

async function main(): Promise<number> {
  const [verb, repo, ...extra] = process.argv.slice(2);
  if (verb === "start" && repo === undefined) {
    console.log(demoListing(createDemo(), process.argv[1]!));
    return 0;
  }
  // The word, not a flag, decides whether a model is called, the same rule /handbook:mine keeps:
  // `recorded` has no way to reach one.
  if ((verb !== "recorded" && verb !== "live") || repo === undefined || extra.length > 0) {
    console.error(USAGE);
    return 2;
  }
  if (!isDemoRepo(repo)) {
    console.error(
      `${repo} is not a repository this demo built, so nothing was drafted from it. ` +
        "Run start for a scratch one, or /handbook:mine to draft from a real repository.",
    );
    return 2;
  }
  if (verb === "live") console.log("Drafting the first workflow: this sends its screened evidence to your claude CLI.");
  const outcome = await draftDemoWorkflow(repo, verb === "recorded" ? async () => readFileSync(RECORDED, "utf8") : undefined);
  if (!outcome.ok) {
    console.error(
      `No draft was kept: ${(outcome.reasons ?? ["the reply could not be used"]).join(", ")}. ` +
        "Nothing was queued, and nothing was written anywhere.",
    );
    return 1;
  }
  console.log(
    `Queued "${outcome.slug}" for review. It is a draft, not a finished skill: it has the file map\n` +
      `the history measured and a skeleton of the steps, and the part the history cannot see is\n` +
      `listed on it for you to fill in.\n\n` +
      `  /handbook:review show ${outcome.slug}\n\n` +
      `Approving it into the project commits it to the scratch repository, never to yours.`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${String(err)}`);
    process.exit(1);
  },
);
