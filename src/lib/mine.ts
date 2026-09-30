import { randomBytes, createHash } from "node:crypto";
import { basename } from "node:path";
import { detectSecret } from "./secrets.js";
import {
  gitFailure,
  isRepository,
  readCommits,
  resolveRef,
  type CommitFile,
  type GitRunner,
  type RawCommit,
} from "./git-log.js";

/**
 * Mines a repository's history for the workflows it repeats: the sets of files that the same kind
 * of work touches together, ticket after ticket, across however many repositories that work spans.
 *
 * Deterministic and model-free by design. Nothing here calls a model, and nothing here reaches the
 * network: the whole engine reads git history that is already on the machine.
 *
 * Two measurements shaped it, both taken on real multi-repository histories before it was written:
 *
 * - Raw file paths do not cluster. The most repeated workflow in one measured workspace adds a
 *   field to a record type, and every ticket in it touches a DIFFERENT `<Type>.kt` and
 *   `<Type>Service.kt`. Grouping by path finds nothing; grouping by the ROLE a path plays
 *   (its directory plus the last word of its name) finds the workflow.
 * - A commit is the wrong unit of work. Grouping by commit split one workflow across several
 *   separate top-ten entries, because the workflow spans repositories and lands as several
 *   commits. The unit is the ticket, joined across repositories by its key.
 */

// ---------------------------------------------------------------------------
// Commit classification
// ---------------------------------------------------------------------------

export type CommitClass =
  | "work"
  | "merge"
  | "revert"
  | "version-bump"
  | "docs-only"
  | "ci-only"
  | "format"
  | "merge-resolution"
  | "lockfile"
  | "mass-change"
  | "mass-rename"
  | "empty";

const LOCK =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile|deno\.lock)$/;
const BUILD =
  /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties|pom\.xml|package\.json|jsr\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^/]*\.toml|gradle\/wrapper\/.*|libs\.versions\.toml)$/;
const CI = /(^|\/)(\.gitlab-ci\.yml|\.github\/|Jenkinsfile|\.circleci\/|helm\/|k8s\/|deploy\/|Dockerfile[^/]*$)/;
const DOC = /(\.md|\.mdx|\.rst|\.txt|LICENSE|CHANGELOG[^/]*)$/i;
const TEST =
  /(^|\/)(src\/test\/|test\/|tests\/|__tests__\/|spec\/)|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.(kt|java)$/;

const FORMAT_SUBJECT = /\b(ktlint|spotless|prettier|eslint|lint|format(ting)?|fmt|import order|whitespace|typo)\b/i;
const BUMP_SUBJECT =
  /\b(bump|upgrade|update (deps|dependencies)|dependenc(y|ies)|version|renovate|dependabot|release v?\d|chore\(release\)|sonar)\b/i;
/**
 * A release commit's subject is the version and little else ("v5.7.2", "Bumped v5.9.0"). It edits
 * the version constant in source as well as the manifest, so the build-files test alone lets it
 * through, and in one measured project release commits formed the fourth most repeated shape.
 */
const RELEASE_SUBJECT = /^\s*(?:(?:bump(?:ed|s)?|release[ds]?|prepare release|version)\s+(?:to\s+)?)?v?\d+\.\d+\.\d+(?:[-+.][\w.]+)?\s*$/i;
const CONFLICT_SUBJECT = /\b(resolve[sd]? (merge )?conflicts?|merge (branch|remote)|conflict)\b/i;
// The non-English words in these two patterns are data, not product text: subjects are written in
// whatever language the team speaks, and these came from a measured history that mixed two.
const REVERT_SUBJECT = /^\s*(revert|geri al)\b|\bthis reverts commit\b/i;
/** Words that mean the commit adds something even when it also mentions formatting. */
const ADDITIVE_SUBJECT = /\b(add|feat|new|endpoint|field|alan|ekle)\b/i;

export interface ClassifyOptions {
  /** A change this wide is a sweep, not a workflow. */
  massChangeFiles?: number;
  /** At least this many files, at least half of them renamed, is a rename sweep. */
  massRenameFiles?: number;
  /** A change touching this many files while editing this few lines in each is a reformat. */
  formatMinFiles?: number;
  formatMaxLinesPerFile?: number;
}

const CLASSIFY_DEFAULTS: Required<ClassifyOptions> = {
  massChangeFiles: 80,
  massRenameFiles: 20,
  formatMinFiles: 5,
  formatMaxLinesPerFile: 3,
};

/**
 * What kind of commit this is. Everything but "work" is excluded from mining and counted, because
 * an exclusion nobody can count is indistinguishable from a bug in the filter.
 */
export function classifyCommit(
  commit: Pick<RawCommit, "subject" | "files" | "parents">,
  options: ClassifyOptions = {},
): CommitClass {
  const o = { ...CLASSIFY_DEFAULTS, ...options };
  // A merge is decided by its parent count, not by an empty file list: git prints no files for a
  // merge, so a file-based test would file every merge under "empty" instead.
  if (commit.parents.length > 1) return "merge";
  if (REVERT_SUBJECT.test(commit.subject)) return "revert";
  const files = commit.files;
  const n = files.length;
  if (n === 0) return "empty";
  const paths = files.map((f) => f.path);
  if (paths.every((p) => LOCK.test(p))) return "lockfile";
  if (paths.every((p) => LOCK.test(p) || BUILD.test(p))) return "version-bump";
  if (RELEASE_SUBJECT.test(commit.subject)) return "version-bump";
  if (BUMP_SUBJECT.test(commit.subject) && paths.filter((p) => LOCK.test(p) || BUILD.test(p)).length >= n / 2) {
    return "version-bump";
  }
  if (FORMAT_SUBJECT.test(commit.subject) && !ADDITIVE_SUBJECT.test(commit.subject)) return "format";
  if (isReformat(files, o)) return "format";
  if (CONFLICT_SUBJECT.test(commit.subject)) return "merge-resolution";
  if (n >= o.massRenameFiles && files.filter((f) => f.status.startsWith("R")).length / n >= 0.5) return "mass-rename";
  if (paths.every((p) => CI.test(p))) return "ci-only";
  if (paths.every((p) => DOC.test(p))) return "docs-only";
  if (n >= o.massChangeFiles) return "mass-change";
  return "work";
}

