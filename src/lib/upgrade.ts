import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { uniqueSlug } from "./distill.js";
import { hostFromUrl, manualPrUrl, openPr, runForge } from "./forge.js";
import type { ForgeRunner } from "./forge.js";
import {
  assertSafeGitUrl,
  gitIdentityArgs,
  pushFailureReason,
  readTeamCommitPrefix,
  teamCommitPrefixFix,
  runGit,
  skeletonFiles,
  teamBranchPrefix,
  teamCommitPrefix,
} from "./init.js";
import type { GitRunner, TeamConfig } from "./init.js";
import { bumpPluginVersion } from "./publish.js";
import { handbookWorkdir } from "./session-state.js";

// Refreshing the scaffold a team received when they ran /handbook:init, in place.
//
// The skeleton keeps growing - the nine files init writes went from 8,600 to 20,000
// characters across the versions since the first repository was scaffolded - and until
// this existed the only route to today's version was /handbook:leave followed by a
// second init, which means a second repository. Every adopter reaches that wall on
// their first plugin upgrade.
//
// Nothing here tries to work out which version wrote the repository. The version in the
// team's plugin.json is the TEAM plugin's version, not TeamHandbook's, so it answers a
// different question; and it does not need answering, because today's skeleton is
// regenerated and compared byte-for-byte against what is there.

export const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";
export const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

/**
 * The one scaffold file that exists for no reason but the scaffold, which is what makes
 * it the honest signal for whether this repository was initialized with `--with-ci`.
 *
 * The CI file itself cannot answer that: a team may keep their own `.gitlab-ci.yml` for
 * reasons that have nothing to do with a handbook, and reading one as "CI was opted in"
 * would offer to overwrite their pipeline with the version-bump job. `bump-version.mjs`
 * only exists to be run by that job, so nothing else puts it there.
 */
const CI_MARKER = "scripts/bump-version.mjs";

/**
 * What belongs to the team rather than to the scaffold, by location. A path matching
 * this is never written, never offered, and never counted, whatever the skeleton emits.
 *
 * Today the guard filters exactly one file, `skills/README.md` - a placeholder init
 * writes and no version has changed. It is written against the boundary rather than
 * against that file because the boundary is what must hold: `skills/` carries the team's
 * approved skills, `commands/` and `agents/` and `.mcp.json` carry what they chose to
 * share, and a refresh that reaches any of them is a refresh that destroys work. If a
 * later skeleton puts a file under one of these, it stays out by construction instead of
 * by someone remembering.
 */
const TEAM_OWNED_DIRS = ["skills/", "commands/", "agents/"];
const TEAM_OWNED_FILES = [".mcp.json"];

export function isTeamOwned(path: string): boolean {
  return TEAM_OWNED_DIRS.some((dir) => path.startsWith(dir)) || TEAM_OWNED_FILES.includes(path);
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The first component of `path`, under `repoDir`, that is a symbolic link, or null when
 * the whole chain is ordinary directories and files.
 *
 * A git repository can commit a symbolic link (mode `120000`), and a clone materializes
 * it as one. `writeFileSync` and `mkdirSync` both FOLLOW a link, so a repository that
 * commits `README.md` as a link to something in the reader's home directory turns a read
 * of that repository into a write to their home - measured, on the plan path, with no
 * approval given and "Nothing has been changed" printed underneath. Nothing in the
 * scaffold is a link, so a link on a scaffold path is never a file this can refresh: it
 * is dropped, and said out loud.
 */
export function symlinkOnPath(repoDir: string, path: string): string | null {
  let current = repoDir;
  for (const part of path.split("/")) {
    current = join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null; // absent, so nothing below it exists to follow either
    }
    if (stat.isSymbolicLink()) return relative(repoDir, current);
  }
  return null;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The plugin manifest to write: today's fields over the repository's own, with the
 * version left exactly as the team has it.
 *
 * That number is the team's refresh signal - Claude Code re-reads a marketplace when the
 * version moves - so regenerating the manifest wholesale would reset a repository at
 * 0.3.4 back to 0.1.0 and stop every teammate's copy updating. The merge direction also
 * keeps fields the skeleton never wrote: a team that added `author` or `homepage` keeps
 * them, because a refresh of the scaffold is not a licence to delete what they put there.
 *
 * Returns null when the existing manifest cannot be parsed. There is no version to carry
 * across in that case, and guessing one is the failure this function exists to prevent.
 */
export function mergePluginManifest(existing: string | null, fresh: string): string | null {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh) as Record<string, unknown>;
  const merged = { ...current, ...next };
  if (typeof current.version === "string") merged.version = current.version;
  return JSON.stringify(merged, null, 2) + "\n";
}

