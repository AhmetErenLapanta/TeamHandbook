import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";

export function configFile(home: string = handbookHome()): string {
  return join(home, "config.json");
}

/**
 * Read and parse ~/.teamhandbook/config.json, returning {} if it's absent or
 * malformed. Each section loader (harvest, gate, distill, team, notify) applies its
 * own typed validation and defaults on top — this only removes the repeated
 * read-and-parse plumbing.
 */
export function readConfigFile(home: string = handbookHome()): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(configFile(home), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Is the config file PRESENT but unreadable/unparseable? A missing file is the
 * normal first-run state and means "defaults"; a broken one means the user wrote
 * something and we cannot tell what. That distinction matters for exactly two
 * settings — the privacy kill switches — which must fail CLOSED: a trailing comma
 * in a hand-edited file must never turn `{"harvest": {"enabled": false}}` back into
 * "send my whole session to the model". Everything else keeps defaulting, so one
 * typo cannot brick the plugin.
 */
export function configIsBroken(home: string = handbookHome()): boolean {
  const file = configFile(home);
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  } catch {
    return true;
  }
}
