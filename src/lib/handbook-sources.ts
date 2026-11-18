import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersions } from "./branch.js";

// Where a person's skills, commands, MCP servers and hooks come from: their own folder, and each
// plugin their Claude Code has installed (a team's handbook is one). Every function takes the folders
// it reads and defaults none of them, and none of them runs a program or opens a connection: what a
// marketplace holds is what the last `claude plugin marketplace update` left on this machine.
// MCP servers are named and nothing else is read from their definitions; settings.json is read for
// which plugins are enabled and for nothing more.

export interface Freshness {
  installed: string | null;
  available: string | null;
  behind: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface HandbookSource {
  kind: "yours" | "plugin";
  name: string;
  marketplace: string | null;
  version: string | null;
  enabled: boolean;
  skills: string[];
  commands: string[];
  mcpServers: string[];
  hooks: number;
  freshness: Freshness | null;
}

const dirsIn = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

const namesIn = (dir: string, extension: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(extension)).map((e) => e.name.slice(0, -extension.length)).sort();
  } catch {
    return [];
  }
};

const json = (file: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

// A skill is its whole folder: a script beside SKILL.md changing is a change of the skill.
function skillDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) hash.update(rel).update("\0").update(readFileSync(join(current, entry.name))).update("\0");
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/**
 * How a plugin as installed compares with the copy its marketplace holds now: versions when both are
 * numbers, and the skills added, changed and removed either way. Two folders on this machine; nothing
 * is fetched.
 */
export function pluginFreshness(installedDir: string, marketplaceDir: string): Freshness | null {
  if (!existsSync(join(marketplaceDir, ".claude-plugin", "plugin.json")) || !existsSync(join(installedDir, ".claude-plugin", "plugin.json"))) return null;
  const version = (dir: string) => {
    const v = json(join(dir, ".claude-plugin", "plugin.json"))?.version;
    return typeof v === "string" ? v : null;
  };
  const installed = version(installedDir);
  const available = version(marketplaceDir);
  const had = new Map(dirsIn(join(installedDir, "skills")).map((name) => [name, skillDigest(join(installedDir, "skills", name))]));
  const has = new Map(dirsIn(join(marketplaceDir, "skills")).map((name) => [name, skillDigest(join(marketplaceDir, "skills", name))]));
  const added = [...has.keys()].filter((name) => !had.has(name));
  const removed = [...had.keys()].filter((name) => !has.has(name));
  const changed = [...has.keys()].filter((name) => had.has(name) && had.get(name) !== has.get(name));
  const order = installed && available ? compareVersions(available, installed) : null;
  const behind = order !== null ? order > 0 : added.length + removed.length + changed.length > 0;
  return { installed, available, behind, added, changed, removed };
}

/**
 * The folder a marketplace keeps one of its plugins in: where its `marketplace.json` says the plugin's
 * source is (`./` for a marketplace that is the plugin, `./plugins/x` for a folder in it), else the
 * marketplace folder itself. A source that leaves the marketplace folder is not followed.
 */
export function marketplacePluginRoot(marketplaceDir: string, pluginName: string): string | null {
  const listed = json(join(marketplaceDir, ".claude-plugin", "marketplace.json"))?.plugins;
  const entry = Array.isArray(listed) ? (listed as Record<string, unknown>[]).find((p) => p?.name === pluginName) : undefined;
  const source = typeof entry?.source === "string" ? entry.source : null;
  const candidates = [
    ...(source !== null && source.startsWith("./") && !source.split("/").includes("..") ? [resolve(marketplaceDir, source)] : []),
    marketplaceDir,
    join(marketplaceDir, pluginName),
  ];
  return candidates.find((dir) => existsSync(join(dir, ".claude-plugin", "plugin.json"))) ?? null;
}

function pluginSource(id: string, installPath: string, version: string | null, enabled: boolean, marketplaceDir: string | null): HandbookSource {
  const at = id.lastIndexOf("@");
  const mcp = json(join(installPath, ".mcp.json"));
  const servers = (mcp?.mcpServers ?? mcp) as Record<string, unknown> | undefined;
  const hooks = json(join(installPath, "hooks", "hooks.json"))?.hooks;
  return {
    kind: "plugin",
    name: at < 0 ? id : id.slice(0, at),
    marketplace: at < 0 ? null : id.slice(at + 1),
    version,
    enabled,
    skills: dirsIn(join(installPath, "skills")),
    commands: namesIn(join(installPath, "commands"), ".md"),
    mcpServers: servers && typeof servers === "object" ? Object.keys(servers).filter((k) => k !== "mcpServers").sort() : [],
    hooks: hooks && typeof hooks === "object" ? Object.values(hooks as Record<string, unknown>).reduce<number>((n, list) => n + (Array.isArray(list) ? list.length : 0), 0) : 0,
    freshness: marketplaceDir ? pluginFreshness(installPath, marketplaceDir) : null,
  };
}