/** The scaffold's own entry in a marketplace: the plugin served from the repository root. */
function isOwnPlugin(entry: unknown): entry is Record<string, unknown> {
  return typeof entry === "object" && entry !== null && (entry as { source?: unknown }).source === "./";
}

/**
 * The marketplace manifest to write: the scaffold refreshes its OWN plugin entry and
 * nothing else in the file.
 *
 * A `plugins[]` entry the team added is the team's content as surely as a skill is - it
 * is how a second plugin reaches everyone subscribed - and `owner` is who to contact.
 * Regenerating the file wholesale deleted both, measured: a team's second plugin and
 * their guild's address disappeared into a merge request titled "refresh the scaffold",
 * under a plan that had just promised the team's own content was never part of this. The
 * reasoning `mergePluginManifest` carries applies here word for word, and it had been
 * applied to one of the two manifests and not the other for no reason anybody wrote down.
 *
 * Null on an unparseable manifest, for the same reason as the plugin one: the entries to
 * carry across cannot be read, so nothing is offered rather than something guessed.
 */
export function mergeMarketplaceManifest(existing: string | null, fresh: string): string | null {
  if (existing === null) return fresh;
  const current = parseObject(existing);
  if (!current) return null;
  const next = JSON.parse(fresh) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  // Anything the scaffold ships that the repository does not have yet is added; anything
  // it already has is the team's answer to that question and is left alone.
  for (const [key, value] of Object.entries(next)) if (!(key in merged)) merged[key] = value;
  const own = (next.plugins as unknown[] | undefined)?.find(isOwnPlugin);
  if (Array.isArray(current.plugins) && own) {
    let found = false;
    const kept = current.plugins.map((entry) => {
      if (!isOwnPlugin(entry)) return entry;
      found = true;
      return { ...entry, ...own };
    });
    merged.plugins = found ? kept : [...current.plugins, own];
  }
  return JSON.stringify(merged, null, 2) + "\n";
}

const PREFIX_PROBE = "ZZTEAMHANDBOOKPREFIXPROBEZZ";

/**
 * Whether this machine can reproduce the commit-message prefix the scaffold was written
 * with.
 *
 * `/handbook:join` now reads the prefix out of the repository, but only a repository
 * scaffolded since that record existed HAS one to give: on a teammate who joined an older
 * handbook, an absent `commitPrefix` still does not mean "there is no prefix" - it means
 * nobody here knows. Join writes an absent key rather than "" for exactly this reason. Reading it as the empty string regenerates the CI job
 * without the team's prefix, and measured, that is exactly what happened: the founder's
 * machine said "Nothing to refresh" while a teammate's offered to rewrite
 * `git commit -am "TEAM-1ci: bump plugin version"` into `git commit -am "ci: bump plugin
 * version"`. Merged, the group rule that the prefix exists to satisfy then rejects every
 * version bump, no teammate's copy refreshes again, and the refresh has caused the
 * disease it exists to cure.
 *
 * `initializedAt` is the positive signal, because only `/handbook:init` sets it and only
 * `/handbook:init` was ever in a position to know the answer.
 */
export function commitPrefixIsKnown(team: TeamConfig): boolean {
  if (typeof team.commitPrefix === "string") return true;
  return !!team.initializedAt;
}

/**
 * The skeleton files whose contents depend on the commit prefix, found by generating the
 * skeleton twice and comparing rather than by naming them here. A later skeleton that
 * puts the prefix somewhere new is covered without anyone remembering to update a list.
 */
function prefixDependentPaths(team: TeamConfig, withCi: boolean): Set<string> {
  const host = hostFromUrl(team.repoUrl);
  const plain = skeletonFiles(team.marketplaceName, team.repoUrl, host, "", withCi);
  const probed = skeletonFiles(team.marketplaceName, team.repoUrl, host, PREFIX_PROBE, withCi);
  return new Set(Object.keys(plain).filter((path) => plain[path] !== probed[path]));
}