/**
 * A reformat spreads a tiny edit over many files. The subject often says so, but not always: a
 * tool-driven reformat lands under a ticket key with a perfectly ordinary subject, and only the
 * shape of the diff gives it away.
 */
function isReformat(files: CommitFile[], o: Required<ClassifyOptions>): boolean {
  if (files.length < o.formatMinFiles) return false;
  let touched = 0;
  for (const f of files) {
    // Only an edit to an existing file can be a reformat. Scaffolding several small new files has
    // the same line counts and is real work.
    if (f.status !== "M") return false;
    // A binary file has no line counts, so nothing here can call it small.
    if (f.added === null || f.removed === null) return false;
    touched += f.added + f.removed;
  }
  return touched / files.length <= o.formatMaxLinesPerFile;
}

// ---------------------------------------------------------------------------
// Work units: the ticket, not the commit
// ---------------------------------------------------------------------------

/**
 * Prefixes that look like a ticket key but are not. Each of these appears with enough distinct
 * numbers in a real history to survive the learned-prefix rule below: a repository that fixes
 * vulnerabilities has CVE-2023, CVE-2024 and CVE-2025 in its subjects, and merging those three
 * into cross-repository work units would fabricate the largest "workflow" in the output.
 */
const NOT_A_TICKET = new Set([
  "UTF",
  "ISO",
  "CVE",
  "SHA",
  "RFC",
  "HTTP",
  "HTTPS",
  "MD",
  "AES",
  "RSA",
  "TLS",
  "SSL",
  "IPV",
  "UTC",
  "GMT",
  "JDK",
  "ES",
  "EC",
  "PEP",
  "ADR",
  "RGB",
  "SQL",
]);

const KEY_CANDIDATE = /\b([A-Z]{2,})-(\d+)\b/g;
// A squash merge writes its pull request as "(#6909)", so an opening parenthesis counts as a boundary.
const ISSUE_NUMBER = /(?:^|[\s(])#(\d+)\b/;
const MERGE_BRANCH = /Merge branch '([^']+)'|Merge (?:remote-tracking )?branch "([^"]+)"|Merge pull request #\d+ from \S+/;
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?:/;

/**
 * Which uppercase prefixes this history actually uses as ticket keys. A prefix earns the name by
 * appearing with several DISTINCT numbers: "UTF-8" is written a hundred times and is always 8.
 */
export function learnTicketPrefixes(subjects: string[], minDistinctNumbers = 5): Set<string> {
  const numbers = new Map<string, Set<string>>();
  for (const subject of subjects) {
    for (const match of subject.matchAll(KEY_CANDIDATE)) {
      const prefix = match[1]!;
      if (NOT_A_TICKET.has(prefix)) continue;
      let seen = numbers.get(prefix);
      if (!seen) numbers.set(prefix, (seen = new Set()));
      seen.add(match[2]!);
    }
  }
  return new Set([...numbers].filter(([, seen]) => seen.size >= minDistinctNumbers).map(([prefix]) => prefix));
}

/** Conventional Commits metadata. Kept as a label on the commit; see `unitKeyOf` for why. */
export function conventionalParts(subject: string): { type: string; scope: string | null } | null {
  const match = CONVENTIONAL.exec(subject);
  if (!match) return null;
  return { type: match[1]!, scope: match[2] ?? null };
}

/**
 * The key that joins commits into one piece of work.
 *
 * A ticket key joins ACROSS repositories, which is the whole point: the workflows worth a skill are
 * the ones that span several. An issue number does not: `#12` means a different issue in every
 * repository, so it is namespaced by repository before it becomes a key.
 *
 * A Conventional Commits `type(scope):` prefix is deliberately NOT a key, though it looks like
 * one. It labels a module, not a piece of work: keying on it
 * would collapse every `fix(core)` a project ever made into a single unit spanning years. It is
 * kept as metadata, where it can say whether a cluster's commits are about the same kind of change.
 */
export function unitKeyOf(commit: RawCommit, repo: string, prefixes: Set<string>): string | null {
  for (const match of commit.subject.matchAll(KEY_CANDIDATE)) {
    if (prefixes.has(match[1]!)) return `${match[1]}-${match[2]}`;
  }
  const issue = ISSUE_NUMBER.exec(commit.subject);
  if (issue) return `${repo}#${issue[1]}`;
  return null;
}

