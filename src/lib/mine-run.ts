import { parseArgs } from "node:util";
import { collectUnits, shapesFromUnits } from "./mine.js";
import type { MineOptions, Shape } from "./mine.js";
import { variantFamilies } from "./draft.js";
import { saveMinedRecord, sessionDetectEnabled } from "./session-workflow.js";
import {
  DEFAULT_LIST_SIZE,
  draftWorkflow,
  formatWorkflowList,
  draftRefusal,
  loadMineConfig,
  pickWorkflow,
  unitIndexFor,
  workflowsFromShapes,
} from "./mine-command.js";

const USAGE = `usage: /handbook:mine [--repo <path>]... [--limit <n>]
       /handbook:mine draft <n|id> [--repo <path>]...

Reads the git history of this repository, and of any others you name, and lists the work
that repeats in it. Listing reads history only: nothing is sent anywhere.

  --repo <path>   another repository to read as well as this one
  --limit <n>     how many to list (default ${DEFAULT_LIST_SIZE})
  draft <n|id>    write a draft skill for the work listed at that number

A number only means something against the list it was read from, so pass the SAME --repo
arguments to draft that you passed to the listing. The id shown for a workflow is stable
whatever the arguments are.`;

export interface MineRunDeps {
  cwd?: string;
  home?: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Injected by the tests, so listing can be proven to call nothing. */
  run?: (prompt: string) => Promise<string>;
  now?: () => string;
  /**
   * The engine's thresholds. The product ships the defaults these were measured at; a test
   * fixture holds a few dozen commits where a real history holds thousands, so a test says
   * what it is reading rather than being handed a history big enough for the defaults.
   */
  options?: MineOptions;
}

/** The `--repo` arguments a list was produced with, so the draft line can repeat them. */
export function repoArgs(named: string[]): string {
  return named.map((r) => ` --repo ${r}`).join("");
}

/** Repositories to read: the one the command was run in, plus the configured and named ones. */
export function repoPaths(cwd: string, named: string[], configured: string[]): string[] {
  return [...new Set([cwd, ...configured, ...named])];
}

export async function runMineCommand(argv: string[], deps: MineRunDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fail = deps.error ?? ((line: string) => console.error(line));
  const cwd = deps.cwd ?? process.cwd();

  // The word decides whether a model call can happen at all, so it is the word and not a flag
  // that carries the choice: `list` has no way to be handed a draft, and `draft` has nothing
  // to do without the one workflow it names.
  const [verb, ...rest] = argv;
  if (verb !== "list" && verb !== "draft") {
    fail(USAGE);
    return 2;
  }
  let values: { repo?: string[]; limit?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: verb === "draft",
      options: {
        repo: { type: "string", multiple: true },
        limit: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    log(USAGE);
    return 0;
  }
  if (verb === "draft" && positionals.length !== 1) {
    fail(`draft takes the number or the id of one workflow from the list.\n\n${USAGE}`);
    return 2;
  }

  const limit = values.limit === undefined ? DEFAULT_LIST_SIZE : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    fail(`--limit needs a whole number of workflows to show, and was given "${values.limit}".`);
    return 2;
  }
  const paths = repoPaths(cwd, values.repo ?? [], loadMineConfig(deps.home).repos);

  // One read of the histories for both halves of the command, so a draft is written from
  // exactly the units the list ranked rather than from a second read that may differ.
  const options: MineOptions = deps.options ?? {};
  const collection = collectUnits(paths, options);
  const mined = shapesFromUnits(collection, options);
  if (sessionDetectEnabled(deps.home)) {
    try {
      saveMinedRecord(paths, collection, mined.shapes, deps.home);
    } catch {
      // the record only names later sessions; failing to keep it must not cost the listing
    }
  }
  const families = variantFamilies(mined.shapes);
  // The draft resolves against a list at least as long as the number asked for, so a choice
  // made from `--limit 10` still resolves when the draft call does not repeat the limit.
  const asked = verb === "draft" ? positionals[0] : undefined;
  const reach = asked !== undefined && /^\d+$/.test(asked) ? Math.max(limit, Number(asked)) : limit;
  const workflows = workflowsFromShapes(mined.shapes, asked === undefined ? limit : reach);

  if (asked === undefined) {
    log(formatWorkflowList(workflows, mined.stats.repos, limit, repoArgs(values.repo ?? [])));
    return 0;
  }

  const workflow = pickWorkflow(workflows, asked);
  const refusal = draftRefusal(workflows, workflow, asked);
  if (refusal || !workflow) {
    fail(refusal ?? "There is nothing to draft.");
    return 2;
  }
  const chosen = workflow.rank;
  const shape = shapeFor(families, workflow.id);
  if (!shape) {
    fail(`The work listed at ${chosen} could not be read back from the history. Nothing was sent.`);
    return 1;
  }

  log(`Drafting ${chosen}: this sends the screened evidence for this workflow to the model.`);
  const outcome = await draftWorkflow(
    workflow,
    unitIndexFor(paths, options),
    shape,
    deps.run,
    deps.home,
    deps.now,
    cwd,
  );
  if (!outcome.ok) {
    fail(
      `No draft was kept for ${chosen}: ${(outcome.reasons ?? ["the reply could not be used"]).join(", ")}. ` +
        `Nothing was queued, and nothing was written anywhere.`,
    );
    return 1;
  }
  log(
    `Queued "${outcome.slug}" for review. It is a draft, not a finished skill: it has the file map\n` +
      `the history measured and a skeleton of the steps, and the part the history cannot see is\n` +
      `listed on it for you to fill in.\n\n` +
      `  /handbook:review show ${outcome.slug}\n\n` +
      `Nothing is installed or committed until you approve it there.`,
  );
  return 0;
}

function shapeFor(families: { head: Shape; variants: Shape[] }[], id: string): Shape | undefined {
  for (const family of families) {
    if (family.head.id === id) return family.head;
    const variant = family.variants.find((s) => s.id === id);
    if (variant) return variant;
  }
  return undefined;
}
