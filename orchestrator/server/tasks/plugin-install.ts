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

/** What the person can do to a plugin of theirs from the page: Claude Code's own command for each, nothing written by hand. */
export const PLUGIN_OPS = ["enable", "disable", "update", "uninstall", "install"] as const;
export type PluginOp = (typeof PLUGIN_OPS)[number];
/** What the runner runs: a plugin op, or "check" for the marketplaces. */
export type PluginAction = PluginOp | "check";
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}@[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SCOPES = new Set(["user", "project", "local"]);

export type PluginOpResult = { ok: true; command: string } | { ok: false; command: string; why: string };

/**
 * Runs `claude plugin <op> <id> -s <scope>` for one plugin the inventory lists, as an argument list
 * with no shell. The id and scope are checked before anything runs; the answer names the command
 * that ran, and a refusal says what Claude Code said, masked and cut.
 */
export async function runPluginOp(program: string, env: Record<string, string>, cwd: string, op: PluginAction, id: string, scope: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<PluginOpResult> {
  // "check" is the one command that names no plugin: Claude Code refreshes every marketplace it knows.
  const checking = op === "check";
  const command = checking ? "claude plugin marketplace update" : `claude plugin ${op} ${id}`;
  if (!checking && (!PLUGIN_OPS.includes(op as PluginOp) || !PLUGIN_ID.test(id) || !SCOPES.has(scope))) return { ok: false, command, why: "That is not a plugin this page changes." };
  let said = "";
  // An install goes to the person's own scope, Claude Code's default for it; the others name the scope it was installed in.
  const args = checking ? ["plugin", "marketplace", "update"] : op === "install" ? ["plugin", "install", id] : ["plugin", op, id, "-s", scope];
  const outcome = await runProcess({ program, args, env, cwd }, { timeoutMs, signal: new AbortController().signal, onLine: (_, line) => void (line.trim() && (said = line)) });
  if (outcome.timedOut) return { ok: false, command, why: "Claude Code did not answer in time; try again, or run the command in your terminal." };
  if (outcome.code !== 0) return { ok: false, command, why: cut(said) || "Claude Code refused it." };
  return { ok: true, command };
}
