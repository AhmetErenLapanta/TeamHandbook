import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TeamSetup } from "../server/inventory.js";

/**
 * The folder of the team's plugin as the person's Claude Code installed it, at the version the
 * task's commit names, or why it is not there. A run with only the person's sign-in loads no
 * installed plugin, so the machine hands this folder to the run itself (`--plugin-dir`). Read from
 * Claude Code 2.1.317's own record, `installed_plugins.json` (version 2): `plugins` maps
 * `<name>@<marketplace>` to its installs, each with its `installPath` and `version`; the plugins
 * root is CLAUDE_CODE_PLUGIN_CACHE_DIR, else `plugins` under CLAUDE_CONFIG_DIR or ~/.claude.
 * Only an install for the person, or one their organization manages, counts: a project's or a
 * folder's install belongs to another checkout.
 */
export function installedTeamPlugin(env: Record<string, string | undefined>, plugin: { name: string; version: string }): { dir: string } | { missing: string } {
  const home = env.HOME ?? "";
  const root = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "plugins");
  let record: { version?: unknown; plugins?: Record<string, unknown> };
  try {
    record = JSON.parse(readFileSync(join(root, "installed_plugins.json"), "utf8")) as typeof record;
  } catch {
    return { missing: `the team's plugin ${plugin.name} is not installed in your Claude Code` };
  }
  if (record.version !== 2 || !record.plugins || typeof record.plugins !== "object") return { missing: "your Claude Code keeps its installed plugins in a form this runner does not read" };
  const installs = Object.entries(record.plugins)
    .filter(([id]) => id.slice(0, id.lastIndexOf("@")) === plugin.name)
    .flatMap(([, entries]) => (Array.isArray(entries) ? (entries as Record<string, unknown>[]) : []))
    .filter((entry) => (entry.scope === "user" || entry.scope === "managed") && typeof entry.installPath === "string");
  if (!installs.length) return { missing: `the team's plugin ${plugin.name} is not installed in your Claude Code` };
  const at = installs.find((entry) => entry.version === plugin.version);
  if (!at) return { missing: `your Claude Code has ${plugin.name} ${installs.map((e) => String(e.version)).join(", ")}, and this task's commit is on ${plugin.version}; update the plugin` };
  const dir = at.installPath as string;
  // The folder has to be the plugin it is recorded as, or a run would load whatever stands there now.
  try {
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    if (manifest.name !== plugin.name) return { missing: `the folder your Claude Code records for ${plugin.name} holds another plugin` };
  } catch {
    return { missing: existsSync(dir) ? `the folder your Claude Code records for ${plugin.name} has no plugin manifest` : `the folder your Claude Code records for ${plugin.name} is gone` };
  }
  return { dir };
}

export async function installedTeamSkills(dir: string): Promise<TeamSetup["skills"]> {
  const root = join(dir, "skills");
  const skills: TeamSetup["skills"] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const files = await filesUnder(join(root, entry.name), "");
    if (files.some((file) => file.path === "SKILL.md")) skills.push({ slug: entry.name, files });
  }
  return skills;
}

async function filesUnder(dir: string, prefix: string): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(join(dir, entry.name), path)));
    else if (entry.isFile()) files.push({ path, content: await readFile(join(dir, entry.name), "utf8") });
  }
  return files;
}
