import { basename } from "node:path";
import { gitAsync, gitAsyncMaybe } from "../git.js";
import { declaredServers, detectSecret, PLUGIN_MANIFEST } from "../plugin.js";

/** The last commit that touched one skill of the team repository. */
export interface SkillChange {
  sha: string;
  at: string;
  by: string;
  subject: string;
}

/** Names that came, changed or went between two versions. */
export interface NamesChanged {
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * What a person's installed version of a handbook lacks of the current one: skills at the top level,
 * as the first reader of it took them, and commands and MCP servers beside them, by name alone.
 */
export interface VersionDiff extends NamesChanged {
  from: string;
  to: string;
  commands: NamesChanged;
  mcpServers: NamesChanged;
}

/** One skill's change between two versions, as text to read before updating. */
export interface SkillPatch {
  patch: string;
  truncated: boolean;
}

/** Commits of the skills folder read for their last changes; a skill older than all of them reads as unchanged since. */
export const CHANGE_COMMITS = 2000;
/** Commits of the manifest walked to find an installed version: a version older than this many raises is not found. */
export const VERSION_COMMITS = 200;
/** The most of one skill's change shown before updating; the rest is read on the forge. */
export const PATCH_MAX = 64 * 1024;

/** A path inside the plugin: `root` is "" for one at the repository's root, as a team repository is, or the folder a marketplace names for it, with its slash. */
const at = (root: string, rest: string) => `${root}${rest}`;

const skillOf = (root: string, path: string): string | null => (path.startsWith(at(root, "skills/")) ? (/^([^/]+)\//.exec(path.slice(at(root, "skills/").length))?.[1] ?? null) : null);

/** Each skill of the plugin at `head` with the last commit that changed it, read in one walk of the history. */
export async function skillChanges(dir: string, head: string, root = ""): Promise<Map<string, SkillChange>> {
  const out = (await gitAsyncMaybe(["log", `-n${CHANGE_COMMITS}`, "--format=%x1e%H%x1f%cI%x1f%an%x1f%s", "--name-only", head, "--", at(root, "skills/")], dir)) ?? "";
  const changes = new Map<string, SkillChange>();
  for (const entry of out.split("\x1e").filter(Boolean)) {
    const [header = "", ...paths] = entry.split("\n");
    const [sha = "", when = "", by = "", subject = ""] = header.split("\x1f");
    for (const name of new Set(paths.map((p) => skillOf(root, p)).filter((n): n is string => n !== null))) if (!changes.has(name)) changes.set(name, { sha, at: when, by, subject });
  }
  return changes;
}

/** The version line of the plugin's manifest at a commit; null for a plugin versioned by commit. */
export async function manifestVersion(dir: string, commit: string, root = ""): Promise<string | null> {
  const text = await gitAsyncMaybe(["show", `${commit}:${at(root, PLUGIN_MANIFEST)}`], dir);
  try {
    const version = text ? (JSON.parse(text) as { version?: unknown }).version : undefined;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The names a commit holds of each kind, and each MCP server's definition to tell a changed one; the definitions never leave here. */
async function contentsAt(dir: string, commit: string, root: string) {
  const listed = async (folder: string, directories: boolean) => ((await gitAsyncMaybe(["ls-tree", ...(directories ? ["-d"] : []), "--name-only", `${commit}:${at(root, folder)}`], dir)) ?? "").split("\n").filter(Boolean);
  const servers = declaredServers(await gitAsyncMaybe(["show", `${commit}:${at(root, ".mcp.json")}`], dir));
  return {
    skills: new Set(await listed("skills", true)),
    commands: new Set((await listed("commands", false)).filter((name) => name.endsWith(".md")).map((name) => basename(name, ".md"))),
    servers: new Map(Object.entries(servers).map(([name, definition]) => [name, JSON.stringify(definition)])),
  };
}

/**
 * The commit that raised the manifest to `version`: Claude Code fetches the plugin again only when
 * its version moves, so whoever has `version` may hold the repository as of that commit, and
 * everything after it is what updating brings. Null when the history read holds no such version.
 */
async function raisedTo(dir: string, head: string, version: string, root: string): Promise<string | null> {
  const raises = ((await gitAsyncMaybe(["log", `-n${VERSION_COMMITS}`, "--format=%H", head, "--", at(root, PLUGIN_MANIFEST)], dir)) ?? "").split("\n").filter(Boolean);
  let found: string | null = null;
  for (const commit of raises) {
    if ((await manifestVersion(dir, commit, root)) === version) found = commit;
    else if (found) break;
  }
  return found;
}

/** The commit a person on `from` holds, and the version at `head`; null where either is unknown. */
async function span(dir: string, head: string, from: string, root: string): Promise<{ base: string; to: string } | null> {
  const to = await manifestVersion(dir, head, root);
  if (!to) return null;
  const base = to === from ? head : await raisedTo(dir, head, from, root);
  return base ? { base, to } : null;
}

const sorted = (names: Iterable<string>) => [...names].sort();

function compared(before: Set<string>, after: Set<string>, changed: Iterable<string>): NamesChanged {
  return {
    added: sorted([...after].filter((name) => !before.has(name))),
    changed: sorted(new Set([...changed].filter((name) => before.has(name) && after.has(name)))),
    removed: sorted([...before].filter((name) => !after.has(name))),
  };
}

/**
 * The skills, commands and MCP servers added, changed and removed between a plugin's `from` version
 * and its version at `head`, as the person who installed `from` would get them by updating, counted
 * from the commit that raised the manifest to `from`. A server counts as changed when its definition
 * differs; only its name is said. Null when the plugin has no version line or `from` is not in its
 * history.
 */
export async function versionDiff(dir: string, head: string, from: string, root = ""): Promise<VersionDiff | null> {
  const known = await span(dir, head, from, root);
  if (!known) return null;
  const [before, after] = await Promise.all([contentsAt(dir, known.base, root), contentsAt(dir, head, root)]);
  const touched = (await gitAsync(["diff", "--name-only", known.base, head, "--", at(root, "skills/"), at(root, "commands/")], dir)).split("\n").filter(Boolean);
  const skills = compared(before.skills, after.skills, touched.map((p) => skillOf(root, p)).filter((n): n is string => n !== null));
  const commands = compared(before.commands, after.commands, touched.filter((p) => p.startsWith(at(root, "commands/")) && p.endsWith(".md")).map((p) => basename(p, ".md")));
  const mcpServers = compared(new Set(before.servers.keys()), new Set(after.servers.keys()), [...after.servers].filter(([name, definition]) => before.servers.get(name) !== definition).map(([name]) => name));
  return { from, to: known.to, ...skills, commands, mcpServers };
}

/**
 * One skill's change from a person's `from` version to the plugin at `head`, for reading before an
 * update: a unified diff of its folder, each line held back that looks like it holds a secret, cut at
 * PATCH_MAX. Null when the version is unknown or the skill did not change.
 */
export async function skillPatch(dir: string, head: string, from: string, name: string, root = ""): Promise<SkillPatch | null> {
  const known = await span(dir, head, from, root);
  if (!known) return null;
  const text = await gitAsync(["diff", "--no-color", "--no-ext-diff", known.base, head, "--", at(root, `skills/${name}/`)], dir);
  if (!text.trim()) return null;
  const truncated = text.length > PATCH_MAX;
  const held = (line: string) => {
    const secret = detectSecret(line);
    return secret ? `[withheld: a line that looks like it holds a ${secret}]` : line;
  };
  return { patch: (truncated ? text.slice(0, PATCH_MAX) : text).split("\n").map(held).join("\n"), truncated };
}
