import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mineShapes, type MineOptions } from "../lib/mine.js";
import { runMineCommand } from "../lib/mine-run.js";

// Two programs behind one bundle, told apart by an exact first word.
//
// `list` and `draft` are the product: what /handbook:mine runs, and the only thing a user
// ever sees. Anything else is the measurement harness below, which takes repository paths
// positionally and prints JSON - an invocation that is written down in a measurement record
// and has to keep reproducing those numbers. Routing on an exact word rather than on a
// leading dash keeps both: a repository path is a path, and neither of these is one.
const USER_COMMANDS = new Set(["list", "draft"]);

const USAGE = `usage: node dist/mine.js <repo>... [options]

Mines the repositories' history for recurring workflow shapes and prints them as JSON.
Reads local history only: it never fetches.

  --ref <ref>             ref to walk in every repository (default: origin/master, origin/main, master, main, HEAD)
  --since <date>          only commits after this date, as git --since understands it
  --min-recurrence <n>    units a shape needs; changes nothing else (default 8)
  --min-proposers <n>     alike units it takes to propose a shape (default 5)
  --rare-role-cut <n>     roles touched by fewer units are dropped before clustering (default 5)
  --min-roles <n>         roles a shape needs (default 3)
  --core-share <x>        share of units a role needs to be a core file (default 0.6)
  --similarity <x>        average Jaccard a unit needs to join a cluster (default 0.5)
  --hub-share <x>         a role in more than this share of units is not used to find candidates (default 0.2)
  --containment <x>       share of a shape's core a unit must touch to count as doing it (default 0.8)
  --unit-share <x>        share of a unit's own roles the core must be for it to count (default 0.25, 0 off)
  --dedupe-overlap <x>    two shapes sharing this share of their units are one (default 0.5)
  --variant-overlap <x>   the same, for the pair whose cores nest (default 0.4, 0 off)
  --min-distinct-roles <n> core roles a shape needs that are not files most units touch (default 0, off)
  --limit <n>             shapes to print (default 200)
  --no-renames            turn rename detection off, for blobless clones
  --no-filters            keep the noise, to measure what the filters remove
  --out <file>            write the JSON here instead of to stdout`;

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    console.error(`error: --${name} needs a number, got "${value}"`);
    process.exit(2);
  }
  return parsed;
}

function main(): void {
  if (USER_COMMANDS.has(process.argv[2] ?? "")) {
    // Its own parse, its own usage, its own failures: nothing on this path may fall
    // through to the harness text below, which is written in the miner's vocabulary.
    runMineCommand(process.argv.slice(2)).then(
      (code) => process.exit(code),
      (err) => {
        console.error(`error: ${(err as Error).message}`);
        process.exit(1);
      },
    );
    return;
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        since: { type: "string" },
        "min-recurrence": { type: "string" },
        "min-proposers": { type: "string" },
        "rare-role-cut": { type: "string" },
        "min-roles": { type: "string" },
        "core-share": { type: "string" },
        similarity: { type: "string" },
        "hub-share": { type: "string" },
        containment: { type: "string" },
        "unit-share": { type: "string" },
        "dedupe-overlap": { type: "string" },
        "variant-overlap": { type: "string" },
        "min-distinct-roles": { type: "string" },
        limit: { type: "string" },
        "no-renames": { type: "boolean" },
        "no-filters": { type: "boolean" },
        out: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    console.error(`error: ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const options: MineOptions = {
    ref: values.ref,
    since: values.since,
    minRecurrence: number(values["min-recurrence"], "min-recurrence"),
    minProposers: number(values["min-proposers"], "min-proposers"),
    rareRoleUnits: number(values["rare-role-cut"], "rare-role-cut"),
    minRoles: number(values["min-roles"], "min-roles"),
    coreShare: number(values["core-share"], "core-share"),
    similarity: number(values.similarity, "similarity"),
    hubShare: number(values["hub-share"], "hub-share"),
    containment: number(values.containment, "containment"),
    unitShare: number(values["unit-share"], "unit-share"),
    dedupeOverlap: number(values["dedupe-overlap"], "dedupe-overlap"),
    variantOverlap: number(values["variant-overlap"], "variant-overlap"),
    minDistinctRoles: number(values["min-distinct-roles"], "min-distinct-roles"),
    limit: number(values.limit, "limit"),
    noRenames: values["no-renames"],
    filters: values["no-filters"] ? false : undefined,
  };
  // An option left undefined must fall through to the engine's default rather than override it.
  for (const key of Object.keys(options) as (keyof MineOptions)[]) if (options[key] === undefined) delete options[key];

  const result = mineShapes(positionals, options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) writeFileSync(values.out, json);
  else process.stdout.write(json);
  const { stats } = result;
  for (const { path, reason } of stats.unreadableRepos) console.error(`skipped ${path}: ${reason}`);
  if (stats.repos === 0) {
    console.error("error: none of the given paths could be read");
    process.exit(1);
  }
  console.error(
    `mined ${stats.repos} repositories: ${stats.commits} commits, ${stats.workUnits} work units, ` +
      `${result.shapes.length} shapes in ${(stats.elapsedMs / 1000).toFixed(1)}s`,
  );
}

main();
