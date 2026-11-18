import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { declaredServers, detectSecret, installedPluginDirs } from "../plugin.js";
import type { NamesChanged, SkillPatch } from "./team-changes.js";
import { PATCH_MAX } from "./team-changes.js";

/*
 * What updating an installed plugin brings beyond its skills, read from two folders on the person's
 * own machine: the version Claude Code installed and the copy its marketplace holds now. Nothing is
 * fetched and nothing is written; an MCP server is named, never its definition.
 */

/** A marketplace's or a plugin's name as Claude Code keeps it: no separator and no dot first, so it stays one folder. */
const PLUGIN_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The two folders a plugin of the person's is compared in: as Claude Code installed it and as its
 * marketplace's copy holds it now. Null for a name that is not one folder, a plugin not installed for
 * the person, one with no marketplace copy, or an install folder outside Claude Code's plugin folder.
 */
export function pluginCopies(claudeDir: string, marketplace: string, plugin: string): { installed: string; available: string } | null {
  if (!PLUGIN_PART.test(marketplace) || !PLUGIN_PART.test(plugin)) return null;
  const pluginsDir = resolve(claudeDir, "plugins");
  const dirs = installedPluginDirs(pluginsDir, `${plugin}@${marketplace}`);
  const inside = (dir: string) => resolve(dir).startsWith(`${pluginsDir}${sep}`);
  return dirs?.marketplaceDir && inside(dirs.installPath) && inside(dirs.marketplaceDir) ? { installed: dirs.installPath, available: dirs.marketplaceDir } : null;
}

const commandsIn = (dir: string): Set<string> => {
  try {
    return new Set(readdirSync(join(dir, "commands"), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name.slice(0, -".md".length)));
  } catch {
    return new Set();
  }
};

const textOf = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const serversIn = (dir: string): Map<string, string> => new Map(Object.entries(declaredServers(textOf(join(dir, ".mcp.json")))).map(([name, definition]) => [name, JSON.stringify(definition)]));

const sorted = (names: Iterable<string>) => [...names].sort();

function compared(before: Set<string>, after: Set<string>, changed: (name: string) => boolean): NamesChanged {
  return {
    added: sorted([...after].filter((name) => !before.has(name))),
    changed: sorted([...after].filter((name) => before.has(name) && changed(name))),
    removed: sorted([...before].filter((name) => !after.has(name))),
  };
}

/** The commands and MCP servers that came, changed or went between the installed plugin and its marketplace copy. */
export function pluginExtraChanges(installedDir: string, marketplaceDir: string): { commands: NamesChanged; mcpServers: NamesChanged } {
  const [had, has] = [commandsIn(installedDir), commandsIn(marketplaceDir)];
  const [before, after] = [serversIn(installedDir), serversIn(marketplaceDir)];
  return {
    commands: compared(had, has, (name) => textOf(join(installedDir, "commands", `${name}.md`)) !== textOf(join(marketplaceDir, "commands", `${name}.md`))),
    mcpServers: compared(new Set(before.keys()), new Set(after.keys()), (name) => before.get(name) !== after.get(name)),
  };
}

/** git's diff of two folders, its exit 1 meaning only that they differ. */
function diffFolders(from: string, to: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", from, to], { maxBuffer: 8 * PATCH_MAX }, (err, stdout) => {
      if (err && (err as unknown as { code?: unknown }).code !== 1) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * One skill's change from the installed plugin to its marketplace copy, for reading before an update:
 * the two folders named "installed" and "available" rather than by where they are on the machine,
 * each line held back that looks like it holds a secret, cut at PATCH_MAX. Null when it did not change.
 */
export async function pluginSkillPatch(installedDir: string, marketplaceDir: string, name: string): Promise<SkillPatch | null> {
  // A skill only one side has is compared with an empty folder, so a new one reads whole and a removed one as gone.
  const empty = mkdtempSync(join(tmpdir(), "skill-none-"));
  const side = (dir: string) => (existsSync(join(dir, "skills", name)) ? join(dir, "skills", name) : empty);
  const [from, to] = [side(installedDir), side(marketplaceDir)];
  const text = await diffFolders(from, to)
    .then((out) => out.replaceAll(from, "installed").replaceAll(to, "available"))
    .finally(() => rmSync(empty, { recursive: true, force: true }));
  if (!text.trim()) return null;
  const truncated = text.length > PATCH_MAX;
  const held = (line: string) => {
    const secret = detectSecret(line);
    return secret ? `[withheld: a line that looks like it holds a ${secret}]` : line;
  };
  return { patch: (truncated ? text.slice(0, PATCH_MAX) : text).split("\n").map(held).join("\n"), truncated };
}