/** A scaffold file this machine is not in a position to offer, and why. */
export interface WithheldFile {
  path: string;
  reason: string;
}

export interface CandidateSet {
  /** Path to the contents a refresh would write: the whole writable surface, and the only one. */
  files: Record<string, string>;
  /** Left out because the repository carries a symbolic link on that path. */
  linked: WithheldFile[];
  /** Left out because a value the skeleton needs is not knowable on this machine. */
  withheld: WithheldFile[];
}

/**
 * Today's skeleton for this repository, as file contents keyed by path: what the files
 * would be if the team ran init now, minus everything the team owns, everything a
 * symbolic link sits on, and everything this machine cannot honestly regenerate.
 *
 * `commitPrefix` is passed raw: the prefix reaches the skeleton only inside the CI job's
 * own commit message, and `skeletonFiles` is the one place that formats it, so init and
 * this comparison cannot drift apart the way they did while each glued the prefix on
 * itself. A repository scaffolded before that formatting was fixed does report its CI
 * file as stale, which is what the file being out of date means.
 */
export function upgradeCandidates(repoDir: string, team: TeamConfig): CandidateSet {
  const withCi = existsSync(join(repoDir, CI_MARKER));
  // The repository is asked before this machine is written off as not knowing. A teammate
  // who joined before the handbook recorded its prefix has nothing in their config, but the
  // repository they are refreshing may have been given the record since - and regenerating
  // a file FROM that record cannot drop the prefix, which is the only thing withholding
  // protects against. Without this the very file carrying the answer would be withheld for
  // not knowing the answer.
  const recorded = commitPrefixIsKnown(team) ? undefined : readTeamCommitPrefix(repoDir).prefix;
  const prefix = recorded ?? team.commitPrefix?.trim() ?? "";
  const generated = skeletonFiles(team.marketplaceName, team.repoUrl, hostFromUrl(team.repoUrl), prefix, withCi);
  const known = commitPrefixIsKnown(team) || recorded !== undefined;
  const unknownPrefix = known ? new Set<string>() : prefixDependentPaths(team, withCi);
  const files: Record<string, string> = {};
  const linked: WithheldFile[] = [];
  const withheld: WithheldFile[] = [];
  for (const [path, content] of Object.entries(generated)) {
    if (isTeamOwned(path)) continue;
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      linked.push({
        path,
        reason:
          `the repository carries a symbolic link at "${link}". Nothing in the scaffold is a link, so ` +
          "this is not a file a refresh can write, and following it would write outside the repository.",
      });
      continue;
    }
    if (unknownPrefix.has(path)) {
      withheld.push({
        path,
        reason:
          "it embeds the team's commit-message prefix, and neither this machine nor the repository " +
          "records what it is - only the machine that ran /handbook:init was ever told. Regenerating " +
          "it here would write the file with no prefix at all, which is a different answer from the " +
          "team's, so it is not offered on this machine.",
      });
      continue;
    }
    const merged =
      path === PLUGIN_MANIFEST
        ? mergePluginManifest(readIfPresent(join(repoDir, path)), content)
        : path === MARKETPLACE_MANIFEST
          ? mergeMarketplaceManifest(readIfPresent(join(repoDir, path)), content)
          : content;
    if (merged !== null) files[path] = merged;
  }
  return { files, linked, withheld };
}

/**
 * `absent` is a file this version ships that the repository has never had; `differs` is
 * one whose bytes do not match. Nothing distinguishes an upgrade from an edit the team
 * made by hand, because nothing can: the version that wrote the file is not recorded
 * anywhere, and `writeSkeletonPreserving` deliberately skips a file the repository
 * already had, so a README the team wrote at init has read as `differs` since the day it
 * was created. The diff is the only evidence, which is why the diff is what gets shown.
 */
export type SkeletonState = "current" | "absent" | "differs";

export interface SkeletonFileState {
  path: string;
  state: SkeletonState;
}

/** What a refresh would do to the plugin version, decided before anything is written. */
export interface VersionPlan {
  current?: string;
  next?: string;
  /** Why no raise is possible, when none is. */
  blocked?: string;
}