/** The branch name a merge commit records, which is where a ticket key hides when the commits lack one. */
export function mergedBranchName(subject: string): string | null {
  const match = MERGE_BRANCH.exec(subject);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

// ---------------------------------------------------------------------------
// Roles: what a path IS, rather than which file it is
// ---------------------------------------------------------------------------

/** The last word of a file's name, which is the part that says what the file is for. */
export function stemSuffix(base: string): { suffix: string; ext: string } {
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const parts = stem.split(/[._-]/);
  const last = parts[parts.length - 1] || stem;
  const camel = last.match(/[A-Z][a-z0-9]+|[A-Z]+(?![a-z])|[a-z0-9]+/g);
  return { suffix: camel ? camel[camel.length - 1]! : last, ext };
}

export interface RoleResolver {
  (path: string): string;
  /** Top-level directories found to be generated copies of another one. */
  mirrors: Set<string>;
  /** Directory layouts where a name repeats across sibling directories, e.g. `middleware/*\/index.ts`. */
  templates: Map<string, string>;
}

export interface RoleOptions {
  /**
   * False keeps tests, lockfiles and generated mirrors as ordinary roles. Only for measuring what
   * the noise filters are worth: with them off, the noise is what rises to the top.
   */
  filters?: boolean;
  /** False keeps the area directory of a package-per-area layout in the role. */
  areaTemplates?: boolean;
  /** How many sibling directories must share a file name before the layout counts as a template. */
  minSiblings?: number;
  /** How much of a directory must duplicate another one before it counts as a generated mirror. */
  mirrorShare?: number;
  /** A directory smaller than this is too small for the mirror test to mean anything. */
  mirrorMinFiles?: number;
}

/**
 * Builds the path-to-role function for one body of history. It has to be built from the paths
 * rather than written down, because two of the three abstractions it applies are properties of the
 * codebase: which directories are generated copies, and which layouts repeat a file name across
 * sibling directories.
 */
export function buildRoleResolver(paths: Iterable<string>, options: RoleOptions = {}): RoleResolver {
  const minSiblings = options.minSiblings ?? 5;
  const mirrorShare = options.mirrorShare ?? 0.6;
  const mirrorMinFiles = options.mirrorMinFiles ?? 10;
  const all = [...paths];

  const siblings = new Map<string, Set<string>>();
  const areaDirs = new Map<string, Set<string>>();
  const topLevel = new Map<string, Set<string>>();
  for (const path of all) {
    const segments = path.split("/");
    if (segments.length >= 3) {
      const key = `${segments.slice(0, -2).join("/")}\u0000${segments[segments.length - 1]}`;
      let dirs = siblings.get(key);
      if (!dirs) siblings.set(key, (dirs = new Set()));
      dirs.add(segments[segments.length - 2]!);
      const area = areaKey(segments);
      let areas = areaDirs.get(area);
      if (!areas) areaDirs.set(area, (areas = new Set()));
      areas.add(segments[segments.length - 2]!);
    }
    if (segments.length >= 2) {
      const top = segments[0]!;
      let rest = topLevel.get(top);
      if (!rest) topLevel.set(top, (rest = new Set()));
      rest.add(segments.slice(1).join("/"));
    }
  }

  const templates = new Map<string, string>();
  for (const [key, dirs] of siblings) {
    if (dirs.size < minSiblings) continue;
    const [parentPath, base] = key.split("\u0000") as [string, string];
    const grandparent = parentPath.split("/").pop() || parentPath;
    templates.set(key, `${grandparent}/*/${base}`);
  }

  // The same idea one level looser: a package-per-area layout puts `controller/orders/OrderController.kt`
  // beside `controller/billing/InvoiceController.kt`, where no file NAME repeats but the kind of file
  // does. Left alone, the area directory becomes part of the role, and one workflow ("open an
  // endpoint") splits into as many roles as the codebase has areas. Measured on a service with many
  // such areas, that workflow's controller, service and response each arrived as a dozen roles.
  const areas = new Map<string, string>();
  if (options.areaTemplates ?? true) {
    for (const [key, dirs] of areaDirs) {
      if (dirs.size < minSiblings) continue;
      const [parentPath, kind] = key.split("\u0000") as [string, string];
      const grandparent = parentPath.split("/").pop() || parentPath;
      areas.set(key, `${grandparent}/${kind}`);
    }
  }

  // A generated mirror holds a copy of another directory's files, so almost everything in it is
  // also somewhere else. Left in, it wins: seven of one measured project's ten most repeated
  // shapes were nothing but "a file and its generated twin".
  const mirrors = new Set<string>();
  for (const [name, files] of topLevel) {
    if (files.size < mirrorMinFiles) continue;
    for (const [other, otherFiles] of topLevel) {
      if (other === name || files.size > otherFiles.size) continue;
      let shared = 0;
      for (const f of files) if (otherFiles.has(f)) shared++;
      if (shared / files.size >= mirrorShare) {
        mirrors.add(name);
        break;
      }
    }
  }

  const filters = options.filters ?? true;
  const resolve = ((path: string): string => {
    const segments = path.split("/");
    if (filters) {
      if (TEST.test(path)) return "test";
      if (LOCK.test(path)) return "lock";
      if (segments.length >= 2 && mirrors.has(segments[0]!)) return "mirror";
    }
    if (segments.length >= 3) {
      const key = `${segments.slice(0, -2).join("/")}\u0000${segments[segments.length - 1]}`;
      const template = templates.get(key) ?? areas.get(areaKey(segments));
      if (template) return template;
    }
    const base = segments[segments.length - 1]!;
    const parent = segments.length > 1 ? segments[segments.length - 2]! : ".";
    const localized = localeFree(base);
    if (localized) return `${parent}/${localized}`;
    const { suffix, ext } = stemSuffix(base);
    return ext ? `${parent}/*${suffix}.${ext}` : `${parent}/${base}`;
  }) as RoleResolver;
  resolve.mirrors = mirrors;
  resolve.templates = templates;
  return resolve;
}

/**
 * Language codes a translation file is named after. A list rather than "any two letters", because
 * two-letter tokens that are not languages (`db`, `ui`, `io`) name ordinary files.
 */
const LOCALES = new Set([
  "en", "tr", "de", "fr", "es", "it", "pt", "nl", "ru", "ar", "zh", "ja", "ko", "pl", "sv", "da", "fi",
  "nb", "cs", "hu", "ro", "el", "he", "uk", "bg", "hr", "sk", "sl", "sr", "et", "lv", "lt", "fa", "hi",
  "th", "vi",
]);
const LOCALIZED = /^(.*?[._-])?([a-z]{2})([_-][A-Z]{2})?\.([A-Za-z0-9]+)$/;

/**
 * The name of a translation file with its language taken out: `messages_en.properties` and
 * `messages_de.properties` are one file kept in two languages, and one role. Counted as two, a
 * translation pair plus any file edited alongside it clears the three-role floor, and on the
 * largest measured history that combination was the most common shape a reader rejected.
 */
function localeFree(base: string): string | null {
  const match = LOCALIZED.exec(base);
  if (!match || !LOCALES.has(match[2]!)) return null;
  return `${match[1] ?? ""}{locale}.${match[4]}`;
}

/** The grandparent directory and the kind of file, which is what an area layout repeats. */
function areaKey(segments: string[]): string {
  const { suffix, ext } = stemSuffix(segments[segments.length - 1]!);
  return `${segments.slice(0, -2).join("/")}\u0000${ext ? `*${suffix}.${ext}` : segments[segments.length - 1]}`;
}

/** Roles that carry no workflow: they are dropped from a shape rather than clustered. */
const IGNORED_ROLES = new Set(["test", "lock", "mirror"]);

// ---------------------------------------------------------------------------
// Repository naming
// ---------------------------------------------------------------------------

/**
 * A short label per repository that is still unique. Two repositories in one workspace can share a
 * basename (`libs/config` and `services/config`), and labelling both "config" would merge two
 * different repositories into one role.
 */
export function repoLabels(paths: string[]): Map<string, string> {
  const segments = new Map(paths.map((p) => [p, p.replace(/\/+$/, "").split("/")]));
  const labels = new Map<string, string>();
  for (const path of paths) {
    const parts = segments.get(path)!;
    for (let depth = 1; depth <= parts.length; depth++) {
      const candidate = parts.slice(parts.length - depth).join("/");
      const collides = paths.some((other) => {
        if (other === path) return false;
        const otherParts = segments.get(other)!;
        return otherParts.slice(otherParts.length - depth).join("/") === candidate;
      });
      if (!collides) {
        labels.set(path, candidate);
        break;
      }
    }
    if (!labels.has(path)) labels.set(path, path);
  }
  return labels;
}

/**
 * The second view of a repository: its family. When a suffix is shared by enough repositories they
 * are playing the same part, and a workflow that repeats "the same change in whichever service owns
 * the entity" only looks repeated once they are named alike.
 *
 * Measured, this view is not uniformly better. It clearly improved how well some known workflows
 * were recovered and cost a little on others, which is why both views are mined and each shape is
 * kept from whichever view found it better.
 */
export function repoFamilies(labels: Iterable<string>, minMembers = 3): Map<string, string> {
  const all = [...labels];
  const bySuffix = new Map<string, number>();
  for (const label of all) {
    const name = basename(label);
    if (!name.includes("-")) continue;
    const suffix = name.slice(name.lastIndexOf("-") + 1);
    bySuffix.set(suffix, (bySuffix.get(suffix) ?? 0) + 1);
  }
  const families = new Map<string, string>();
  for (const label of all) {
    const name = basename(label);
    const suffix = name.includes("-") ? name.slice(name.lastIndexOf("-") + 1) : null;
    families.set(label, suffix && (bySuffix.get(suffix) ?? 0) >= minMembers ? `*-${suffix}` : label);
  }
  return families;
}

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

export interface WorkUnit {
  key: string;
  /** Concrete paths the unit touched, per repository label. */
  files: Map<string, Set<string>>;
  /** The subset of those it created: a new file per ticket and an edit to a shared one are different steps. */
  created: Map<string, Set<string>>;
  authors: Set<string>;
  subjects: string[];
  conventionalTypes: Set<string>;
  commits: number;
  firstAt: string;
  lastAt: string;
  touchesTest: boolean;
}

export interface CoreFile {
  /** The role, e.g. `orders-service:domain/dto/*Request.kt`. */
  role: string;
  /** How many of the shape's units touched it, and out of how many. */
  units: number;
  share: number;
  /** Concrete paths, so a reader can see what the role stands for. Capped, and never a whole list. */
  examples: string[];
}

export interface Shape {
  id: string;
  /** Which repository view found this shape: literal repository names, or repository families. */
  view: "repo" | "family";
  coreFiles: CoreFile[];
  /** Every repository the member units touched. */
  repos: string[];
  /**
   * The repositories the core files themselves are in. This, not `repos`, says whether the
   * workflow spans repositories: in the family view, tickets that each changed one service would
   * otherwise add up to a shape that looks like it crosses ten.
   */
  coreRepos: string[];
  recurrence: number;
  authors: number;
  firstAt: string;
  lastAt: string;
  sampleSubjects: string[];
  memberUnits: string[];
  /** How many member units changed a test alongside the work: evidence that the workflow is checkable. */
  testUnits: number;
}

export interface MineStats {
  /** Repositories read, and the ones that could not be, each with its path and git's reason. */
  repos: number;
  unreadableRepos: UnreadableRepo[];
  commits: number;
  /** Work units before any shape filter, and how many of those were ordinary work. */
  units: number;
  workUnits: number;
  workUnitsMultiRepo: number;
  /** Commits dropped, by the class that dropped them. */
  excludedCommits: Record<string, number>;
  /** Work units dropped, by reason. */
  excludedUnits: Record<string, number>;
  /** Shapes dropped by each shape-level filter. */
  excludedShapes: Record<string, number>;
  /** How many distinct authors the whole history had. A count: no identity is kept. */
  authors: number;
  /**
   * The largest cluster in each view. Clustering that chains through a file everything touches
   * shows up here as one cluster swallowing the history, and nowhere else.
   */
  largestCluster: Record<string, number>;
  /** Commit subjects withheld because a secret detector matched them. */
  /** Candidate subjects withheld, by what they carried. Every candidate is scanned, not only the five kept. */
  subjectsWithheld: { secret: number; email: number };
  mirrors: string[];
  ticketPrefixes: string[];
  /** Shapes that cleared every filter, before `limit` cut the list. */
  shapesBeforeLimit: number;
  elapsedMs: number;
}

export interface MineResult {
  version: 1;
  shapes: Shape[];
  stats: MineStats;
}

export interface MineOptions extends ClassifyOptions, RoleOptions {
  ref?: string;
  since?: string;
  noRenames?: boolean;
  /**
   * How many units a shape needs before it is reported. This is the only thing it changes: lowering
   * it can only add shapes, which is what anyone lowering a threshold expects.
   */
  minRecurrence?: number;
  /**
   * How many alike units it takes to propose a workflow. Deliberately not the recurrence floor:
   * that one applies to the workflow's full support, and a workflow done fifty ways can have no
   * cluster of eight. Measured, tying the two cut the best shape of one known workflow by a third;
   * 5 kept it, while 2 more than doubled the shapes to read and pushed another known workflow far
   * down the list.
   */
  minProposers?: number;
  /**
   * A role touched by fewer units than this is removed before clustering. Each ticket names its own
   * entity, so its `<Entity>.kt` enlarges the union and makes two tickets of one workflow look
   * unrelated. Once derived from the recurrence floor, which made that floor turn three knobs at
   * once: in one measured repository lowering it from 8 to 5 nearly halved the shapes and dropped
   * the most repeated one, because the rarer roles it let back in scattered the clusters.
   */
  rareRoleUnits?: number;
  /** How many roles a shape needs. A two-file pair is a coincidence of layout, not a workflow. */
  minRoles?: number;
  /** How much of a shape's units must touch a role before it is one of the shape's core files. */
  coreShare?: number;
  /** How similar two units must be to land in the same cluster. */
  similarity?: number;
  /** A role this common carries no signal about which workflow a unit belongs to. */
  hubShare?: number;
  /** Two shapes sharing this much of their units are the same workflow seen twice. */
  dedupeOverlap?: number;
  /** How much of a shape's core a unit must touch to count as doing the workflow. */
  containment?: number;
  /** How many distinct numbers a prefix needs before it counts as this history's ticket key. */
  minTicketNumbers?: number;
  /** A unit spanning more days than this, with at least `umbrellaCommits` commits, is an epic, not work. */
  umbrellaDays?: number;
  umbrellaCommits?: number;
  /** Cap on how many shapes to return. */
  limit?: number;
  run?: GitRunner;
}

// Calibrated on a large multi-repository workspace against workflows already written up by hand as
// skills. Similarity 0.5, a unit counted once it touches 80% of a core, and a 0.5 overlap merge
// recovered those workflows about as well as enumerating frequent sets of roles did, at far better
// ranks and with a small fraction of the shapes. Full containment read every core file as N of N,
// which is no file map at all, and cost one of those workflows a third of its tickets. A floor of 8
// rather than 5: on that workspace both left about the same number of shapes and the same share of
// non-workflows among the top twenty.
const MINE_DEFAULTS = {
  minRecurrence: 8,
  minProposers: 5,
  // What the cut was while it was derived, 0.6 of a floor of 8 rounded up, so decoupling it left
  // the calibrated output unchanged.
  rareRoleUnits: 5,
  minRoles: 3,
  coreShare: 0.6,
  similarity: 0.5,
  hubShare: 0.2,
  dedupeOverlap: 0.5,
  containment: 0.8,
  minTicketNumbers: 5,
  limit: 200,
};

const UMBRELLA_DAYS = 180;
const UMBRELLA_COMMITS = 5;

/** Refs to try, in order, when the caller did not name one. */
const PREFERRED_REFS = ["origin/master", "origin/main", "master", "main", "HEAD"];

/**
 * Everything read out of history before any shape is formed. Split out so that a caller trying
 * several thresholds reads the repositories once: reading is most of the cost, and on the largest
 * measured codebase clustering was a small fraction of it.
 */
export interface UnitCollection {
  units: Map<string, WorkUnit>;
  resolver: RoleResolver;
  families: Map<string, string>;
  /** Repositories that were read. */
  repos: number;
  unreadable: UnreadableRepo[];
  commits: number;
  /** Units of any class, including those whose every commit was excluded. */
  allUnits: number;
  authors: number;
  prefixes: Set<string>;
  excludedCommits: Record<string, number>;
  excludedUnits: Record<string, number>;
  readMs: number;
}

/**
 * Mines one or more repositories together. Several is the normal case rather than the exception:
 * the workflows worth writing down are disproportionately the ones that span repositories, and a
 * per-repository run cannot see them at all.
 */
export function mineShapes(repoPaths: string[], options: MineOptions = {}): MineResult {
  return shapesFromUnits(collectUnits(repoPaths, options), options);
}

export function collectUnits(repoPaths: string[], options: MineOptions = {}): UnitCollection {
  const started = Date.now();
  const labels = repoLabels(repoPaths);
  // The salt lives only in this run. An author count is all that leaves the engine, but an
  // unsalted digest of an email address is reversible against a list of colleagues, and this
  // engine is meant to end up in other people's repositories.
  const salt = randomBytes(16);

  const commitsByRepo = new Map<string, RawCommit[]>();
  const unreadable: UnreadableRepo[] = [];
  let commitCount = 0;
  for (const repoPath of repoPaths) {
    const read = readRepository(repoPath, options);
    if ("reason" in read) {
      unreadable.push({ path: repoPath, reason: read.reason });
      continue;
    }
    commitsByRepo.set(labels.get(repoPath)!, read.commits);
    commitCount += read.commits.length;
  }

  const prefixes = learnTicketPrefixes(
    [...commitsByRepo.values()].flatMap((commits) => commits.map((c) => c.subject)),
    options.minTicketNumbers ?? MINE_DEFAULTS.minTicketNumbers,
  );

  const excludedCommits: Record<string, number> = {};
  const units = new Map<string, WorkUnit>();
  const allAuthors = new Set<string>();
  const allPaths = new Set<string>();
  // Keys whose every commit was excluded: the unit never forms, and is counted under the class
  // that excluded most of its commits, so a filter that eats real work shows up by name.
  const excludedOnly = new Map<string, Map<CommitClass, number>>();

  for (const [repo, commits] of commitsByRepo) {
    for (const { commit, key, cls } of assignUnitKeys(commits, repo, prefixes, options)) {
      const author = createHash("sha256").update(salt).update(commit.authorEmail.toLowerCase()).digest("hex");
      allAuthors.add(author);
      if (cls !== "work") {
        excludedCommits[cls] = (excludedCommits[cls] ?? 0) + 1;
        let classes = excludedOnly.get(key);
        if (!classes) excludedOnly.set(key, (classes = new Map()));
        classes.set(cls, (classes.get(cls) ?? 0) + 1);
        continue;
      }
      for (const f of commit.files) allPaths.add(f.path);
      let unit = units.get(key);
      if (!unit) {
        unit = {
          key,
          files: new Map(),
          created: new Map(),
          authors: new Set(),
          subjects: [],
          conventionalTypes: new Set(),
          commits: 0,
          firstAt: commit.date,
          lastAt: commit.date,
          touchesTest: false,
        };
        units.set(key, unit);
      }
      let inRepo = unit.files.get(repo);
      if (!inRepo) unit.files.set(repo, (inRepo = new Set()));
      for (const f of commit.files) {
        inRepo.add(f.path);
        if (f.status === "A") {
          let created = unit.created.get(repo);
          if (!created) unit.created.set(repo, (created = new Set()));
          created.add(f.path);
        }
        if (TEST.test(f.path)) unit.touchesTest = true;
      }
      unit.authors.add(author);
      unit.subjects.push(commit.subject);
      const conventional = conventionalParts(commit.subject);
      if (conventional) unit.conventionalTypes.add(conventional.type);
      unit.commits++;
      if (commit.date < unit.firstAt) unit.firstAt = commit.date;
      if (commit.date > unit.lastAt) unit.lastAt = commit.date;
    }
  }

  const excludedUnits: Record<string, number> = {};
  // A key that keeps collecting commits for half a year names an epic or a long-lived cleanup, not
  // a piece of work: one measured ticket held hundreds of commits. Rare, but large, and a unit that
  // touched everything counts as doing every workflow, so it is set aside and counted rather than
  // left to inflate every shape's support.
  const umbrellaDays = options.umbrellaDays ?? UMBRELLA_DAYS;
  const umbrellaCommits = options.umbrellaCommits ?? UMBRELLA_COMMITS;
  for (const [key, unit] of units) {
    const days = (Date.parse(unit.lastAt) - Date.parse(unit.firstAt)) / 86_400_000;
    if (days > umbrellaDays && unit.commits >= umbrellaCommits) {
      units.delete(key);
      excludedUnits.umbrella = (excludedUnits.umbrella ?? 0) + 1;
    }
  }
  let excludedOnlyUnits = 0;
  for (const [key, classes] of excludedOnly) {
    if (units.has(key)) continue;
    excludedOnlyUnits++;
    const [top] = [...classes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    excludedUnits[top] = (excludedUnits[top] ?? 0) + 1;
  }

  return {
    units,
    resolver: buildRoleResolver(allPaths, options),
    families: repoFamilies(labels.values()),
    repos: commitsByRepo.size,
    unreadable,
    commits: commitCount,
    allUnits: units.size + excludedOnlyUnits + (excludedUnits.umbrella ?? 0),
    authors: allAuthors.size,
    prefixes,
    excludedCommits,
    excludedUnits,
    readMs: Date.now() - started,
  };
}

export function shapesFromUnits(collection: UnitCollection, options: MineOptions = {}): MineResult {
  const started = Date.now();
  const o = { ...MINE_DEFAULTS, ...options };
  const { units, resolver, families } = collection;
  const excludedUnits = { ...collection.excludedUnits };
  const excludedShapes: Record<string, number> = {};
  const largestCluster: Record<string, number> = {};
  const shapes: Shape[] = [];
  const unitList = [...units.values()];
  let workUnitsMultiRepo = 0;
  for (const unit of unitList) if (unit.files.size > 1) workUnitsMultiRepo++;

  for (const view of ["repo", "family"] as const) {
    const roleSets = new Map<string, Set<string>>();
    for (const unit of unitList) {
      const roles = rolesOf(unit, resolver, view === "family" ? families : null);
      if (roles.size === 0) {
        if (view === "repo") excludedUnits["no-role"] = (excludedUnits["no-role"] ?? 0) + 1;
        continue;
      }
      roleSets.set(unit.key, roles);
    }
    dropRareRoles(roleSets, o.rareRoleUnits);
    const clusters = clusterUnits(roleSets, o);
    largestCluster[view] = clusters.reduce((max, c) => Math.max(max, c.length), 0);
    const unitsByRole = new Map<string, Set<string>>();
    for (const [key, roles] of roleSets) {
      for (const role of roles) {
        let at = unitsByRole.get(role);
        if (!at) unitsByRole.set(role, (at = new Set()));
        at.add(key);
      }
    }
    const nameOf = (repo: string) => (view === "family" ? families.get(repo) ?? repo : repo);
    for (const cluster of clusters) {
      const shape = buildShape(cluster, units, roleSets, unitsByRole, resolver, nameOf, view, o, excludedShapes);
      if (shape) shapes.push(shape);
    }
  }

  const ranked = dedupeShapes(shapes.sort(compareShapes), o.dedupeOverlap, excludedShapes);
  const withheld = redactSubjects(ranked);

  return {
    version: 1,
    shapes: ranked.slice(0, o.limit),
    stats: {
      repos: collection.repos,
      unreadableRepos: collection.unreadable,
      commits: collection.commits,
      units: collection.allUnits,
      workUnits: unitList.length,
      workUnitsMultiRepo,
      excludedCommits: collection.excludedCommits,
      excludedUnits,
      excludedShapes,
      authors: collection.authors,
      largestCluster,
      subjectsWithheld: withheld,
      mirrors: [...resolver.mirrors].sort(),
      ticketPrefixes: [...collection.prefixes].sort(),
      shapesBeforeLimit: ranked.length,
      elapsedMs: collection.readMs + (Date.now() - started),
    },
  };
}

export interface UnreadableRepo {
  /** The path exactly as the caller gave it. */
  path: string;
  reason: string;
}

/**
 * One repository's commits, or why there are none. One unreadable directory among many must not
 * throw away everything read from the rest: a run over dozens of repositories takes minutes, and
 * the error git gives does not say which directory it came from.
 */
function readRepository(repoPath: string, options: MineOptions): { commits: RawCommit[] } | { reason: string } {
  const ref = options.ref ?? resolveRef(repoPath, PREFERRED_REFS, { run: options.run });
  if (!ref) {
    return {
      reason: isRepository(repoPath, { run: options.run })
        ? `no commits on any of ${PREFERRED_REFS.join(", ")}`
        : "not a git repository",
    };
  }
  try {
    return { commits: readCommits(repoPath, { ref, since: options.since, noRenames: options.noRenames, run: options.run }) };
  } catch (error) {
    return { reason: gitFailure(error) };
  }
}

interface KeyedCommit {
  commit: RawCommit;
  key: string;
  cls: CommitClass;
}

/**
 * Gives every commit the key of the work it belongs to. Most carry their key in the subject. The
 * rest are reached through the merge that brought them in: git records a branch name only in the
 * merge subject, so the key travels backwards from the merge down its second parent.
 */
function assignUnitKeys(
  commits: RawCommit[],
  repo: string,
  prefixes: Set<string>,
  options: ClassifyOptions & { filters?: boolean },
): KeyedCommit[] {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const keys = new Map<string, string>();
  for (const commit of commits) {
    const key = unitKeyOf(commit, repo, prefixes);
    if (key) keys.set(commit.sha, key);
  }
  // The walked ref's own first-parent line. A branch's commits are never on it, so reaching it is
  // where a branch ends. Without that stop, a history whose commits carry no keys at all would have
  // the walk run down the mainline and label two hundred unrelated commits with one branch's key.
  // The tip is the one commit nothing else names as a parent. Not simply the first one printed: git
  // orders by date, and a commit with a skewed clock can print ahead of the tip.
  const parents = new Set(commits.flatMap((c) => c.parents));
  const tip = commits.find((c) => !parents.has(c.sha))?.sha;
  const mainline = new Set<string>();
  for (let sha: string | undefined = tip; sha && !mainline.has(sha); sha = bySha.get(sha)?.parents[0]) {
    mainline.add(sha);
  }
  for (const commit of commits) {
    if (commit.parents.length < 2) continue;
    const branch = mergedBranchName(commit.subject);
    if (!branch) continue;
    const key = unitKeyOf({ ...commit, subject: branch }, repo, prefixes);
    if (!key) continue;
    // The branch's own commits are its first-parent line back from the merged tip. The walk stops
    // at the mainline, at another merge (a sync from the target branch, whose parents are not this
    // branch's work), and at a commit already claimed by a different key.
    let sha: string | undefined = commit.parents[1];
    for (let steps = 0; sha && steps < MERGE_WALK_LIMIT; steps++) {
      const branchCommit = bySha.get(sha);
      if (!branchCommit || mainline.has(sha) || branchCommit.parents.length > 1) break;
      const own = keys.get(sha);
      if (own && own !== key) break;
      keys.set(sha, key);
      sha = branchCommit.parents[0];
    }
  }
  return commits.map((commit) => ({
    commit,
    // A commit nobody can group is still a piece of work, so it becomes a unit of its own rather
    // than being dropped. It will not reach a shape unless the same file set repeats without keys.
    key: keys.get(commit.sha) ?? `${repo}@${commit.sha.slice(0, 12)}`,
    cls: options.filters === false ? unfilteredClass(commit) : classifyCommit(commit, options),
  }));
}

/** With the filters off only what carries no files at all is set aside. */
function unfilteredClass(commit: RawCommit): CommitClass {
  if (commit.parents.length > 1) return "merge";
  return commit.files.length ? "work" : "empty";
}

/** How far back from a merge a branch's own commits are looked for. */
const MERGE_WALK_LIMIT = 200;

function rolesOf(unit: WorkUnit, resolver: RoleResolver, families: Map<string, string> | null): Set<string> {
  const roles = new Set<string>();
  for (const [repo, paths] of unit.files) {
    const name = families?.get(repo) ?? repo;
    for (const path of paths) {
      const role = resolver(path);
      if (IGNORED_ROLES.has(role)) continue;
      roles.add(`${name}:${role}`);
    }
  }
  return roles;
}

/**
 * Groups units whose role sets are alike.
 *
 * Leader clustering with an average-linkage test, rather than the single-linkage joining that a
 * plain similarity threshold gives you. Single linkage chains: a unit close to one member joins
 * the cluster however far it sits from the rest, and with files that nearly every piece of work
 * touches, one cluster ends up swallowing the history. Averaging over the members it is joining
 * makes a unit earn its place against the group rather than against its nearest neighbour.
 *
 * Clusters only propose workflows; `buildShape` then counts every unit that does one, so a unit
 * can support several shapes. Proposing from clusters rather than enumerating every frequent set
 * of roles is what keeps the candidates few: enumeration produced more distinct shapes than there
 * were units in the history, most of them the same workflow minus one file.
 */
export function clusterUnits(
  roleSets: Map<string, Set<string>>,
  options: { similarity?: number; hubShare?: number } = {},
): string[][] {
  const similarity = options.similarity ?? MINE_DEFAULTS.similarity;
  const hubShare = options.hubShare ?? MINE_DEFAULTS.hubShare;
  const frequency = new Map<string, number>();
  for (const roles of roleSets.values()) for (const role of roles) frequency.set(role, (frequency.get(role) ?? 0) + 1);
  const hubLimit = hubShare * roleSets.size;

  // Largest role sets first, so a cluster forms around a full example of the workflow rather than
  // around whichever partial one happened to be read first; ties break on the key so that two runs
  // over the same history return the same clusters.
  const order = [...roleSets.keys()].sort((a, b) => {
    const size = roleSets.get(b)!.size - roleSets.get(a)!.size;
    return size !== 0 ? size : a < b ? -1 : 1;
  });

  const clusters: string[][] = [];
  const index = new Map<string, Set<number>>();
  for (const key of order) {
    const roles = roleSets.get(key)!;
    const distinctive = [...roles].filter((role) => (frequency.get(role) ?? 0) <= hubLimit);
    // A unit made only of files everything touches has no distinctive role to look under. Falling
    // back to all of its roles keeps it from silently becoming its own cluster every time.
    const lookup = distinctive.length ? distinctive : [...roles];
    const candidates = new Set<number>();
    for (const role of lookup) for (const c of index.get(role) ?? []) candidates.add(c);

    let best = -1;
    let bestScore = similarity;
    for (const c of candidates) {
      const score = averageJaccard(roles, clusters[c]!, roleSets);
      if (score >= bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best === -1) {
      clusters.push([key]);
      best = clusters.length - 1;
    } else {
      clusters[best]!.push(key);
    }
    for (const role of lookup) {
      let at = index.get(role);
      if (!at) index.set(role, (at = new Set()));
      at.add(best);
    }
  }
  return clusters;
}

/** Removes roles too rare to say which workflow a unit belongs to; `rareRoleUnits` says why. */
function dropRareRoles(roleSets: Map<string, Set<string>>, minUnits: number): void {
  const frequency = new Map<string, number>();
  for (const roles of roleSets.values()) for (const role of roles) frequency.set(role, (frequency.get(role) ?? 0) + 1);
  for (const [key, roles] of roleSets) {
    for (const role of roles) if ((frequency.get(role) ?? 0) < minUnits) roles.delete(role);
    if (roles.size === 0) roleSets.delete(key);
  }
}

/** How many members an average-linkage test reads. Enough to be stable, bounded so a huge cluster stays cheap. */
const LINKAGE_SAMPLE = 40;

function averageJaccard(roles: Set<string>, members: string[], roleSets: Map<string, Set<string>>): number {
  const sample = members.length <= LINKAGE_SAMPLE ? members : members.slice(0, LINKAGE_SAMPLE);
  let total = 0;
  for (const member of sample) total += jaccard(roles, roleSets.get(member)!);
  return total / sample.length;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

function buildShape(
  cluster: string[],
  units: Map<string, WorkUnit>,
  roleSets: Map<string, Set<string>>,
  unitsByRole: Map<string, Set<string>>,
  resolver: RoleResolver,
  nameOf: (repo: string) => string,
  view: "repo" | "family",
  o: typeof MINE_DEFAULTS,
  excludedShapes: Record<string, number>,
): Shape | null {
  if (cluster.length < o.minProposers) {
    excludedShapes["too-few-proposers"] = (excludedShapes["too-few-proposers"] ?? 0) + 1;
    return null;
  }
  const proposed = coreOf(cluster, roleSets, o.coreShare);
  if (proposed.length < o.minRoles) {
    excludedShapes["below-roles"] = (excludedShapes["below-roles"] ?? 0) + 1;
    return null;
  }
  // The cluster only PROPOSES the workflow. Its members are every unit that does the workflow,
  // wherever clustering happened to put it: a partition gives each unit one cluster, and a large
  // workflow done a dozen slightly different ways ends up split across a dozen of them, each too
  // small to show how often the work really happens. Measured on the largest history, this is what
  // held recall on the two biggest known workflows down to a third.
  const memberKeys = supportOf(proposed, unitsByRole, o.containment);
  if (memberKeys.length < o.minRecurrence) {
    excludedShapes["below-recurrence"] = (excludedShapes["below-recurrence"] ?? 0) + 1;
    return null;
  }
  const core = coreOf(memberKeys, roleSets, o.coreShare).filter((role) => proposed.includes(role));
  if (core.length < o.minRoles) {
    excludedShapes["below-roles"] = (excludedShapes["below-roles"] ?? 0) + 1;
    return null;
  }

  const members = memberKeys.map((key) => units.get(key)!);
  const coreRoles = new Set(core);
  const counts = new Map<string, number>();
  for (const key of memberKeys) for (const role of roleSets.get(key)!) if (coreRoles.has(role)) counts.set(role, (counts.get(role) ?? 0) + 1);
  const examples = new Map<string, string[]>();
  for (const unit of members) {
    for (const [repo, paths] of unit.files) {
      for (const path of paths) {
        const role = `${nameOf(repo)}:${resolver(path)}`;
        if (!coreRoles.has(role)) continue;
        const seen = examples.get(role) ?? [];
        const example = `${repo}/${path}`;
        if (seen.length < 2 && !seen.includes(example)) seen.push(example);
        examples.set(role, seen);
      }
    }
  }

  const repos = new Set<string>();
  const authors = new Set<string>();
  let firstAt = members[0]!.firstAt;
  let lastAt = members[0]!.lastAt;
  let testUnits = 0;
  for (const unit of members) {
    for (const repo of unit.files.keys()) repos.add(repo);
    for (const author of unit.authors) authors.add(author);
    if (unit.firstAt < firstAt) firstAt = unit.firstAt;
    if (unit.lastAt > lastAt) lastAt = unit.lastAt;
    if (unit.touchesTest) testUnits++;
  }

  const coreFiles: CoreFile[] = core.map((role) => {
    const n = counts.get(role) ?? 0;
    return { role, units: n, share: Number((n / memberKeys.length).toFixed(2)), examples: examples.get(role) ?? [] };
  });

  return {
    id: createHash("sha256").update(view).update("\u0000").update(core.join("\n")).digest("hex").slice(0, 12),
    view,
    coreFiles,
    repos: [...repos].sort(),
    coreRepos: [...new Set(core.map((role) => role.slice(0, role.indexOf(":"))))].sort(),
    recurrence: memberKeys.length,
    authors: authors.size,
    firstAt,
    lastAt,
    // The subjects are the only place a trigger phrase can come from, so a few are kept, one per
    // unit so that a single chatty ticket cannot fill the list. They are raw user text, and
    // `redactSubjects` is what stands between them and the output file.
    sampleSubjects: [...new Set(members.map((unit) => unit.subjects[0]!))],
    memberUnits: [...memberKeys].sort(),
    testUnits,
  };
}

/** The roles at least `share` of these units touched, most common first. */
function coreOf(keys: string[], roleSets: Map<string, Set<string>>, share: number): string[] {
  const counts = new Map<string, number>();
  for (const key of keys) for (const role of roleSets.get(key)!) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts]
    .filter(([, n]) => n / keys.length >= share)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([role]) => role);
}

/** Every unit that touched at least `containment` of these roles: the workflow's support. */
function supportOf(roles: string[], unitsByRole: Map<string, Set<string>>, containment: number): string[] {
  const needed = Math.max(1, Math.ceil(containment * roles.length));
  const hits = new Map<string, number>();
  for (const role of roles) for (const key of unitsByRole.get(role) ?? []) hits.set(key, (hits.get(key) ?? 0) + 1);
  return [...hits].filter(([, n]) => n >= needed).map(([key]) => key);
}

/**
 * The order a reader should meet these in. Support alone is not selective: at the threshold that a
 * real codebase needs, thousands of shapes clear it. What separates a workflow from a coincidence
 * is that it crosses repositories or files, and that more than one person has done it.
 */
export function compareShapes(a: Shape, b: Shape): number {
  const spread = (s: Shape) => (s.coreRepos.length >= 2 || s.coreFiles.length >= 3 ? 0 : 1);
  const shared = (s: Shape) => (s.authors >= 2 ? 0 : 1);
  return spread(a) - spread(b) || shared(a) - shared(b) || b.recurrence - a.recurrence || (a.id < b.id ? -1 : 1);
}

/**
 * Both repository views describe the same history, so a workflow that both found arrives twice.
 * They are recognised as one by the units they were built from rather than by the roles they
 * report, because the whole difference between the views is how the roles are named.
 */
function dedupeShapes(sorted: Shape[], overlap: number, excludedShapes: Record<string, number>): Shape[] {
  const kept: { shape: Shape; members: Set<string> }[] = [];
  for (const shape of sorted) {
    const members = new Set(shape.memberUnits);
    const duplicate = kept.some(({ members: other }) => jaccard(members, other) >= overlap);
    if (duplicate) {
      excludedShapes["duplicate-view"] = (excludedShapes["duplicate-view"] ?? 0) + 1;
      continue;
    }
    kept.push({ shape, members });
  }
  return kept.map(({ shape }) => shape);
}

/**
 * Commit subjects are untrusted text that a person wrote, and people paste tokens into them. A
 * subject that trips the secret detector is dropped rather than cleaned: the shape keeps its
 * recurrence and its file map, and loses one example sentence.
 *
 * An email address is withheld the same way. Author identity never leaves this engine through the
 * author field, and a subject that credits a contributor by address would carry it out anyway:
 * the largest open-source history measured had such credits among its most repeated shapes.
 */
function redactSubjects(shapes: Shape[]): { secret: number; email: number } {
  const withheld = { secret: 0, email: 0 };
  for (const shape of shapes) {
    const safe: string[] = [];
    for (const subject of shape.sampleSubjects) {
      if (detectSecret(subject) !== null) {
        withheld.secret++;
        continue;
      }
      if (EMAIL.test(subject)) {
        withheld.email++;
        continue;
      }
      if (safe.length < SAMPLE_SUBJECTS) safe.push(subject);
    }
    shape.sampleSubjects = safe;
  }
  return withheld;
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

/** How many commit subjects a shape carries as trigger-phrase evidence. */
const SAMPLE_SUBJECTS = 5;
