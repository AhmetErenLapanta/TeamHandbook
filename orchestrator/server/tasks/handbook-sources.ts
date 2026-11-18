import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { redactLine } from "../log.js";
import { pluginCopies } from "../forge/plugin-changes.js";
import { detectSecret, installedPluginDirs, marketplacePluginRoot, pluginFreshness } from "../plugin.js";
import type { PersonalSetup } from "./personal-setup.js";
import { HANDBOOK_PLUGIN } from "./plugin-install.js";

/**
 * One place Claude Code gets skills, commands, MCP servers and hooks from, as the person sees it:
 * their own folder, a project folder, an installed plugin. Names, counts and versions only: no
 * value, command, address or credential is read into it.
 */
export interface HandbookSource {
  /** `yours`, `folder:<path>`, `plugin:<name>@<marketplace>` or `team:<repoId>`. */
  id: string;
  kind: "yours" | "folder" | "plugin" | "team-repo";
  name: string;
  version?: string;
  marketplace?: string;
  /** Where Claude Code installed a plugin: user, project or local, as its own commands take it. */
  scope?: string;
  enabled: boolean;
  /** Why a source is off with no switch for it here, said to the person. */
  whyNot?: string;
  skills: { name: string; description?: string }[];
  commands: { name: string }[];
  mcpServers: { name: string }[];
  /** A hook event and what it runs: each command masked, printable and cut, "(withheld)" where it looks like it holds a secret; never an env value. */
  hooks: { name: string; commands: string[]; matchers?: string[] }[];
  claudeMd?: boolean;
  /** A plugin whose marketplace copy is newer than the installed one: the version there and the skills it adds, changes and removes. */
  /** The newer version the marketplace copy holds: the skills it adds, changes and removes, and every hook and MCP server it runs. */
  latest?: { version: string; added: string[]; changed: string[]; removed: string[]; hooks: { name: string; commands: string[] }[]; mcpServers: string[] };
}

/** Where a source keeps its files, kept by the server for reading a skill and never sent. */
export type SourceRoots = ReadonlyMap<string, string>;

