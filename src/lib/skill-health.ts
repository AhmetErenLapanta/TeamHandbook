import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { coverage, readUnitIndex } from "./draft.js";
import type { UnitIndex } from "./draft.js";
import { nonInteractiveEnv, teamSkillsDir } from "./init.js";
import { buildRoleResolver, IGNORED_ROLES, repoLabels } from "./mine.js";
import { listCandidates } from "./queue.js";
import { handbookHome } from "./session-state.js";
import { loadMinedRecord, repositoryOf, sessionDetectEnabled, sessionsByShape } from "./session-workflow.js";
import { fileMapCells, matcherFor, pathTokens } from "./skill-format.js";
import { listExistingSkills, parseSkillFrontmatter } from "./skill-index.js";
import { readSkillUsage, usesSince, USAGE_DAYS } from "./usage.js";
import type { SkillUsage } from "./usage.js";

/**
 * What became of a skill after it was delivered: whether the files its map points at are still
 * there, whether new work still follows the map, whether anyone calls it, and whether another
 * skill answers the same requests.
 *
 * Deterministic and local from end to end. It reads the repository's file list and history with
 * git, the skills' own text, and the usage and session records this product already keeps; it
 * calls no model, opens no connection, and writes nothing. It also changes nothing: every finding
 * is a line for the user to act on.
 */

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export interface MapRow {
  /** The pattern cell as the skill wrote it. */
  cell: string;
  /** The repository the row names when the work spans several: `orders-api: \`dto/*Request.kt\``. */
  label: string | null;
  patterns: string[];
}

/** A repository named ahead of the pattern, quoted or not: `orders-api: ...`. One word, no spaces. */
const ROW_LABEL = /^\s*`?([A-Za-z0-9][A-Za-z0-9._-]*)`?\s*:\s/;
const QUOTED = /`([^`]+)`/g;

/**
 * The rows of a skill's file map, each with the path patterns it carries. A row that names no path
 * at all is left out: it says nothing that a file list can confirm or deny.
 */
export function fileMapRows(text: string): MapRow[] {
  return fileMapCells(text)
    .map(mapRow)
    .filter((row) => row.patterns.length > 0);
}

function mapRow(cell: string): MapRow {
  let label = ROW_LABEL.exec(cell)?.[1] ?? null;
  const quoted = [...cell.matchAll(QUOTED)].map((m) => m[1]!);
  // A cell that quotes its pattern has said which words are the path. One that quotes nothing is
  // read for the tokens that carry a directory, so an abbreviation in its label is not a file.
  const tokens = quoted.length ? quoted.flatMap(pathTokens) : pathTokens(cell).filter((t) => t.includes("/"));
  const patterns: string[] = [];
  for (const raw of tokens) {
    let token = raw.replace(/[,;:.]+$/, "");
    const colon = token.indexOf(":");
    if (colon > 0 && !/[/*]/.test(token.slice(0, colon))) {
      label ??= token.slice(0, colon);
      token = token.slice(colon + 1);
    }
    if (token && !patterns.includes(token)) patterns.push(token);
  }
  return { cell, label, patterns };
}

// ---------------------------------------------------------------------------
// The repositories a map is read against
// ---------------------------------------------------------------------------

export interface RepoTree {
  /** The checkout's top level, so the file list holds every tracked path whatever directory asked. */
  root: string;
  label: string;
  files: string[];
  /** The role a file plays in the miner's words, for the work a map does not list. */
  role: (path: string) => string;
}

export type TrackedFiles = (root: string) => string[] | null;

/** A status screen waits on this, so it is given a deadline rather than the time a large history needs. */
const LIST_TIMEOUT_MS = 10_000;

export const trackedFiles: TrackedFiles = (root) => {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: nonInteractiveEnv(),
      timeout: LIST_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
};

export function repoTree(root: string, label: string, list: TrackedFiles = trackedFiles): RepoTree | null {
  const files = list(root);
  if (!files) return null;
  return { root, label, files, role: buildRoleResolver(files) };
}

/** Directories holding someone else's code: a copy of a file in one is not the file a map names. */
const VENDORED = /(^|\/)(node_modules|vendor|vendored|third_party|bower_components)\//;
/** An area layout is one directory per area; a single directory under a matching name is a coincidence. */
const MIN_AREAS = 2;

/** The repository a row is read against, and where in it the skill's own project sits. */
export interface RowRepo {
  tree: RepoTree;
  /** The project directory the skill was installed into, relative to the checkout; empty at its top level. */
  base: string;
}

/**
 * Which paths a map pattern names, read the way a map is written.
 *
 * - A path with no wildcard names one file from the root: the checkout's, where the miner reads its
 *   history from, or the project's the skill was installed into, for a map written by hand inside
 *   a larger checkout. `src/routes/index.ts` is that file and not a copy of it further down.
 * - A pattern with a wildcard is the miner's role, `directory/*Suffix.ext`, and the directory is the
 *   one the file sits in, wherever that is: the miner names a Kotlin service three packages deep
 *   `service/*Service.kt`, so reading it from the root would call every such row gone. It is read
 *   from the root as well, for a map that wrote the whole path.
 * - `**` in front asks for any depth outright.
 * - A wildcard in the last segment also stands for the miner's area role, `controller/*Controller.kt`
 *   for `controller/orders/OrderController.kt`, but only where the tree still has at least two such
 *   area directories.
 *
 * Nothing under a vendored directory counts.
 */
