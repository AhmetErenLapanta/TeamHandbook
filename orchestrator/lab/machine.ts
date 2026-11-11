import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { labEnv } from "./run.js";
import type { Consent, LabDeveloper, LabState } from "./state.js";

/**
 * A teammate's machine: a home of its own, the plugin's real bundles from dist/ run by node as
 * Claude Code would run its hooks and commands, and the team copy Claude Code keeps under
 * ~/.claude/plugins/marketplaces. Claude Code itself is not here: adding and updating the
 * marketplace is what it does with git, and the stand-in claude on the lab's PATH answers only
 * its version. Nothing reads or writes the account's own ~/.claude or ~/.teamhandbook.
 */

export interface Machine {
  home: string;
  handbook: string;
  path: string;
  pluginDist: string;
}

export interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

export function machineOf(lab: Pick<LabState, "path" | "pluginDist">, dev: Pick<LabDeveloper, "home" | "handbook">): Machine {
  return { home: dev.home, handbook: dev.handbook, path: lab.path, pluginDist: lab.pluginDist };
}

function envOf(m: Machine): NodeJS.ProcessEnv {
  return labEnv(m.path, { HOME: m.home, TEAMHANDBOOK_HOME: m.handbook, TMPDIR: join(m.home, "tmp") });
}

function run(m: Machine, command: string, args: string[], options: { input?: string; cwd?: string } = {}): Ran {
  const result = spawnSync(command, args, { cwd: options.cwd ?? m.home, input: options.input, encoding: "utf8", env: envOf(m), timeout: 120_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? (result.error ? String(result.error) : "") };
}

function plugin(m: Machine, bundle: string, args: string[] = [], input?: string): Ran {
  return run(m, "node", [join(m.pluginDist, bundle), ...args], { input });
}

function git(m: Machine, args: string[], cwd?: string): Ran {
  const ran = run(m, "git", args, { cwd });
  if (ran.status !== 0) throw new Error(`git ${args[0]} failed on a lab machine: ${ran.stderr.trim()}`);
  return ran;
}

/** A fresh home with a git identity and a TeamHandbook config whose harvest is off: nothing here calls a model. */
export function createMachine(root: string, name: string): { home: string; handbook: string } {
  const home = join(root, name, "home");
  const handbook = join(home, ".teamhandbook");
  for (const dir of [handbook, join(home, "tmp"), join(home, ".claude", "plugins", "marketplaces")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), `[user]\n\tname = ${name}\n\temail = ${name}@dev.example.invalid\n`);
  writeFileSync(join(handbook, "config.json"), JSON.stringify({ harvest: { enabled: false } }, null, 2) + "\n");
  return { home, handbook };
}

export function joinTeam(m: Machine, url: string): Ran {
  return plugin(m, "join.js", [url]);
}

export function teamConfig(m: Machine): { repoUrl: string; marketplaceName: string; commitPrefix?: string; branchExample?: string } | null {
  return (readConfig(m).team as ReturnType<typeof teamConfig>) ?? null;
}

export function copyDir(m: Machine): string | null {
  const team = teamConfig(m);
  return team ? join(m.home, ".claude", "plugins", "marketplaces", team.marketplaceName) : null;
}

/** `/plugin marketplace add <url>`: Claude Code clones the team repository under the marketplace's name. */
export function addMarketplace(m: Machine): string {
  const team = teamConfig(m);
  const copy = copyDir(m);
  if (!team || !copy) throw new Error("the machine has not joined a team");
  if (!existsSync(copy)) git(m, ["clone", "--quiet", "--", team.repoUrl, copy]);
  return copy;
}

/** `/plugin marketplace update`: the copy moves to what the team repository's default branch holds now. */
export function updateMarketplace(m: Machine): void {
  const copy = copyDir(m);
  if (!copy) throw new Error("the machine has not joined a team");
  git(m, ["pull", "--quiet", "--ff-only"], copy);
}

export function copyHead(m: Machine): string {
  return git(m, ["rev-parse", "HEAD"], copyDir(m) ?? m.home).stdout.trim();
}

export function copyFile(m: Machine, path: string): string | null {
  const copy = copyDir(m);
  const file = copy ? join(copy, path) : null;
  return file && existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function doctor(m: Machine): { output: string; teamCopy: string | null; teamRepo: string | null } {
  const ran = plugin(m, "doctor.js");
  const line = (name: string) => ran.stdout.split("\n").find((l) => l.includes(` ${name}: `))?.trim() ?? null;
  return { output: ran.stdout, teamCopy: line("team plugin copy"), teamRepo: line("team repo") };
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command: string }[];
}

/** What the plugin's hooks answered for one event: each command's output, and a PreToolUse decision when one denied. */
export interface HookAnswer {
  ran: number;
  stdout: string;
  stderr: string;
  /** For PreToolUse: why a hook blocked the call, by exit code 2 or by `permissionDecision: "deny"`. */
  denied: string | null;
  ms: number;
}

/**
 * Claude Code's matcher rule: none, empty or `*` takes every tool; one made only of letters,
 * digits, `_`, `-`, spaces, commas and `|` is a list of exact names; anything else is a
 * regular expression that matches anywhere in the name.
 */
function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((n) => n.trim()).includes(tool);
  return new RegExp(matcher).test(tool);
}

