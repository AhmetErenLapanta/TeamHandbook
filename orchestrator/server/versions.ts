import type { FileChange } from "./forge/types.js";
import { gitAsync, gitAsyncBytes, gitAsyncMaybe } from "./git.js";
import { compareVersions, PLUGIN_MANIFEST, versionPast } from "./plugin.js";
import type { VersionClaim } from "./plugin.js";

/** A request's raise of the plugin's version line, and the unmerged branches it went past. */
export interface VersionRaise {
  /** The plugin manifest with the new version, to go into the request's files. */
  file: FileChange;
  version: string;
  /** Branches of the team repository that already claim a version above the one the change was prepared from. */
  past: VersionClaim[];
  /** The default branch, which is among `past` when it moved past that version since. */
  target: string | null;
}

/**
 * Every branch in the mirror whose manifest claims a version above `current`. Read from the
 * mirror, which holds each branch of the team repository as of its last sync - a request the
 * orchestrator opens is synced right after - with one `cat-file --batch` for all of them.
 */
async function claimsAbove(mirror: string, head: string, current: string): Promise<VersionClaim[]> {
  const branches = (await gitAsync(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"], mirror))
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ sha: line.slice(0, line.indexOf(" ")), branch: line.slice(line.indexOf(" ") + 1 + "refs/heads/".length) }))
    .filter((b) => b.sha !== head);
  if (!branches.length) return [];
  const out = await gitAsyncBytes(["cat-file", "--batch"], mirror, branches.map((b) => `${b.sha}:${PLUGIN_MANIFEST}`).join("\n") + "\n");
  const claims: VersionClaim[] = [];
  let at = 0;
  for (const { branch } of branches) {
    const end = out.indexOf(0x0a, at);
    const header = out.subarray(at, end).toString("utf8");
    at = end + 1;
    const size = / blob (\d+)$/.exec(header)?.[1];
    if (size === undefined) continue;
    const text = out.subarray(at, at + Number(size)).toString("utf8");
    at += Number(size) + 1;
    try {
      const version = (JSON.parse(text) as { version?: unknown }).version;
      if (typeof version === "string" && (compareVersions(version, current) ?? 0) > 0) claims.push({ branch, version });
    } catch {
      continue;
    }
  }
  return claims.sort((a, b) => a.branch.localeCompare(b.branch));
}

/**
 * The plugin's version line, raised past the default branch and past every branch of the team
 * repository that already claims a higher number, when the repository has the line. Claude Code
 * fetches a plugin again only when that number moves: two open requests raising it to the same
 * number merge as an identical line, and the second reaches nobody. A repository without the
 * line is versioned by commit, and a line that is not MAJOR.MINOR.PATCH is not guessed at;
 * both give null. The plugin's own share takes the same decision (`openVersionClaims`,
 * `versionPast`).
 */
export async function versionRaise(mirror: string, head: string): Promise<VersionRaise | null> {
  const text = await gitAsyncMaybe(["show", `${head}:${PLUGIN_MANIFEST}`], mirror);
  if (text === null) return null;
  let plugin: Record<string, unknown>;
  try {
    plugin = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const current = plugin.version;
  if (typeof current !== "string" || compareVersions(current, current) === null) return null;
  const past = await claimsAbove(mirror, head, current);
  const version = versionPast(current, past);
  const target = (await gitAsyncMaybe(["symbolic-ref", "--short", "HEAD"], mirror))?.trim() || null;
  return { file: { path: PLUGIN_MANIFEST, content: JSON.stringify({ ...plugin, version }, null, 2) + "\n" }, version, past, target };
}

/** The line a request's description carries about its raise. */
export function versionRaiseNote(raise: VersionRaise): string {
  // The default branch is in the list only when it moved on while the change was prepared; it is merged by definition.
  const merged = raise.past.filter((c) => c.branch === raise.target);
  const open = raise.past.filter((c) => c.branch !== raise.target);
  const parts = [
    ...(merged.length ? [`past ${merged[0]!.version}, which ${raise.target} reached since this change was prepared`] : []),
    ...(open.length ? [`past ${open.map((c) => `${c.version} on ${c.branch}`).join(" and ")}, which ${open.length === 1 ? "is" : "are"} not merged yet`] : []),
  ];
  return `Raises the plugin to version ${raise.version}${parts.length ? `, ${parts.join(", and ")}` : ""}, so teammates fetch it once this is merged.`;
}

/** The commit that put the plugin's version line back after the repository was versioned by commit. */
export interface VersionLineBack {
  sha: string;
  author: string;
  date: string;
  version: string;
}

const LINE_BACK_COMMITS = 100;

/**
 * Whether the version line at `head` came back: the newest commit that changed a version line
 * in the plugin manifest whose parent held the manifest with no version. A share from a
 * TeamHandbook older than 0.31.0, or a conflict resolved on the side with the version, writes
 * it back, and from then on a merge that raises nothing reaches nobody - the check the plugin's
 * doctor makes on a teammate's copy. A manifest that carried a version from its first commit
 * gives null.
 */
export async function versionLineBack(mirror: string, head: string): Promise<VersionLineBack | null> {
  const log = await gitAsyncMaybe(["log", "--first-parent", `-n${LINE_BACK_COMMITS}`, "-G", '"version"', "--format=%H%x00%an%x00%aI", head, "--", PLUGIN_MANIFEST], mirror);
  const commits = (log ?? "").split("\n").filter(Boolean).map((line) => {
    const [sha, author, date] = line.split("\0");
    return { sha: sha!, author: (author ?? "").replace(/\p{C}+/gu, " ").trim().slice(0, 200), date: date ?? "" };
  });
  if (!commits.length) return null;
  const out = await gitAsyncBytes(["cat-file", "--batch"], mirror, commits.flatMap((c) => [`${c.sha}:${PLUGIN_MANIFEST}`, `${c.sha}^:${PLUGIN_MANIFEST}`]).join("\n") + "\n");
  const versions: (string | null | undefined)[] = [];
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    const header = out.subarray(at, end).toString("utf8");
    at = end + 1;
    const size = / blob (\d+)$/.exec(header)?.[1];
    // undefined: no manifest there at all; null: a manifest without a version line.
    if (size === undefined) {
      versions.push(undefined);
      continue;
    }
    const text = out.subarray(at, at + Number(size)).toString("utf8");
    at += Number(size) + 1;
    let version: unknown;
    try {
      version = (JSON.parse(text) as { version?: unknown }).version;
    } catch {
      version = undefined;
    }
    versions.push(typeof version === "string" ? version : null);
  }
  for (const [i, commit] of commits.entries()) {
    const [now, before] = [versions[2 * i], versions[2 * i + 1]];
    // Whoever pushed the commit wrote the version too, so it is shown as plain, short text.
    if (typeof now === "string" && before === null) return { ...commit, version: now.replace(/\p{C}+/gu, " ").trim().slice(0, 40) };
    if (before === undefined) return null;
  }
  return null;
}