/**
 * The person's own folder first, then each plugin installed for them, with whether it is enabled and
 * how far behind its marketplace copy it is. `configDir` is the folder Claude Code keeps its settings
 * in; `pluginsDir` its plugin cache (installed_plugins.json, marketplaces/).
 */
function installedPlugins(pluginsDir: string): Record<string, unknown> {
  const record = json(join(pluginsDir, "installed_plugins.json"));
  return record?.version === 2 && record.plugins && typeof record.plugins === "object" ? (record.plugins as Record<string, unknown>) : {};
}

/**
 * Where one installed plugin (`name@marketplace`) is on this machine and where its marketplace keeps its
 * current copy: the person's own install, or one their organization manages, and the folders that exist.
 * Null for a plugin that is not installed for them or whose install folder is gone.
 */
export function installedPluginDirs(pluginsDir: string, id: string): { installPath: string; version: string | null; marketplaceDir: string | null } | null {
  const entries = installedPlugins(pluginsDir)[id];
  const own = (Array.isArray(entries) ? (entries as Record<string, unknown>[]) : []).find((e) => (e.scope === "user" || e.scope === "managed") && typeof e.installPath === "string" && statSafe(e.installPath as string));
  if (!own) return null;
  const at = id.lastIndexOf("@");
  const copy = at < 0 ? null : join(pluginsDir, "marketplaces", id.slice(at + 1));
  return { installPath: own.installPath as string, version: typeof own.version === "string" ? own.version : null, marketplaceDir: copy ? marketplacePluginRoot(copy, id.slice(0, at)) : null };
}

export function readHandbookSources(configDir: string, pluginsDir: string = join(configDir, "plugins")): HandbookSource[] {
  const enabled = (json(join(configDir, "settings.json"))?.enabledPlugins ?? {}) as Record<string, unknown>;
  const yours: HandbookSource = {
    kind: "yours",
    name: "Yours",
    marketplace: null,
    version: null,
    enabled: true,
    skills: dirsIn(join(configDir, "skills")),
    commands: namesIn(join(configDir, "commands"), ".md"),
    mcpServers: [],
    hooks: 0,
    freshness: null,
  };
  const found = Object.keys(installedPlugins(pluginsDir)).flatMap((id) => {
    const dirs = installedPluginDirs(pluginsDir, id);
    return dirs ? [pluginSource(id, dirs.installPath, dirs.version, enabled[id] !== false, dirs.marketplaceDir)] : [];
  });
  return [yours, ...found.sort((a, b) => a.name.localeCompare(b.name))];
}

const statSafe = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A folder's own `.claude` as a source: the skills and commands it carries and the MCP servers its `.mcp.json` names. */
export function readFolderSource(folder: string, name: string): HandbookSource {
  const claude = join(folder, ".claude");
  const mcp = json(join(folder, ".mcp.json"));
  const servers = mcp?.mcpServers as Record<string, unknown> | undefined;
  return {
    kind: "yours",
    name,
    marketplace: null,
    version: null,
    enabled: true,
    skills: dirsIn(join(claude, "skills")),
    commands: namesIn(join(claude, "commands"), ".md"),
    mcpServers: servers && typeof servers === "object" ? Object.keys(servers).sort() : [],
    hooks: 0,
    freshness: null,
  };
}

/**
 * The label every screen and /handbook:status gives a source: yours, this folder, a plugin with its
 * version, or the team's repository (the plugin whose marketplace is the team's).
 */
export function sourceLabel(source: HandbookSource, teamMarketplace: string | null = null): string {
  if (source.kind === "yours") return source.name === "Yours" ? "yours" : `this folder (${source.name})`;
  return pluginLabel(source, teamMarketplace);
}

/** A plugin's label from what names it alone, for a reader that has its own list of sources. */
export function pluginLabel(plugin: { name: string; marketplace: string | null; version: string | null }, teamMarketplace: string | null = null): string {
  if (teamMarketplace && plugin.marketplace === teamMarketplace) return `the team's ${plugin.name}`;
  return plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name;
}
