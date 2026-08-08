import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handbookHome } from "./session-state.js";

/**
 * Read and parse ~/.teamhandbook/config.json, returning {} if it's absent or
 * malformed. Each section loader (gate, distill, team, notify) applies its own
 * typed validation and defaults on top — this only removes the repeated
 * read-and-parse plumbing.
 */
export function readConfigFile(home: string = handbookHome()): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
