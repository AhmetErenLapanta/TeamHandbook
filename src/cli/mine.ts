import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { mineShapes, type MineOptions } from "../lib/mine.js";

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
  --dedupe-overlap <x>    two shapes sharing this share of their units are one (default 0.5)
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
        "dedupe-overlap": { type: "string" },
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
    dedupeOverlap: number(values["dedupe-overlap"], "dedupe-overlap"),
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
