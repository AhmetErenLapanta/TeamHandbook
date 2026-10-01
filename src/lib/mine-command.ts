import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEvidence, draftSkill, readUnitIndex, variantFamilies } from "./draft.js";
import type { DraftRunner, UnitIndex } from "./draft.js";
import { mineShapes } from "./mine.js";
import type { MineOptions, Shape } from "./mine.js";
import { uniqueSlug } from "./distill.js";
import { hostIdentity } from "./identity.js";
import { readConfigFile } from "./config.js";
import { handbookHome } from "./session-state.js";
import { candidatesDir, parseSkillFrontmatter } from "./skill-index.js";
import { identityInSkillDir, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";

/**
 * What one repeating piece of work looks like on screen.
 *
 * Deliberately not the miner's own record: every field here is one a reader can check
 * against their own memory of the work. The miner's vocabulary - how a cluster was found,
 * which thresholds it cleared - answers a question nobody at this screen is asking, and
 * naming it would invite the reader to tune it instead of recognising the work.
 */
export interface Workflow {
  /** Its place in the list, which is what `draft <n>` names. */
  rank: number;
  id: string;
  /** The files it always touches, most consistent first. */
  files: { role: string; units: number; of: number; examples: string[] }[];
  jobs: number;
  repos: number;
  people: number;
  lastAt: string;
  /** Set when this is the same work as an earlier entry, found again at a different size. */
  sameAs?: number;
}

/**
 * What one draft costs, rounded to the nearest five cents.
 *
 * Measured on real drafts at one model, and it is an ESTIMATE on the screen because the
 * price moves with how much history a workflow has. It is shown before the choice rather
 * than after, because the choice is what spends it.
 */
export const ESTIMATED_DRAFT_COST = 0.1;

export interface MineConfig {
  /** Repositories to read besides the one the command was run in. */
  repos: string[];
}

export function loadMineConfig(home: string = handbookHome()): MineConfig {
  const mine = readConfigFile(home).mine as Record<string, unknown> | undefined;
  const repos = Array.isArray(mine?.repos) ? mine.repos.filter((r): r is string => typeof r === "string") : [];
  return { repos };
}

/** How many workflows the list shows unless asked for more. */
export const DEFAULT_LIST_SIZE = 5;

/**
 * Read the repositories and rank what repeats in them. No model call, no network.
 *
 * The variant grouping runs here rather than at drafting time so that the reader is told
 * which entries are the same work BEFORE they pick one, rather than being charged for a
 * second draft of something they already have.
 */
export function listWorkflows(
  repoPaths: string[],
  options: MineOptions & { limit?: number } = {},
): { workflows: Workflow[]; repos: number; commits: number } {
  const result = mineShapes(repoPaths, options);
  return {
    workflows: workflowsFromShapes(result.shapes, options.limit ?? DEFAULT_LIST_SIZE),
    repos: result.stats.repos,
    commits: result.stats.commits,
  };
}

/**
 * The same mapping, from shapes already mined.
 *
 * The command reads each history once and ranks from that one read: mining a second time to
 * list and a third to draft costs a minute per repository and can disagree with itself if a
 * commit lands in between.
 */
export function workflowsFromShapes(shapes: Shape[], limit = DEFAULT_LIST_SIZE): Workflow[] {
  const families = variantFamilies(shapes);
  const workflows: Workflow[] = [];
  const rankOfHead = new Map<string, number>();
  for (const family of families) {
    if (workflows.length >= limit) break;
    const rank = workflows.length + 1;
    rankOfHead.set(family.head.id, rank);
    workflows.push(describe(family.head, rank));
    for (const variant of family.variants) {
      if (workflows.length >= limit) break;
      workflows.push({ ...describe(variant, workflows.length + 1), sameAs: rank });
    }
  }
  return workflows;
}

function describe(shape: Shape, rank: number): Workflow {
  return {
    rank,
    id: shape.id,
    files: shape.coreFiles.map((file) => ({
      role: file.role,
      units: file.units,
      of: shape.recurrence,
      examples: file.examples,
    })),
    jobs: shape.recurrence,
    repos: shape.coreRepos.length,
    people: shape.authors,
    lastAt: shape.lastAt,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The screen a reader meets, in their terms.
 *
 * The counts are here because the question this list answers is "do I recognise this?",
 * and a reader recognises work by how often it happened and who did it. The cost line
 * sits at the bottom, next to the only action that spends anything.
 */
/**
 * Why a chosen number cannot be drafted, or null when it can.
 *
 * Pure, and here rather than in the command, because it is the rule that decides whether a
 * model call happens. A number means nothing without the list it was read from: the same
 * `1` is a different workflow once a sibling repository is added, so the caller must resolve
 * against the SAME list it showed.
 */
export function draftRefusal(workflows: Workflow[], chosen: Workflow | undefined, asked: string): string | null {
  if (!chosen) {
    return (
      `There is no workflow ${/^\d+$/.test(asked) ? `numbered ${asked}` : `"${asked}"`} in the list. ` +
      "Run /handbook:mine with the same repositories to see the numbers again."
    );
  }
  if (chosen.sameAs !== undefined) {
    return (
      `Number ${chosen.rank} is the same work as number ${chosen.sameAs}, found again at a different ` +
      `size, so drafting it would write the same skill twice. Draft ${chosen.sameAs} instead.`
    );
  }
  return workflows.length === 0 ? "There is nothing to draft." : null;
}

/** The entry a choice names: its place in the list, or its id. */
export function pickWorkflow(workflows: Workflow[], asked: string): Workflow | undefined {
  const byRank = workflows.find((w) => String(w.rank) === asked);
  return byRank ?? workflows.find((w) => w.id === asked);
}

export function formatWorkflowList(
  workflows: Workflow[],
  repos: number,
  listSize = DEFAULT_LIST_SIZE,
  /**
   * The arguments this list was produced with, repeated on the draft line.
   *
   * Load-bearing rather than cosmetic: a number is only meaningful against the list it was
   * read from, and `draft 1` run without the sibling repositories resolves to a DIFFERENT
   * workflow - measured on the fixture, `#1` of two repositories and `#1` of one are not the
   * same id. Printing the arguments back is what keeps the pick the user made the pick the
   * model is asked about.
   */
  repoArgs = "",
): string {
  if (workflows.length === 0) {
    return [
      "No repeating work found in this history.",
      "",
      "That is an answer, not a failure: it takes several jobs that touched the same files",
      "before the same work can be recognised twice. A younger repository, or one whose",
      "commits each touch something different, will say this.",
    ].join("\n");
  }
  const lines = [
    `Repeating work found in ${plural(repos, "repository", "repositories")}, most established first:`,
    "",
  ];
  for (const flow of workflows) {
    const headline = flow.files
      .slice(0, 3)
      .map((f) => f.role)
      .join(" + ");
    lines.push(`  ${flow.rank}. ${headline}`);
    if (flow.sameAs !== undefined) {
      lines.push(`     the same work as ${flow.sameAs}, found again at a different size`);
    }
    lines.push(
      `     done ${plural(flow.jobs, "time", "times")}, in ${plural(flow.repos, "repository", "repositories")}, ` +
        `by ${plural(flow.people, "person", "people")} · last ${flow.lastAt.slice(0, 10)}`,
    );
    lines.push("     files it touches:");
    const width = Math.max(...flow.files.map((f) => f.role.length));
    for (const file of flow.files) {
      const example = file.examples[0] ? `  e.g. ${file.examples[0]}` : "";
      lines.push(`       ${file.role.padEnd(width)}  ${file.units} of ${file.of}${example}`);
    }
    lines.push("");
  }
  const drafted = workflows.filter((f) => f.sameAs === undefined).length;
  lines.push(
    `Nothing has been sent anywhere: this read your git history and nothing else.`,
    "",
    `Writing a draft sends the screened evidence for that one workflow to the model, which`,
    `costs about $${ESTIMATED_DRAFT_COST.toFixed(2)} and takes a minute. The draft goes to /handbook:review,`,
    `where you decide whether it is kept, and nothing reaches a repository before that.`,
    "",
    `  /handbook:mine draft 1${repoArgs}`,
  );
  if (workflows.length >= listSize && drafted > 0) {
    lines.push(`  /handbook:mine${repoArgs} --limit ${listSize * 2}   to see further down the list`);
  }
  return lines.join("\n");
}

export interface DraftOutcome {
  ok: boolean;
  rank: number;
  /** The candidate's name once it is queued. */
  slug?: string;
  dir?: string;
  /** Why the draft was dropped, in the words the format gate and the screen used. */
  reasons?: string[];
  error?: string;
}

/**
 * Write one draft for one chosen workflow and put it in the review queue.
 *
 * It queues; it never installs. The candidate carries `origin: "mine"` so that the review
 * screen can say what kind of thing it is holding, and so that approving it into a project
 * takes the route that commits - which is the only route a mined draft has, because the
 * file map it is built from is made of that repository's real paths.
 */
export async function draftWorkflow(
  workflow: Workflow,
  index: UnitIndex,
  shape: Shape,
  run: DraftRunner | undefined,
  home: string = handbookHome(),
  now: () => string = () => new Date().toISOString(),
  cwd: string = process.cwd(),
): Promise<DraftOutcome> {
  const evidence = buildEvidence(shape, index, { host: hostIdentity() });
  // `run` left out means draftSkill's own runner, which is the one that shells out to the
  // user's claude CLI. Only a test passes one.
  const result = run ? await draftSkill(evidence, run) : await draftSkill(evidence);
  if (!result.ok || !result.skill) {
    return { ok: false, rank: workflow.rank, reasons: result.reasons };
  }
  const summary = parseSkillFrontmatter(result.skill);
  if (!summary) {
    return { ok: false, rank: workflow.rank, reasons: ["no-frontmatter"] };
  }
  const base = candidatesDir(home);
  const slug = uniqueSlug(summary.name, (s) => existsSync(join(base, s)));
  const dir = join(base, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), result.skill);
  // Read back what landed on disk rather than trusting what was sent: the review screen
  // shows this mark so the decision to send the draft anywhere is taken knowing it.
  const trace = identityInSkillDir(dir);
  const meta: CandidateMeta = {
    slug,
    status: "pending",
    createdAt: now(),
    scope: "project",
    description: summary.description,
    // The workflow it was drafted from, by the id that holds still when the repository set
    // changes. A label, not a guard: nothing reads it before writing, so drafting the same
    // workflow twice queues two candidates.
    fingerprint: `mine:${shape.id}`,
    sessionId: "",
    cwd,
    gate: null,
    origin: "mine",
    kind: "procedure",
    suggestedTarget: "project",
    ...(trace ? { hygiene: { identity: trace.class, where: trace.where } } : {}),
  };
  writeCandidateMeta(dir, meta);
  return { ok: true, rank: workflow.rank, slug, dir };
}

/** Read the histories once, so a draft is written from the same units the list ranked. */
export function unitIndexFor(repoPaths: string[], options: MineOptions = {}): UnitIndex {
  return readUnitIndex(repoPaths, options);
}
