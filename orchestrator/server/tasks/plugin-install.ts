import { redactLine } from "../log.js";
import { REPOSITORY } from "../update.js";
import { runProcess } from "./isolation.js";

/** Where the handbook plugin's marketplace is (this product's own repository, as owner/name) and what it is called there: the two commands the README gives a person. */
export const HANDBOOK_MARKETPLACE = new URL(REPOSITORY).pathname.replace(/^\//, "");
export const HANDBOOK_PLUGIN = "handbook@teamhandbook";

const INSTALL_TIMEOUT_MS = 120_000;
const WHY_MAX = 300;

export type PluginInstall = { installed: true } | { installed: false; why: string };

/** A command's last line that is not blank, masked and cut: what a person reads when it did not work. */
function cut(line: string): string {
  const masked = redactLine(line.trim());
  return masked.length > WHY_MAX ? `${masked.slice(0, WHY_MAX - 1)}…` : masked;
}

/**
 * Adds the handbook marketplace to a person's Claude Code and installs the plugin from it, as
 * `claude plugin marketplace add` and `claude plugin install` do, in the person's own Claude
 * Code folder. Run only after their click; a refusal of either step says what the CLI said.
 */
export async function installHandbookPlugin(program: string, env: Record<string, string>, cwd: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<PluginInstall> {
  for (const args of [["plugin", "marketplace", "add", HANDBOOK_MARKETPLACE], ["plugin", "install", HANDBOOK_PLUGIN]]) {
    let said = "";
    const outcome = await runProcess({ program, args, env, cwd }, { timeoutMs, signal: new AbortController().signal, onLine: (_, line) => void (line.trim() && (said = line)) });
    if (outcome.timedOut) return { installed: false, why: "Claude Code did not answer in time; try again, or type the two commands in Claude Code yourself." };
    if (outcome.code !== 0) return { installed: false, why: cut(said) || "Claude Code refused the install; type the two commands in Claude Code yourself." };
  }
  return { installed: true };
}
