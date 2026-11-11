import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the settings that decide whether this plugin's hooks run are read from. */
export interface HookSettingsPaths {
  /** The system directory holding managed-settings.json and managed-settings.d/. */
  managedDir: string;
  /** The directory holding the user's settings.json: ~/.claude, or CLAUDE_CONFIG_DIR. */
  userDir: string;
  /** The project whose .claude/settings.json and .claude/settings.local.json apply. */
  projectDir: string;
}

export type HookSettingsState =
  | { state: "on" }
  | { state: "off"; setting: "allowManagedHooksOnly" | "disableAllHooks"; file: string }
  | { state: "unknown"; file: string; reason: string };

// The paths Claude Code documents for a managed settings file, per system.
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export function defaultHookSettingsPaths(): HookSettingsPaths {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return { managedDir: managedSettingsDir(), userDir: configDir || join(homedir(), ".claude"), projectDir: process.cwd() };
}

class Unreadable extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(reason);
  }
}

function readObject(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Unreadable(file, (err as NodeJS.ErrnoException).code ?? "not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Unreadable(file, "not a JSON object");
  return parsed as Record<string, unknown>;
}

interface Source {
  file: string;
  settings: Record<string, unknown>;
}

/**
 * managed-settings.json first, then each managed-settings.d/*.json in alphabetical order,
 * hidden files skipped, as Claude Code merges them: a later file's key wins, and an object
 * such as enabledPlugins merges key by key. Each key remembers the file it came from.
 */
function managedSources(dir: string): Source[] {
  const sources: Source[] = [];
  const main = readObject(join(dir, "managed-settings.json"));
  if (main) sources.push({ file: join(dir, "managed-settings.json"), settings: main });
  const dropIns = join(dir, "managed-settings.d");
  if (existsSync(dropIns)) {
    let names: string[];
    try {
      names = readdirSync(dropIns);
    } catch (err) {
      throw new Unreadable(dropIns, (err as NodeJS.ErrnoException).code ?? "not readable");
    }
    for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const settings = readObject(join(dropIns, name));
      if (settings) sources.push({ file: join(dropIns, name), settings });
    }
  }
  return sources;
}

function lastSetting(sources: Source[], key: string): { value: unknown; file: string } | null {
  for (const source of [...sources].reverse()) {
    if (key in source.settings) return { value: source.settings[key], file: source.file };
  }
  return null;
}

/** Whether managed settings force-enable this plugin, which keeps its hooks under allowManagedHooksOnly. */
function forceEnabled(sources: Source[], plugin: string): boolean {
  let enabled = false;
  for (const { settings } of sources) {
    const plugins = settings.enabledPlugins;
    if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
      for (const [key, value] of Object.entries(plugins)) {
        if (key.split("@")[0] === plugin) enabled = value === true;
      }
    }
  }
  return enabled;
}

/**
 * Whether the settings on this machine let this plugin's hooks run, read the way the hooks
 * and settings documentation describes it: `allowManagedHooksOnly` in managed settings blocks
 * every plugin's hooks unless managed `enabledPlugins` force-enables that plugin, and
 * `disableAllHooks` takes the value the settings precedence leaves (managed, then project
 * local, then shared project, then user). A file that exists and cannot be read makes the
 * answer unknown, never "on". A policy delivered by MDM or the claude.ai console and a
 * `--settings` flag are not visible from here.
 */
export function hookSettingsState(plugin: string, paths: HookSettingsPaths = defaultHookSettingsPaths()): HookSettingsState {
  try {
    const managed = managedSources(paths.managedDir);
    const managedOnly = lastSetting(managed, "allowManagedHooksOnly");
    if (managedOnly?.value === true && !forceEnabled(managed, plugin)) return { state: "off", setting: "allowManagedHooksOnly", file: managedOnly.file };
    const ladder: Source[] = [];
    for (const file of [join(paths.userDir, "settings.json"), join(paths.projectDir, ".claude", "settings.json"), join(paths.projectDir, ".claude", "settings.local.json")]) {
      const settings = readObject(file);
      if (settings) ladder.push({ file, settings });
    }
    const disabled = lastSetting(managed, "disableAllHooks") ?? lastSetting(ladder, "disableAllHooks");
    if (disabled?.value === true) return { state: "off", setting: "disableAllHooks", file: disabled.file };
    return { state: "on" };
  } catch (err) {
    if (err instanceof Unreadable) return { state: "unknown", file: err.file, reason: err.message };
    throw err;
  }
}