export interface UpgradePlan {
  ok: boolean;
  error?: string;
  url?: string;
  files?: SkeletonFileState[];
  /** `git diff` of every refreshable file against what the repository has today. */
  diff?: string;
  stat?: string;
  withCi?: boolean;
  version?: VersionPlan;
  /** Manifests that could not be parsed, so what the team put in them could not be read. */
  unreadable?: string[];
  linked?: WithheldFile[];
  withheld?: WithheldFile[];
  /** Paths the team repository's own `.gitignore` keeps out, so the diff under-reports them. */
  ignored?: string[];
}

export interface UpgradeResult {
  ok: boolean;
  error?: string;
  url?: string;
  refreshed?: string[];
  branch?: string;
  version?: string;
  /** Set when the merge request could not raise the plugin version, with the reason. */
  versionNotRaised?: string;
  prUrl?: string;
  manualUrl?: string;
  prError?: string;
}

function classify(repoDir: string, candidates: Record<string, string>): SkeletonFileState[] {
  return Object.entries(candidates).map(([path, content]) => {
    const existing = readIfPresent(join(repoDir, path));
    if (existing === null) return { path, state: "absent" as const };
    return { path, state: existing === content ? ("current" as const) : ("differs" as const) };
  });
}

export function refreshable(files: SkeletonFileState[]): string[] {
  return files.filter((file) => file.state !== "current").map((file) => file.path);
}

/** A manifest that is in the repository but not among the candidates BECAUSE the merge
 * could not parse it. A manifest already withheld for another reason is excluded rather
 * than reported twice under a reason that is not the one that applies - and a symlinked
 * one would read as parseable here, because `readIfPresent` follows the link. */
function unreadableManifests(repoDir: string, candidates: CandidateSet): string[] {
  const explained = new Set([...candidates.linked, ...candidates.withheld].map((file) => file.path));
  return [PLUGIN_MANIFEST, MARKETPLACE_MANIFEST].filter(
    (path) =>
      !(path in candidates.files) && !explained.has(path) && readIfPresent(join(repoDir, path)) !== null,
  );
}

/**
 * What the refresh would do to the plugin version, decided from what is actually there
 * rather than from what is usually there.
 *
 * `bumpPluginVersion` raises the patch of a three-part number and returns null for
 * anything else, which meant a repository at `1.2.3-beta` was told "it is raised, never
 * reset" while no raise happened at all: a merge request merged, no teammate's copy
 * refreshed, and no line anywhere saying why. A repository with no version field was told
 * nothing and had `0.1.1` invented and committed into a file the reader may not have
 * chosen. The plan and the commit now agree because both read this.
 */
export function versionPlan(repoDir: string): VersionPlan {
  const raw = readIfPresent(join(repoDir, PLUGIN_MANIFEST));
  const manifest = raw === null ? null : parseObject(raw);
  const current = manifest && typeof manifest.version === "string" ? manifest.version : undefined;
  if (!current) {
    return {
      blocked:
        `${PLUGIN_MANIFEST} in this repository declares no version this can read, so the refresh cannot ` +
        "raise one and no teammate's copy will pick it up. Refreshing that file itself puts a version " +
        "there, and every refresh after it raises that.",
    };
  }
  const parts = current.split(".").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    return {
      current,
      blocked:
        `the plugin version "${current}" is not a three-part MAJOR.MINOR.PATCH number, so it cannot be ` +
        "raised - and without a raise, no teammate's copy refreshes for this. Set a three-part version in " +
        `${PLUGIN_MANIFEST} by hand first.`,
    };
  }
  return { current, next: [parts[0], parts[1], (parts[2] ?? 0) + 1].join(".") };
}

function cloneForUpgrade(git: GitRunner, team: TeamConfig, repoDir: string, workdir: string): string | null {
  try {
    git(["clone", "--depth", "1", "--", team.repoUrl, repoDir], workdir);
  } catch (err) {
    return `git clone failed (is ${team.repoUrl} reachable?): ${String(err instanceof Error ? err.message : err)}`;
  }
  // A repository with no marketplace manifest was never scaffolded as a handbook, whatever
  // the config says. Laying nine files into it would be writing a scaffold into a stranger's
  // repository from a binding that is simply wrong - so this refuses instead of repairing,
  // and names the command that scaffolds on purpose.
  if (!existsSync(join(repoDir, MARKETPLACE_MANIFEST))) {
    return (
      `${team.repoUrl} carries no ${MARKETPLACE_MANIFEST}, so it is not a handbook this can refresh. ` +
      "Check the repository in your config, or run /handbook:init against a repository that should become one."
    );
  }
  return null;
}

