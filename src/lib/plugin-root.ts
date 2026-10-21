import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed plugin's version, for support/bug reports. The bundle runs from
 * <plugin-root>/dist and the source tests from <root>/src/lib, so walk up a
 * couple of levels looking for .claude-plugin/plugin.json.
 */
export function pluginVersion(): string {
  const root = pluginRoot();
  if (!root) return "unknown";
  try {
    const parsed = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof parsed?.version === "string") return parsed.version;
  } catch {
    // unreadable after all
  }
  return "unknown";
}

/** The directory the running plugin was installed into: the one holding its manifest.
 * Any manifest that parses marks it, a version or not: the refresh reads its release from
 * package.json beside it, and a root that vanished with the manifest's version line took
 * every refresh down with it. */
export function pluginRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    try {
      const parsed = JSON.parse(readFileSync(join(here, up, ".claude-plugin", "plugin.json"), "utf8"));
      if (parsed && typeof parsed === "object") return join(here, up);
    } catch {
      // keep walking
    }
  }
  return null;
}

/**
 * TeamHandbook's own release, read from the package.json the plugin is installed with, or
 * null when it cannot be read.
 *
 * Not to be confused with the version in a TEAM repository's plugin.json, which every share
 * raises and which says nothing about which TeamHandbook wrote the files around it. This one
 * moves only when TeamHandbook is released, so it stays the answer to "which release wrote
 * this scaffold" whatever the team's own version does.
 */
export function productVersion(root: string | null = pluginRoot()): string | null {
  if (!root) return null;
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}