export interface ReadSources {
  sources: HandbookSource[];
  roots: SourceRoots;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LISTED_MAX = 300;
const FRONT_BYTES = 4096;
export const SKILL_READ_MAX = 64 * 1024;

const within = (outer: string, inner: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const names = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);

/**
 * The `description:` of a SKILL.md's front matter as one line, masked; null when it has none or looks like it holds a
 * secret. The value is read as YAML writes it: on the same line, in quotes, or as a folded or literal block (`>-`, `|`)
 * or a plain value continued on indented lines, as plugins' own skills write it.
 */
export function describe(head: string): string | undefined {
  const front = /^---\s*\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
  const lines = front.split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return undefined;
  const first = lines[at]!.slice("description:".length).trim();
  const indented: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== "" && !/^\s/.test(l)) break;
    indented.push(l.trim());
  }
  const block = /^[>|][+-]?\d?$/.test(first);
  const joined = [...(block || first === "" ? [] : [first]), ...indented].filter((l) => l !== "").join(" ").trim();
  const line = joined.replace(/^["']|["']$/g, "");
  if (!line || detectSecret(line)) return undefined;
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, "");
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

async function skillsIn(root: string): Promise<HandbookSource["skills"]> {
  const found: HandbookSource["skills"] = [];
  for (const entry of await names(join(root, "skills"))) {
    if (found.length >= LISTED_MAX || !entry.isDirectory() || !NAME.test(entry.name)) continue;
    const file = join(root, "skills", entry.name, "SKILL.md");
    const head = await readFile(file, { encoding: "utf8" }).then((t) => t.slice(0, FRONT_BYTES), () => null);
    if (head === null) continue;
    const description = describe(head);
    found.push({ name: entry.name, ...(description ? { description } : {}) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function commandsIn(root: string): Promise<HandbookSource["commands"]> {
  const found: HandbookSource["commands"] = [];
  for (const entry of await names(join(root, "commands"))) {
    if (found.length < LISTED_MAX && entry.isFile() && entry.name.endsWith(".md") && NAME.test(entry.name.slice(0, -3))) found.push({ name: entry.name.slice(0, -3) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

const COMMAND_MAX = 200;
const COMMANDS_PER_EVENT = 5;

/** One hook command as the person reads it: withheld when it looks like it holds a secret, else masked, printable and cut. */
function shownCommand(command: string): string {
  if (detectSecret(command)) return "(withheld)";
  const plain = redactLine(command.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim());
  return plain.length > COMMAND_MAX ? `${plain.slice(0, COMMAND_MAX - 1)}…` : plain;
}

/** The events a hooks object holds (PreToolUse and the like) and the commands each runs; hook settings other than the command are not read. */
function hookEvents(parsed: unknown): HandbookSource["hooks"] {
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const found: HandbookSource["hooks"] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>).slice(0, 30)) {
    if (!NAME.test(event)) continue;
    const commands: string[] = [];
    const matchers: string[] = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const matcher = (group as { matcher?: unknown })?.matcher;
      if (typeof matcher === "string" && matcher && matchers.length < COMMANDS_PER_EVENT && !matchers.includes(shownCommand(matcher))) matchers.push(shownCommand(matcher));
      for (const hook of Array.isArray((group as { hooks?: unknown })?.hooks) ? (group as { hooks: Record<string, unknown>[] }).hooks : []) {
        if (commands.length < COMMANDS_PER_EVENT && typeof hook?.command === "string") commands.push(shownCommand(hook.command));
      }
    }
    found.push({ name: event, commands, ...(matchers.length ? { matchers } : {}) });
  }
  return found;
}

async function hooksIn(files: string[]): Promise<HandbookSource["hooks"]> {
  const byEvent = new Map<string, { commands: string[]; matchers: string[] }>();
  for (const file of files) {
    const parsed = await readFile(file, "utf8").then((t) => JSON.parse(t) as unknown, () => null);
    for (const { name, commands, matchers = [] } of hookEvents(parsed)) {
      const held = byEvent.get(name) ?? { commands: [], matchers: [] };
      byEvent.set(name, { commands: [...held.commands, ...commands].slice(0, COMMANDS_PER_EVENT), matchers: [...held.matchers, ...matchers].slice(0, COMMANDS_PER_EVENT) });
    }
  }
  return [...byEvent].sort(([a], [b]) => a.localeCompare(b)).map(([name, { commands, matchers }]) => ({ name, commands, ...(matchers.length ? { matchers } : {}) }));
}

const present = (file: string) => stat(file).then((s) => s.isFile(), () => false);

async function shipped(root: string, settings: string[]): Promise<Pick<HandbookSource, "skills" | "commands" | "hooks">> {
  const [skills, commands, hooks] = await Promise.all([skillsIn(root), commandsIn(root), hooksIn(settings)]);
  return { skills, commands, hooks };
}

/**
 * Where an installed plugin's files are: the path the CLI's list gives, else the one Claude Code
 * recorded when it installed it, else its cache folder for that version. A path outside Claude
 * Code's own plugins folder is not followed, whichever named it.
 */
async function installPathOf(claudeDir: string, item: Record<string, unknown>, name: string, marketplace: string): Promise<string | null> {
  const pluginsDir = join(claudeDir, "plugins");
  const inside = async (path: string) => {
    const real = await realpath(path).catch(() => null);
    const root = await realpath(pluginsDir).catch(() => null);
    return real && root && within(root, real) ? real : null;
  };
  if (typeof item.installPath === "string" && isAbsolute(item.installPath)) return inside(item.installPath);
  if (!marketplace) return null;
  const recorded = installedPluginDirs(pluginsDir, `${name}@${marketplace}`)?.installPath;
  if (recorded) return inside(recorded);
  return typeof item.version === "string" && NAME.test(item.version) ? inside(join(pluginsDir, "cache", marketplace, name, item.version)) : null;
}

/**
 * What the person's Claude Code draws on, one source at a time. `home` is the person's home (a test
 * hands a made-up one), `claudeDir` their Claude Code folder, `folder` a project folder they work in,
 * `plugins` the CLI's own list (install paths stay here), `personal` the last read of their setup
 * for servers by scope. No credential file is opened; settings files give hook event names alone.
 */
export async function readSources(input: { claudeDir: string; folder?: string; folderTrusted?: boolean; plugins: Record<string, unknown>[]; personal: PersonalSetup | null; managed?: readonly (Record<string, unknown> | null)[] }): Promise<ReadSources> {
  const { claudeDir, folder, folderTrusted = false, plugins, personal, managed = [] } = input;
  // A plugin the organization's managed settings turn on cannot be turned off from here, nor from the person's terminal.
  const keptOn = new Set(managed.flatMap((m) => Object.entries((m?.enabledPlugins ?? {}) as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id)));
  const sources: HandbookSource[] = [];
  const roots = new Map<string, string>();
  const servers = (scope: "user" | "project") => (personal?.mcpServers ?? []).filter((s) => s.scope === scope).map((s) => ({ name: s.name }));

  roots.set("yours", claudeDir);
  sources.push({ id: "yours", kind: "yours", name: "Yours", enabled: true, ...(await shipped(claudeDir, [join(claudeDir, "settings.json")])), mcpServers: servers("user"), claudeMd: await present(join(claudeDir, "CLAUDE.md")) });

  if (folder) {
    const dot = join(folder, ".claude");
    const id = `folder:${folder}`;
    roots.set(id, dot);
    // A task loads the folder's own settings only once the person trusts them; until then they are listed and off.
    sources.push({ id, kind: "folder", name: basename(folder), enabled: folderTrusted, ...(folderTrusted ? {} : { whyNot: "This folder's own settings load once you trust them." }), ...(await shipped(dot, [join(dot, "settings.json")])), mcpServers: servers("project"), claudeMd: await present(join(folder, "CLAUDE.md")) });
  }

  for (const item of plugins) {
    if (typeof item.id !== "string") continue;
    // TeamHandbook's own plugin is what runs this: it is in no list and has no switch, and every task loads it.
    if (item.id === HANDBOOK_PLUGIN) continue;
    const at = item.id.lastIndexOf("@");
    const name = at > 0 ? item.id.slice(0, at) : item.id;
    const marketplace = at > 0 ? item.id.slice(at + 1) : "";
    if (!NAME.test(name)) continue;
    const id = `plugin:${name}@${marketplace}`;
    const path = await installPathOf(claudeDir, item, name, marketplace);
    if (path) roots.set(id, path);
    const own = path ? await shipped(path, [join(path, "hooks", "hooks.json")]) : { skills: [], commands: [], hooks: [] };
    // The marketplace copy Claude Code keeps locally, read with no network: an update the person has not fetched is not seen.
    const copies = marketplace ? pluginCopies(claudeDir, marketplace, name) : null;
    const fresh = copies ? pluginFreshness(copies.installed, copies.available) : null;
    const next = fresh?.behind && fresh.available && copies ? marketplacePluginRoot(copies.available, name) : null;
    const latest = fresh?.behind && fresh.available ? { latest: { version: fresh.available, added: fresh.added, changed: fresh.changed, removed: fresh.removed, ...(await runs(next)) } } : {};
    const named = item.mcpServers;
    const listed = Array.isArray(named) ? named.map((s) => (typeof s === "string" ? s : (s as { name?: unknown })?.name)) : named && typeof named === "object" ? Object.keys(named) : [];
    sources.push({ id, kind: "plugin", name, ...(typeof item.version === "string" ? { version: item.version } : {}), ...(marketplace ? { marketplace } : {}), ...(typeof item.scope === "string" ? { scope: item.scope } : {}), enabled: item.enabled === true, ...(keptOn.has(`${name}@${marketplace}`) ? { whyNot: "Kept on by your organization's policy." } : {}), ...own, mcpServers: listed.filter((n): n is string => typeof n === "string" && NAME.test(n)).map((n) => ({ name: n })), ...latest });
  }
  return { sources, roots };
}

export type SkillRead = { content: string } | { refused: "unknown-source" | "unknown-skill" | "unreadable" };

/**
 * A skill's SKILL.md by the source and name the inventory lists, never by a path from the page:
 * the file must be a plain file inside the source's own folder after links are resolved, and what is
 * returned is cut, free of control characters and withheld when it looks like it holds a secret.
 */
export async function readSkill(read: ReadSources, sourceId: string, name: string): Promise<SkillRead> {
  const source = read.sources.find((s) => s.id === sourceId);
  const root = read.roots.get(sourceId);
  if (!source || !root) return { refused: "unknown-source" };
  // CLAUDE.md is the one rules file a source holds: Yours' in Claude Code's folder, This folder's beside its .claude.
  if (name === RULES_FILE) {
    if (!source.claudeMd || (source.kind !== "yours" && source.kind !== "folder")) return { refused: "unknown-skill" };
    const home = source.kind === "yours" ? root : dirname(root);
    return readPlain(join(home, RULES_FILE), home);
  }
  if (!source.skills.some((s) => s.name === name)) return { refused: "unknown-skill" };
  return readPlain(join(root, "skills", name, "SKILL.md"), root);
}

export const RULES_FILE = "CLAUDE.md";

/** A plain file inside `bound` after links are resolved, at most the limit of it, free of control characters; withheld when it looks like it holds a secret. */
async function readPlain(file: string, bound: string): Promise<SkillRead> {
  try {
    if (!(await lstat(file)).isFile()) return { refused: "unreadable" };
    const real = await realpath(file);
    if (!within(await realpath(bound), real)) return { refused: "unreadable" };
    // At most the limit is read, through a handle: a huge file never fills memory.
    const handle = await open(real, "r");
    const buffer = Buffer.alloc(SKILL_READ_MAX);
    const { bytesRead } = await handle.read(buffer, 0, SKILL_READ_MAX, 0).finally(() => handle.close());
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
    if (detectSecret(text)) return { refused: "unreadable" };
    return { content: text };
  } catch {
    return { refused: "unreadable" };
  }
}

/** A plugin a marketplace Claude Code knows offers and the person has not installed: what it holds, by name and count. */
export interface AvailablePlugin {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  /** Counted only for a plugin whose files are in the marketplace's own copy; one fetched from elsewhere says none. */
  skills: number | null;
  commands: number | null;
  hooks: HandbookSource["hooks"] | null;
  mcpServers: string[];
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The marketplace Claude Code ships with: hundreds of plugins, so it is read after the person's own. */
const OFFICIAL_CATALOG = "claude-plugins-official";

async function json(file: string): Promise<Record<string, unknown> | null> {
  return readFile(file, "utf8").then((t) => JSON.parse(t) as Record<string, unknown>, () => null);
}

/** The hooks (event and shown command) and MCP server names a plugin's folder runs, read from its own files with no network. */
async function runs(root: string | null): Promise<{ hooks: HandbookSource["hooks"]; mcpServers: string[] }> {
  if (!root) return { hooks: [], mcpServers: [] };
  const servers = await json(join(root, ".mcp.json"));
  const serverMap = (servers?.mcpServers ?? servers) as Record<string, unknown> | null;
  return { hooks: await hooksIn([join(root, "hooks", "hooks.json")]), mcpServers: serverMap && typeof serverMap === "object" ? Object.keys(serverMap).filter((n) => NAME.test(n)) : [] };
}

/**
 * The plugins on offer to the person: each marketplace Claude Code already knows, read from its local
 * copy under its plugins folder with no network, less what is installed. A plugin whose source is a
 * folder of the copy is counted; one from elsewhere is listed by name alone, so another plugin's
 * files are never counted as its own.
 */
export async function availablePlugins(claudeDir: string): Promise<AvailablePlugin[]> {
  const pluginsDir = join(claudeDir, "plugins");
  const found: AvailablePlugin[] = [];
  // Each marketplace is cut on its own, and the catalogue Claude Code ships with is read last: its hundreds never crowd out the person's own.
  const markets = (await names(join(pluginsDir, "marketplaces"))).sort((x, y) => Number(x.name === OFFICIAL_CATALOG) - Number(y.name === OFFICIAL_CATALOG) || x.name.localeCompare(y.name));
  for (const entry of markets) {
    if (!entry.isDirectory() || !PART.test(entry.name)) continue;
    let counted = 0;
    const copy = join(pluginsDir, "marketplaces", entry.name);
    const listed = (await json(join(copy, ".claude-plugin", "marketplace.json")))?.plugins;
    for (const item of Array.isArray(listed) ? (listed as Record<string, unknown>[]) : []) {
      if (counted >= LISTED_MAX || typeof item?.name !== "string" || !PART.test(item.name)) continue;
      if (`${item.name}@${entry.name}` === HANDBOOK_PLUGIN) continue;
      if (installedPluginDirs(pluginsDir, `${item.name}@${entry.name}`)) continue;
      const local = typeof item.source === "string" && item.source.startsWith("./") && !item.source.split("/").includes("..");
      const root = local ? marketplacePluginRoot(copy, item.name) : null;
      const shipped = root ? await Promise.all([skillsIn(root), commandsIn(root), runs(root)]) : null;
      const description = typeof item.description === "string" && !detectSecret(item.description) ? item.description.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) : undefined;
      counted += 1;
      found.push({
        id: `plugin:${item.name}@${entry.name}`,
        name: item.name,
        marketplace: entry.name,
        ...(description ? { description } : {}),
        ...(typeof item.version === "string" ? { version: item.version } : {}),
        skills: shipped ? shipped[0].length : null,
        commands: shipped ? shipped[1].length : null,
        hooks: shipped ? shipped[2].hooks : null,
        mcpServers: shipped ? shipped[2].mcpServers : [],
      });
    }
  }
  return found;
}