/**
 * Write the selected candidates into the clone's working tree, refusing before the first
 * byte if anything on any of their paths is a symbolic link.
 *
 * `upgradeCandidates` has already dropped a linked path, so this is a second guard on the
 * same hazard rather than the only one. It is here because this is the function that
 * calls `writeFileSync`, and a guard that lives anywhere but at the write is one the next
 * caller can forget to ask for.
 */
function writeCandidates(repoDir: string, candidates: Record<string, string>, paths: string[]): string | null {
  for (const path of paths) {
    const link = symlinkOnPath(repoDir, path);
    if (link) {
      return (
        `"${path}" cannot be written: the repository carries a symbolic link at "${link}", and following ` +
        "it would write outside the repository. Nothing was changed."
      );
    }
  }
  for (const path of paths) {
    const target = join(repoDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, candidates[path]!);
  }
  return null;
}

/**
 * Stage the written candidates and report any that git did not take.
 *
 * `git add -A` obeys the TEAM repository's own `.gitignore`, and a handbook that ignores
 * `scripts/` or `*.yml` for reasons of its own would have a scaffold file written to the
 * working tree, silently left out of the commit, and still reported as refreshed. A
 * written file that is not staged is the one thing the result cannot see any other way,
 * so it is read back from the index rather than assumed.
 *
 * It is read back rather than forced in with `git add -f`: an ignore rule is something
 * the team wrote on purpose, and overriding it quietly is the same class of mistake as
 * overwriting a file they edited.
 */