/**
 * One hook event run the way Claude Code runs a plugin's: every command `hooks/hooks.json`
 * registers for the event whose matcher takes the tool, with CLAUDE_PLUGIN_ROOT set and the
 * event's JSON on stdin. A hook the plugin does not register does not run, as in a session.
 */
export function runHook(m: Machine, event: string, input: Record<string, unknown>): HookAnswer {
  const root = dirname(m.pluginDist);
  const entries = (JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, HookEntry[]> }).hooks[event] ?? [];
  const tool = typeof input.tool_name === "string" ? input.tool_name : "";
  const answer: HookAnswer = { ran: 0, stdout: "", stderr: "", denied: null, ms: 0 };
  const started = Date.now();
  for (const entry of entries.filter((e) => matches(e.matcher, tool))) {
    for (const hook of entry.hooks.filter((h) => h.type === "command")) {
      const result = spawnSync("sh", ["-c", hook.command], {
        cwd: m.home,
        input: JSON.stringify({ hook_event_name: event, ...input }),
        encoding: "utf8",
        env: { ...envOf(m), CLAUDE_PLUGIN_ROOT: root },
        timeout: 60_000,
      });
      answer.ran += 1;
      answer.stdout += result.stdout ?? "";
      answer.stderr += result.stderr ?? "";
      if (result.status === 2) answer.denied ??= (result.stderr ?? "").trim();
      try {
        const out = JSON.parse(result.stdout ?? "") as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
        if (out.hookSpecificOutput?.permissionDecision === "deny") answer.denied ??= out.hookSpecificOutput.permissionDecisionReason ?? "";
      } catch {
        // plain text output: nothing decided
      }
    }
  }
  answer.ms = Date.now() - started;
  return answer;
}

/** The line a session starts with, as the session-start hook prints it. */
export function sessionStart(m: Machine, session: string): string {
  return runHook(m, "SessionStart", { session_id: session, cwd: m.home, source: "startup" }).stdout;
}

/** One turn that calls a skill, by the name Claude Code gives it, and ends. */
export function useSkill(m: Machine, skill: string, session: string): void {
  callTool(m, session, "Skill", { skill });
  runHook(m, "Stop", { session_id: session, cwd: m.home });
}

/**
 * The name Claude Code gives a tool of an MCP server a plugin ships:
 * `mcp__plugin_<plugin>_<server>__<tool>`, every character outside letters, digits, `_` and `-`
 * replaced with `_`. A team's servers reach a teammate inside the team plugin, so this is the
 * name a teammate's session calls them by.
 */
export function pluginMcpTool(plugin: string, server: string, tool: string): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__plugin_${clean(plugin)}_${clean(server)}__${clean(tool)}`;
}

/**
 * A tool call in a session: PreToolUse first, and only when no hook denied it, the call and
 * PostToolUse. Returns what the PreToolUse hooks answered; `denied` is null when the call ran.
 */
export function callTool(m: Machine, session: string, tool: string, toolInput: Record<string, unknown>, mcpServer?: { name: string; source: string }): HookAnswer {
  const asked = { session_id: session, cwd: m.home, tool_name: tool, tool_input: toolInput, ...(mcpServer ? { mcp_server: mcpServer } : {}) };
  const before = runHook(m, "PreToolUse", asked);
  if (before.denied === null) runHook(m, "PostToolUse", { ...asked, tool_response: {} });
  return before;
}

function readConfig(m: Machine): Record<string, unknown> {
  return JSON.parse(readFileSync(join(m.handbook, "config.json"), "utf8")) as Record<string, unknown>;
}

/** The developer's own answer: agreeing names the exact address the team file asks for. */
export function answerUsage(m: Machine, consent: Consent, endpoint: string): void {
  const config = readConfig(m);
  if (consent === "undecided") delete config.usage;
  else config.usage = { shareWith: consent === "agree" ? endpoint : false };
  writeFileSync(join(m.handbook, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

export function outboxExists(m: Machine): boolean {
  return existsSync(join(m.handbook, "usage-outbox.jsonl"));
}