export function pathMatcher(pattern: string, repo: RowRepo): (path: string) => boolean {
  const anyDepth = pattern.startsWith("**/");
  const body = anyDepth ? pattern.slice(3) : pattern.replace(/^\.\//, "");
  const segment = matcherFor(body);
  const prefixes = repo.base ? ["", `${repo.base}/`] : [""];
  // `segment` is anchored at a segment boundary and at the end, so the leftmost match is at the root
  // whenever there is one there; a match that starts with the separator came from further down.
  const rooted = (path: string) =>
    prefixes.some((prefix) => {
      if (!path.startsWith(prefix)) return false;
      const match = segment?.exec(path.slice(prefix.length));
      return !!match && match.index === 0 && match[1] === "";
    });
  const wildcard = /[*{<]/.test(body);
  const role = anyDepth || wildcard ? segment : null;
  const slash = body.lastIndexOf("/");
  const areaForm = wildcard && slash > 0 && body.slice(slash + 1).includes("*") ? matcherFor(`${body.slice(0, slash)}/*${body.slice(slash)}`) : null;
  const areas = areaForm ? new Set(repo.tree.files.filter((f) => !VENDORED.test(f) && areaForm.test(f)).map((f) => dirname(f))) : null;
  const area = areas && areas.size >= MIN_AREAS ? areaForm : null;
  return (path) => !VENDORED.test(path) && (rooted(path) || (role?.test(path) ?? false) || (area?.test(path) ?? false));
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export interface RowCheck {
  cell: string;
  /** The repository the row was read against, or null when the row names one that cannot be found. */
  repo: string | null;
  /** Tracked files each pattern matches, in the row's order. */
  files: number[];
  /** True when a pattern matches nothing; null when the row could not be checked at all. */
  stale: boolean | null;
}

/**
 * Every row read against the repository it names. A row whose repository cannot be found is not
 * checked: it is not evidence of anything, and calling it stale would report the user's machine
 * as their skill.
 */
export function checkRows(rows: MapRow[], repoFor: (label: string | null) => RowRepo | null): RowCheck[] {
  return rows.map((row) => {
    const repo = repoFor(row.label);
    if (!repo) return { cell: row.cell, repo: null, files: [], stale: null };
    const files = row.patterns.map((pattern) => {
      const matches = pathMatcher(pattern, repo);
      return repo.tree.files.filter((path) => matches(path)).length;
    });
    return { cell: row.cell, repo: repo.tree.label, files, stale: files.some((n) => n === 0) };
  });
}

// ---------------------------------------------------------------------------
// Whether new work still follows the map
// ---------------------------------------------------------------------------

export type Trend = "down" | "flat" | "up";

export interface FitTrend {
  trend: Trend | null;
  /** How many units of work touched a mapped file. */
  units: number;
  /** Mean share of each unit's files the map accounted for, over the latest window and the one before. */
  recent: number | null;
  prior: number | null;
}

/** How many of the latest units are compared with the ones before them. */
export const TREND_WINDOW = 10;
/** Fewer units than this on either side and the mean is one ticket's accident, so no arrow is drawn. */
const MIN_WINDOW = 3;
/**
 * A change smaller than this reads as flat, and so does one inside twice the windows' own spread.
 * Measured by re-reading real histories one ticket at a time: a narrow band drew an arrow so often
 * that it said nothing, because one ticket covers a map very differently from the next, and the
 * spread condition took most of what was left away on the maps whose tickets vary the most.
 */
export const TREND_BAND = 0.25;

/**
 * How much of each recent unit of work the map accounts for, latest window against the one before.
 *
 * A unit counts when it touched at least one mapped file. Asking for more - most of the map - is
 * the miner's own test of "the same workflow", and it is the wrong one here: the drift this is
 * looking for is the work moving to files the map does not list, and a unit that moved most of the
 * way would no longer qualify, so the window would fill with the old units and stay flat.
 *
 * The share is the map's coverage of the unit, with every file the map does not list kept in the
 * denominator under the role the miner gives it. A file that gets no role at all, or that no
 * description is expected to predict (a lock file, generated output, prose), is out of both sides.
 */
export function fitTrend(
  rows: MapRow[],
  trees: RepoTree[],
  repoFor: (label: string | null) => RowRepo | null,
  index: UnitIndex,
): FitTrend {
  const byRoot = new Map(trees.map((t) => [t.root, t]));
  const labels = repoLabels(trees.map((t) => t.root));
  const byLabel = new Map([...labels].map(([root, label]) => [label, byRoot.get(root)!]));
  const mapped = rows.flatMap((row, i) => {
    const repo = repoFor(row.label);
    return repo ? [{ id: `map:${i}`, tree: repo.tree, matches: row.patterns.map((p) => pathMatcher(p, repo)) }] : [];
  });
  const roleOf = (repo: string, path: string): string | null => {
    const tree = byLabel.get(repo);
    if (!tree) return null;
    const row = mapped.find((m) => m.tree === tree && m.matches.some((match) => match(path)));
    if (row) return row.id;
    const role = tree.role(path);
    return IGNORED_ROLES.has(role) ? null : `${tree.label}:${role}`;
  };
  const predicted = mapped.map((m) => m.id);
  const scored = [...index.values()]
    .sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.key < b.key ? -1 : 1))
    .map((record) => coverage(predicted, [record.key], index, roleOf).narrowed)
    .filter((score) => score.hit > 0)
    .map((score) => score.recall);
  return trendOf(scored);
}

/** The arrow for a series of per-unit shares, oldest first: the latest window against the one before. */
export function trendOf(scored: number[]): FitTrend {
  const window = Math.min(TREND_WINDOW, Math.floor(scored.length / 2));
  if (window < MIN_WINDOW) return { trend: null, units: scored.length, recent: null, prior: null };
  const recentScores = scored.slice(-window);
  const priorScores = scored.slice(-2 * window, -window);
  const delta = mean(recentScores) - mean(priorScores);
  const spread = 2 * Math.sqrt(variance(recentScores) / window + variance(priorScores) / window);
  const moved = Math.abs(delta) > Math.max(TREND_BAND, spread);
  return {
    trend: !moved ? "flat" : delta < 0 ? "down" : "up",
    units: scored.length,
    recent: Number(mean(recentScores).toFixed(2)),
    prior: Number(mean(priorScores).toFixed(2)),
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

// ---------------------------------------------------------------------------
// Two skills answering the same request
// ---------------------------------------------------------------------------

/**
 * Words that carry no subject. The template's own scaffolding is here alongside the language's:
 * every generated description says "use when", "also when" and "triggers", so leaving those in
 * would make every pair of drafts look alike for having been written to the same form.
 */
const FILLER = new Set(
  (
    "a about after again all also an and any are as at be been before being both but by can could did do does doing done " +
    "each either for from had has have having how if in into is it its itself just may might more most must no nor not now " +
    "of off on once one only or other our out over own same should so some such than that the their them then there these " +
    "they this those through to too under until up upon very was we were what when whenever where whether which while who " +
    "whom why will with within without would you your yours " +
    "use used uses using also trigger triggers skill skills request requests asks asked something someone thing things way " +
    "e g eg etc via new instead like want wants need needs make makes made get gets"
  ).split(" "),
);

/** The words a description is recognised by, folded so that "endpoints" and "endpoint" are one. */
export function triggerWords(description: string): Set<string> {
  const words = new Set<string>();
  for (const match of description.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let word = match[0];
    if (word.length < 3 || FILLER.has(word)) continue;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    words.add(word);
  }
  return words;
}

export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return Number((shared / (a.size + b.size - shared)).toFixed(3));
}

/**
 * From this share of shared words up, two descriptions are reported as answering the same
 * requests. Chosen by measurement over installed and drafted skills as the lowest value that
 * flagged no pair a reader keeps apart, while still flagging the same skill loaded twice and two
 * skills written for the same request. Two drafts mined from one repository for different work
 * share that repository's vocabulary and nothing else, and stay below it.
 */
export const OVERLAP_THRESHOLD = 0.25;

export interface SkillText {
  name: string;
  description: string;
}

/**
 * The other skills whose descriptions overlap each named one, most overlapping first. A warning
 * and nothing more: two skills that answer the same sentence split the routing between them, but
 * which one should give way is the user's call.
 */
export function overlappingSkills(
  named: SkillText[],
  others: SkillText[],
  threshold: number = OVERLAP_THRESHOLD,
): Map<string, string[]> {
  const words = new Map<string, Set<string>>();
  const wordsOf = (skill: SkillText) => {
    let set = words.get(skill.description);
    if (!set) words.set(skill.description, (set = triggerWords(skill.description)));
    return set;
  };
  const result = new Map<string, string[]>();
  for (const skill of named) {
    const hits = others
      .filter((other) => other.name !== skill.name)
      .map((other) => ({ name: other.name, score: wordOverlap(wordsOf(skill), wordsOf(other)) }))
      .filter((hit) => hit.score >= threshold)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    result.set(skill.name, [...new Set(hits.map((hit) => hit.name))]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// One line per delivered skill
// ---------------------------------------------------------------------------

export interface SkillHealth {
  name: string;
  /** Map rows that name a path, the ones that could be read against a repository, and the stale ones among those. */
  map: { rows: number; checked: number; stale: number };
  /** Calls in the window; null while session recording is off, when nothing was counted. */
  uses: number | null;
  /** Sessions that did the workflow the skill was drafted from; null for a skill not drafted from one, or when nothing was counted. */
  workflowSessions: number | null;
  trend: Trend | null;
  overlaps: string[];
}

interface DeliveredSkill {
  name: string;
  text: string;
  /** The checkout the skill was installed into, when it was installed into one. */
  repo: string | null;
  /** The project directory it was installed into, relative to that checkout. */
  base: string;
  shape: string | null;
}

export interface HealthDeps {
  now?: string;
  tracked?: TrackedFiles;
  units?: (roots: string[]) => UnitIndex;
  /** Whose `~/.claude/skills` and which project's `.claude/skills` the overlap check reads. */
  userHome?: string;
  cwd?: string;
}

function readSkill(dir: string): string | null {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * The skills this product delivered and that are still installed: approvals into a project or the
 * user's own directory, and what the team repository carries. The same set the usage line reports
 * on, for the same reason - a skill this product did not deliver is not its to judge.
 */
function deliveredSkills(home: string): DeliveredSkill[] {
  const out = new Map<string, DeliveredSkill>();
  for (const meta of listCandidates(home, "approved")) {
    if ((meta.deliveredMode !== "solo" && meta.deliveredMode !== "personal") || !meta.deliveredTo) continue;
    const text = readSkill(meta.deliveredTo);
    if (text === null) continue;
    const name = basename(meta.deliveredTo);
    if (out.has(name)) continue;
    const shape = meta.fingerprint?.startsWith("mine:") ? meta.fingerprint.slice("mine:".length) : null;
    const repo = meta.deliveredMode === "solo" ? (repositoryOf(meta.deliveredTo)?.checkout ?? null) : null;
    out.set(name, { name, text, repo, base: repo ? projectBase(repo, meta.deliveredTo) : "", shape });
  }
  const teamDir = teamSkillsDir(home);
  if (teamDir) {
    for (const skill of listExistingSkills([teamDir])) {
      if (out.has(skill.name)) continue;
      const text = readSkill(join(teamDir, skill.name));
      if (text !== null) out.set(skill.name, { name: skill.name, text, repo: null, base: "", shape: null });
    }
  }
  return [...out.values()];
}

/** A project skill sits at `<project>/.claude/skills/<name>`; where that project is inside its checkout. */
function projectBase(checkout: string, skillDir: string): string {
  const rel = relative(checkout, dirname(dirname(dirname(skillDir)))).split(sep).join("/");
  return rel.startsWith("..") ? "" : rel;
}

/** Every skill this machine loads here: the project's, the user's own, and the team repository's local copy. */
export function installedSkills(
  home: string = handbookHome(),
  userHome: string = homedir(),
  cwd: string = process.cwd(),
): SkillText[] {
  const teamDir = teamSkillsDir(home);
  return listExistingSkills([join(cwd, ".claude", "skills"), join(userHome, ".claude", "skills"), ...(teamDir ? [teamDir] : [])]);
}

function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** A plugin's skill is called as `<plugin>:<name>`, so both spellings are the same skill's calls. */
function callsOf(name: string, usage: SkillUsage, now: string): number {
  return Object.entries(usage)
    .filter(([key]) => key === name || key.endsWith(`:${name}`))
    .reduce((sum, [, use]) => sum + usesSince(use, now, USAGE_DAYS), 0);
}

export function gatherSkillHealth(home: string = handbookHome(), deps: HealthDeps = {}): SkillHealth[] {
  const skills = deliveredSkills(home);
  if (!skills.length) return [];
  const now = deps.now ?? new Date().toISOString();
  const tracked = deps.tracked ?? trackedFiles;
  const units = deps.units ?? ((roots: string[]) => readUnitIndex(roots));
  // Nothing is counted while session recording is off, so no count is shown: a zero would report
  // a measurement that was never taken.
  const recording = sessionDetectEnabled(home);
  const usage = readSkillUsage(home);
  const sessions = sessionsByShape(home, Date.parse(now), USAGE_DAYS);
  const mined = loadMinedRecord(home);
  const minedRoots = new Map((mined?.repos ?? []).map((r) => [r.label, r.root]));
  // Keyed by the real path: the mined record names a repository by it while a delivered skill's
  // checkout is the path as written, and one repository reached both ways would be read as two,
  // its history doubled and every unit's share halved.
  const trees = new Map<string, RepoTree | null>();
  const treeAt = (root: string) => {
    const real = realRoot(root);
    if (!trees.has(real)) trees.set(real, repoTree(real, basename(real), tracked));
    return trees.get(real)!;
  };
  const indexes = new Map<string, UnitIndex>();
  const overlaps = overlappingSkills(
    skills.map((s) => ({ name: s.name, description: parseSkillFrontmatter(s.text)?.description ?? "" })),
    installedSkills(home, deps.userHome, deps.cwd),
  );

  return skills.map((skill) => {
    const rows = fileMapRows(skill.text);
    const repoFor = (label: string | null): RowRepo | null => {
      const own = skill.repo && (label === null || basename(skill.repo) === label) ? treeAt(skill.repo) : null;
      if (own) return { tree: own, base: skill.base };
      const root = label === null ? undefined : minedRoots.get(label);
      const tree = root ? treeAt(root) : null;
      return tree ? { tree, base: "" } : null;
    };
    const checks = checkRows(rows, repoFor);
    const checked = checks.filter((c) => c.stale !== null);
    const used = [...new Set(rows.map((row) => repoFor(row.label)?.tree).filter((t): t is RepoTree => !!t))];
    let trend: Trend | null = null;
    if (checked.length && used.length) {
      const key = used.map((t) => t.root).sort().join("\n");
      if (!indexes.has(key)) indexes.set(key, units(used.map((t) => t.root)));
      trend = fitTrend(rows, used, repoFor, indexes.get(key)!).trend;
    }
    return {
      name: skill.name,
      map: { rows: rows.length, checked: checked.length, stale: checked.filter((c) => c.stale).length },
      uses: recording ? callsOf(skill.name, usage, now) : null,
      workflowSessions: recording && skill.shape ? (sessions.get(skill.shape) ?? 0) : null,
      trend,
      overlaps: overlaps.get(skill.name) ?? [],
    };
  });
}

const ARROW: Record<Trend, string> = { down: "↓", flat: "→", up: "↑" };

/**
 * One line per skill, numbers only, and a single suggestion when any line has something to act on.
 * A measurement that could not be taken is left off the line rather than printed as a zero.
 */
export function formatSkillHealth(health: SkillHealth[]): string[] {
  if (!health.length) return [];
  const width = Math.max(...health.map((h) => h.name.length));
  const lines = health.map((h) => {
    const parts = [
      !h.map.rows ? "no file map" : !h.map.checked ? "map not checkable here" : `map ${h.map.stale}/${h.map.checked} stale`,
      h.uses === null ? "usage not recorded" : `used ${h.uses}`,
    ];
    if (h.workflowSessions !== null) parts.push(`workflow done ${h.workflowSessions}×`);
    if (h.trend) parts.push(`fit to new work ${ARROW[h.trend]}`);
    if (h.overlaps.length) parts.push(`overlaps ${h.overlaps[0]}${h.overlaps.length > 1 ? ` +${h.overlaps.length - 1}` : ""}`);
    return `  ${h.name.padEnd(width)}  ${parts.join(" · ")}`;
  });
  const flagged = health.some((h) => h.map.stale > 0 || h.trend === "down" || h.overlaps.length);
  return [
    `Skill health:    last ${USAGE_DAYS} days; nothing here is changed for you`,
    ...lines,
    ...(flagged
      ? ["  Stale map or falling fit: run /handbook:mine and draft that workflow again. Overlap: reword one of the two descriptions."]
      : []),
  ];
}