function stage(git: GitRunner, repoDir: string, paths: string[]): { missing: string[] } {
  git(["add", "-A"], repoDir);
  const staged = new Set(
    String(git(["diff", "--cached", "--name-only"], repoDir) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return { missing: paths.filter((path) => !staged.has(path)) };
}

function ignoredPathsMessage(missing: string[]): string {
  return (
    `${missing.join(", ")} cannot be committed to this repository - git refused to stage ` +
    "it, which a `.gitignore` rule in the team repo is what normally does. Nothing was " +
    "changed. Take that path out of the repository's .gitignore, or leave it out of the refresh."
  );
}

/** The index mode git already records for each path, so a refreshed file does not show a
 * spurious mode change alongside its content. */
function trackedModes(git: GitRunner, repoDir: string): Map<string, string> {
  const modes = new Map<string, string>();
  try {
    for (const line of String(git(["ls-files", "--stage"], repoDir) ?? "").split("\n")) {
      const match = line.match(/^(\d{6}) [0-9a-f]+ \d\t(.*)$/);
      if (match) modes.set(match[2]!, match[1]!);
    }
  } catch {
    // an empty map simply means every refreshed file is staged as an ordinary file
  }
  return modes;
}

/** Which of these paths the team repository's own `.gitignore` would keep out. Advisory:
 * the answer that stops a refresh is taken from the index at commit time, in `stage`. */
function checkIgnore(git: GitRunner, repoDir: string, paths: string[]): string[] {
  try {
    return String(git(["check-ignore", "--", ...paths], repoDir) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // git exits non-zero when nothing matches, which is the ordinary case
    return [];
  }
}

/**
 * What a refresh would change, without changing anything.
 *
 * The diff is rendered by git rather than by a hand-written differ, but NOTHING is
 * written into the repository's working tree to get it. The candidate bytes go to a
 * scratch directory this function creates inside its own workdir, git hashes them into
 * the throwaway clone's object store, and the clone's INDEX alone is updated - so the
 * output is a real `git diff --cached` against HEAD while the working tree is untouched.
 *
 * The first shape of this wrote the candidates into the working tree and staged them.
 * That reads harmlessly until a repository commits one of those paths as a symbolic link,
 * at which point a plan run - the path documented as writing nothing, before any approval
 * - wrote through the link and overwrote a file in the reader's home directory, then
 * printed "Nothing has been changed". The scratch directory is created here and holds
 * nothing but these files, so there is no link for a write to follow.
 */
export function planUpgrade(team: TeamConfig, git: GitRunner = runGit): UpgradePlan {
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join(workdir, "repo");
  const scratch = join(workdir, "candidate");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const candidates = upgradeCandidates(repoDir, team);
    const files = classify(repoDir, candidates.files);
    const paths = refreshable(files);
    const unreadable = unreadableManifests(repoDir, candidates);
    const plan: UpgradePlan = {
      ok: true,
      url: team.repoUrl,
      files,
      withCi: existsSync(join(repoDir, CI_MARKER)),
      version: versionPlan(repoDir),
      ...(candidates.linked.length ? { linked: candidates.linked } : {}),
      ...(candidates.withheld.length ? { withheld: candidates.withheld } : {}),
      ...(unreadable.length ? { unreadable } : {}),
    };
    if (!paths.length) return plan;
    try {
      // Asked BEFORE the index is touched, because `git check-ignore` deliberately says
      // nothing about a path that is already in the index - staging first turned the one
      // question this answers into a silent "nothing is ignored".
      const ignored = checkIgnore(git, repoDir, paths);
      if (ignored.length) plan.ignored = ignored;
      const modes = trackedModes(git, repoDir);
      const cacheinfo: string[] = [];
      for (const path of paths) {
        const file = join(scratch, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, candidates.files[path]!);
        const sha = String(git(["hash-object", "-w", "--", file], repoDir) ?? "").trim();
        cacheinfo.push("--cacheinfo", `${modes.get(path) ?? "100644"},${sha},${path}`);
      }
      git(["update-index", "--add", ...cacheinfo], repoDir);
      plan.stat = String(git(["diff", "--cached", "--stat"], repoDir) ?? "").trimEnd();
      plan.diff = String(git(["diff", "--cached"], repoDir) ?? "");
    } catch {
      // The states above are read from the filesystem and stand on their own; a diff that
      // cannot be rendered costs presentation, not the answer.
    }
    return plan;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function remoteBranches(git: GitRunner, repoDir: string): Set<string> {
  try {
    return new Set(
      String(git(["ls-remote", "--heads", "origin"], repoDir) ?? "")
        .split("\n")
        .map((line) => line.split("\t")[1] ?? "")
        .filter(Boolean)
        .map((ref) => ref.replace("refs/heads/", "")),
    );
  } catch {
    return new Set<string>();
  }
}

/**
 * Refresh exactly the named files, as one merge request.
 *
 * `paths` is the approval, and it is the approval in code rather than in an instruction
 * to be careful: an empty selection writes nothing and makes no network call, and a path
 * the skeleton did not produce is refused by name before the clone is touched. Selecting
 * per file is the requirement, not a convenience - `hooks/notice.mjs` is the file a team
 * is most likely to have edited, and replacing the set wholesale would take that edit
 * with it.
 *
 * All of it or none of it: the selected files travel in one commit on one branch, so a
 * push that is refused leaves the repository exactly as it was.
 */
export function applyUpgrade(
  team: TeamConfig,
  paths: string[],
  git: GitRunner = runGit,
  forge: ForgeRunner = runForge,
): UpgradeResult {
  if (!paths.length) {
    return { ok: false, error: "no file was named, so nothing was refreshed and nothing was pushed" };
  }
  try {
    assertSafeGitUrl(team.repoUrl);
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err) };
  }
  const identity = gitIdentityArgs(git);
  if (!identity) {
    return {
      ok: false,
      error:
        "git user.name/user.email is not set - the refresh commit would have an author your forge " +
        'is likely to reject. Run `git config --global user.name "Your Name"` and ' +
        "`git config --global user.email you@example.com`, then try again.",
    };
  }
  const workdir = handbookWorkdir("handbook-upgrade-");
  const repoDir = join(workdir, "repo");
  try {
    const cloneError = cloneForUpgrade(git, team, repoDir, workdir);
    if (cloneError) return { ok: false, error: cloneError };
    const candidates = upgradeCandidates(repoDir, team);
    const states = new Map(classify(repoDir, candidates.files).map((file) => [file.path, file.state]));
    // Refusing an unknown path by name is what keeps the red lines from depending on the
    // caller: the only writable paths in existence are the ones today's skeleton emits,
    // minus everything the team owns, everything a symbolic link sits on and everything
    // this machine cannot regenerate - so `skills/` and `.mcp.json` cannot be reached from
    // here even by asking for them.
    for (const path of paths) {
      const withheld = [...candidates.linked, ...candidates.withheld].find((file) => file.path === path);
      if (withheld) return { ok: false, error: `"${path}" is not offered here: ${withheld.reason}` };
      if (!(path in candidates.files)) {
        return {
          ok: false,
          error:
            `"${path}" is not a scaffold file this can refresh. Run the plan again and copy a path ` +
            "from it; the team's own skills, commands and MCP settings are never touched.",
        };
      }
      if (states.get(path) === "current") {
        return { ok: false, error: `"${path}" already matches this version, so nothing was changed.` };
      }
    }
    // Read before anything is written, so the commit raises the version exactly when the
    // plan said it would and stays silent when the plan said it could not.
    const version = versionPlan(repoDir);
    const prefix = teamBranchPrefix(team);
    // An earlier refresh whose request is still open (or was abandoned) already holds the
    // obvious name, and reusing it makes the push fail non-fast-forward for a reason that
    // has nothing to do with this run.
    const taken = remoteBranches(git, repoDir);
    const branch = `${prefix}${uniqueSlug("refresh-scaffold", (slug) => taken.has(`${prefix}${slug}`))}`;
    const title = "chore: refresh the team handbook scaffold";
    let raised: string | null = null;
    try {
      git(["checkout", "-b", branch], repoDir);
      const writeError = writeCandidates(repoDir, candidates.files, paths);
      if (writeError) return { ok: false, error: writeError };
      // The refresh has to reach the teammates it is for, and a marketplace whose version
      // did not move is one Claude Code keeps serving from cache. This raises the number
      // the team already has rather than the one the skeleton ships, so the signal they
      // have been building on is preserved and advanced, never reset - and when it cannot
      // be raised, nothing is invented and the result says so instead.
      if (version.next) raised = bumpPluginVersion(repoDir);
      const { missing } = stage(git, repoDir, paths);
      // Before the commit, so a refresh that cannot carry everything it was asked for
      // carries none of it rather than reporting a file it quietly dropped.
      if (missing.length) return { ok: false, error: ignoredPathsMessage(missing) };
      git([...identity, "commit", "-m", `${teamCommitPrefix(team)}${title}`], repoDir);
      git(["push", "-u", "origin", branch], repoDir);
    } catch (err) {
      return {
        ok: false,
        error: pushFailureReason(
          team.repoUrl,
          branch,
          err,
          'Set "branchPrefix" under "team" in your TeamHandbook config.json to a prefix that fits ' +
            '(for example "TEAM-1-"), then run this again.',
          teamCommitPrefixFix(team, "run this again"),
        ),
      };
    }
    const pr = openPr(
      team.repoUrl,
      branch,
      title,
      [
        "Refreshes the scaffold files this repository received from `/handbook:init` to the version",
        "TeamHandbook ships today. Nothing under `skills/`, `commands/`, `agents/` or `.mcp.json` is",
        "touched; in the two manifests the team's own entries are carried across, and the plugin",
        "version is raised rather than reset, so teammates' copies pick this up.",
        "",
        "Files in this request:",
        ...paths.map((path) => `- \`${path}\``),
        "",
        "Opened by TeamHandbook.",
      ].join("\n"),
      repoDir,
      forge,
    );
    return {
      ok: true,
      url: team.repoUrl,
      refreshed: paths,
      branch,
      ...(raised ? { version: raised } : {}),
      ...(raised ? {} : version.blocked ? { versionNotRaised: version.blocked } : {}),
      ...(pr.url ? { prUrl: pr.url } : { manualUrl: manualPrUrl(team.repoUrl, branch) ?? undefined }),
      ...(pr.url ? {} : pr.error ? { prError: pr.error } : {}),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function withheldLines(files: WithheldFile[]): string[] {
  return files.flatMap((file) => [`  ${"NOT OFFERED".padEnd(16)} ${file.path}`, `                   ${file.reason}`]);
}

export function formatUpgradePlan(plan: UpgradePlan): string {
  const files = plan.files ?? [];
  const paths = refreshable(files);
  const lines = [`Team handbook scaffold at ${plan.url}`, ""];
  for (const file of files) {
    const label =
      file.state === "current" ? "up to date" : file.state === "absent" ? "NOT IN THE REPO" : "DIFFERS";
    lines.push(`  ${label.padEnd(16)} ${file.path}`);
  }
  lines.push(...withheldLines(plan.linked ?? []), ...withheldLines(plan.withheld ?? []));
  for (const path of plan.unreadable ?? []) {
    lines.push(
      `  ${"SKIPPED".padEnd(16)} ${path}`,
      "                   it is not valid JSON, so what the team put in it could not be read and",
      "                   carried across. Fix the JSON by hand and run this again.",
    );
  }
  if (!paths.length) {
    lines.push("", "Nothing to refresh - every scaffold file already matches this version.");
    return lines.join("\n");
  }
  lines.push(
    "",
    `${paths.length} file(s) can be refreshed. A DIFFERS file may be an old scaffold or an edit your team`,
    "made on purpose - nothing records which, so read the diff before choosing it.",
    "",
    "The team's own content is never part of this: skills/, commands/, agents/ and .mcp.json are",
    "not offered and cannot be written, and inside the two manifests the team's own entries - the",
    "plugin version, any extra plugins, the marketplace owner - are carried across, not replaced.",
  );
  // The version is stated on its own line with the real numbers, because it is not one of
  // the files above and moves whether or not the manifest is chosen: a reader who declined
  // that file would otherwise find it changed anyway with nothing having said so. And when
  // it CANNOT move, that is the line that matters most - it is the difference between a
  // merge that reaches the team and one that reaches nobody.
  const version = plan.version ?? {};
  if (version.next) {
    lines.push(
      "",
      `The merge request also raises the plugin version, ${version.current} -> ${version.next}, the way every share does.`,
      "Without that, no teammate's copy refreshes for this.",
    );
  } else if (version.blocked) {
    lines.push("", `WARNING: ${version.blocked}`);
  }
  if (plan.ignored?.length) {
    lines.push("", `WARNING: ${ignoredPathsMessage(plan.ignored)}`, "The diff below does not show it.");
  }
  if (plan.stat) lines.push("", plan.stat);
  if (plan.diff) lines.push("", plan.diff.trimEnd());
  lines.push(
    "",
    "Nothing has been changed, in this repository or on this machine. To send a refresh, name",
    "each file you want:",
    "",
    `  ${paths.map((path) => `--file ${path}`).join(" ")}`,
  );
  return lines.join("\n");
}

export function formatUpgradeResult(result: UpgradeResult): string {
  return [
    "Scaffold refresh opened.",
    "",
    `  repository:  ${result.url}`,
    `  refreshed:   ${result.refreshed?.join(", ")}`,
    `  branch:      ${result.branch}`,
    ...(result.version ? [`  version:     raised to ${result.version}`] : []),
    ...(result.versionNotRaised ? [`  version:     NOT raised. ${result.versionNotRaised}`] : []),
    result.prUrl
      ? `  request:     ${result.prUrl}`
      : `  request:     open it here - ${result.manualUrl ?? `push ${result.branch} and open a request against the default branch`}`,
    ...(result.prError ? [`               (could not open it automatically: ${result.prError})`] : []),
    "",
    "Nothing reaches anyone until that is merged.",
  ].join("\n");
}

/**
 * How many scaffold files the repository is MISSING, for the doctor's team-repo check.
 * Takes a clone the caller already has, because the doctor makes one for the version
 * reading anyway and a second network round trip to answer a second question about the
 * same repository is a cost with nothing behind it.
 *
 * Both counts are returned and the doctor acts on `absent` alone. A file the repository
 * has never had is a fault nobody chose; a file whose bytes differ may be exactly what
 * the team meant - `writeSkeletonPreserving` keeps a README the repository already had,
 * so every team that wrote their own reads as `differs` for good. Warning on that
 * produced a yellow line that could only be cleared by overwriting the team's own README,
 * repeated on every run, which is how a warning stops being read.
 */
export function countStaleSkeleton(repoDir: string, team: TeamConfig): { absent: number; differs: number } {
  const files = classify(repoDir, upgradeCandidates(repoDir, team).files);
  return {
    absent: files.filter((file) => file.state === "absent").length,
    differs: files.filter((file) => file.state === "differs").length,
  };
}
