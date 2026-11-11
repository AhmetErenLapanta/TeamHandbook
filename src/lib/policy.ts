import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";
import type { HookInput } from "./hook-io.js";
import { loadTeamConfig, marketplacesRoot, TEAM_PREFIX_FILE } from "./init.js";
import { detectSecret } from "./secrets.js";
import { handbookHome } from "./session-state.js";
import { programOf, simpleCommands } from "./shell-command.js";

/**
 * A team's policies: named groups of statements in the team file, each taking a capability
 * away from every session that has the team's copy. They only ever tighten. Giving a
 * capability is adding a skill or a server through a reviewed request, so there is no
 * `allow` to lift a deny with, and a session with no policy loses nothing.
 */
export interface TeamFilePolicy {
  id: string;
  name: string;
  rules: PolicyRule[];
}

export interface PolicyRule {
  action: PolicyAction;
  resource: string;
  effect: "deny";
  reason: string;
}

export const POLICY_ACTIONS = ["mcp.use", "skill.use", "tool.use"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/**
 * The tools a `tool:` rule can name, each with the input field its pattern is matched
 * against. `Edit` stands for every tool that changes a file, as Claude Code's own Edit rules
 * do: a rule against editing `.env` that `Write` walked past would hold nothing.
 */
export const POLICY_TOOLS: Record<string, { tools: string[]; field: string | null }> = {
  Bash: { tools: ["Bash"], field: "command" },
  Read: { tools: ["Read"], field: "file_path" },
  Edit: { tools: ["Edit", "MultiEdit", "Write", "NotebookEdit"], field: "file_path" },
  Glob: { tools: ["Glob"], field: "path" },
  Grep: { tools: ["Grep"], field: "path" },
  WebFetch: { tools: ["WebFetch"], field: "url" },
  WebSearch: { tools: ["WebSearch"], field: "query" },
};

export const POLICY_MAX_POLICIES = 50;
/** An orchestrator policy holds 1 to 20 rules of up to 20 resources each, and each resource is one statement here. */
export const POLICY_MAX_RULES = 20;
export const POLICY_MAX_RESOURCES = 20;
export const POLICY_MAX_STATEMENTS = POLICY_MAX_RULES * POLICY_MAX_RESOURCES;
export const POLICY_NAME_MAX = 100;
const POLICY_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const POLICY_REASON_MAX = 200;
export const POLICY_PATTERN_MAX = 200;

const NAME = /^[A-Za-z0-9_.*-]+$/;
const SKILL = /^[A-Za-z0-9_.:*-]+$/;
const KEYS = new Set(["action", "resource", "effect", "reason"]);

function printableProblem(value: string, max: number, what: string): string | null {
  if (!value.trim()) return `its ${what} is empty`;
  if (value.length > max) return `its ${what} is longer than ${max} characters`;
  // \p{C} is every control, format and unassigned code point, newlines and ESC included: the
  // reason is printed into a session, and a line it could break or recolour is not a reason.
  if (/\p{C}/u.test(value)) return `its ${what} carries a control character`;
  return null;
}

function resourceProblem(action: PolicyAction, resource: string): string | null {
  const [kind, ...rest] = resource.split(":");
  const value = rest.join(":");
  if (action === "mcp.use") {
    if (kind !== "mcp") return "an mcp.use rule names mcp:<server> or mcp:<server>/<tool>";
    const [server, tool, extra] = value.split("/");
    if (extra !== undefined || !server || !NAME.test(server) || (tool !== undefined && (!tool || !NAME.test(tool)))) {
      return "an mcp.use rule names mcp:<server> or mcp:<server>/<tool>, in letters, digits, _ . - and *";
    }
    return null;
  }
  if (action === "skill.use") {
    if (kind !== "skill" || !value || !SKILL.test(value)) return "a skill.use rule names skill:<skill>, in letters, digits, _ . : - and *";
    return null;
  }
  const tool = rest[0];
  const pattern = rest.slice(1).join(":");
  if (kind !== "tool" || tool === undefined || rest.length < 2) return "a tool.use rule names tool:<tool>:<pattern>";
  if (!Object.hasOwn(POLICY_TOOLS, tool)) return `a tool.use rule names one of ${Object.keys(POLICY_TOOLS).join(", ")}, not ${JSON.stringify(tool)}`;
  return printableProblem(pattern, POLICY_PATTERN_MAX, "pattern");
}

/** Why one statement is not a policy rule, or null when it is one. */
export function ruleProblem(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "it is not an object";
  const rule = raw as Record<string, unknown>;
  const extra = Object.keys(rule).filter((key) => !KEYS.has(key));
  if (extra.length) return `it has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a rule does not take`;
  if (typeof rule.action !== "string" || !(POLICY_ACTIONS as readonly string[]).includes(rule.action)) return `its action is not one of ${POLICY_ACTIONS.join(", ")}`;
  if (rule.effect !== "deny") return 'its effect is not "deny": a policy only takes away, and a capability is given by adding it in a reviewed request';
  if (typeof rule.resource !== "string") return "it has no resource";
  if (typeof rule.reason !== "string") return "it has no reason";
  const reason = printableProblem(rule.reason, POLICY_REASON_MAX, "reason");
  if (reason) return reason;
  const resource = resourceProblem(rule.action as PolicyAction, rule.resource);
  if (resource) return resource;
  // The team file is read into every teammate's session and travels in requests.
  const secret = detectSecret(`${rule.resource}\n${rule.reason}`);
  return secret ? `it looks like it contains a secret (${secret})` : null;
}

/** Why one policy's statements are not rules, naming the first at fault; null when they are. */
export function rulesProblem(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return "it has no rules";
  if (value.length > POLICY_MAX_STATEMENTS) return `it has more than ${POLICY_MAX_STATEMENTS} rules`;
  for (const [index, rule] of value.entries()) {
    const problem = ruleProblem(rule);
    if (problem) return `rule ${index + 1}: ${problem}`;
  }
  return null;
}

/**
 * Why a team file's `policies` are not policies, naming the first one at fault; null when
 * they are. A statement this release does not know is a fault rather than a rule to skip: a
 * newer orchestrator's rule read as nothing would lift what it was written to hold.
 */
export function policiesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "policies is not a list";
  if (value.length > POLICY_MAX_POLICIES) return `policies has more than ${POLICY_MAX_POLICIES} entries`;
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const at = `policy ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} is not an object`;
    const policy = raw as Record<string, unknown>;
    const extra = Object.keys(policy).filter((key) => !["id", "name", "rules"].includes(key));
    if (extra.length) return `${at} has ${extra.map((k) => JSON.stringify(k)).join(", ")}, which a policy does not take`;
    if (typeof policy.id !== "string" || !POLICY_ID.test(policy.id)) return `${at} has no id of letters, digits, _ and -`;
    if (ids.has(policy.id)) return `${at} repeats the id ${policy.id}`;
    ids.add(policy.id);
    const name = typeof policy.name === "string" ? printableProblem(policy.name, POLICY_NAME_MAX, "name") : "its name is missing";
    if (name) return `${at} (${policy.id}): ${name}`;
    const rules = rulesProblem(policy.rules);
    if (rules) return `${at} (${policy.id}): ${rules}`;
  }
  return null;
}

/** Every rule of a team file's policies, in the order written: the last match decides. */
export function policyRules(policies: readonly TeamFilePolicy[]): PolicyRule[] {
  return policies.flatMap((p) => p.rules);
}

/**
 * A pattern's `*` matches any run of characters, `/` and spaces included; everything else
 * matches itself, over the whole value. Matched by walking both once with one fallback point,
 * never a regular expression: an anchored `*a*b*c*` against a long command line backtracks for
 * seconds, measured at 21.8 s on 18 KB, and the hook runs before every tool call.
 */
export function patternMatches(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (star >= 0) {
      p = star + 1;
      v = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** A server or tool name as Claude Code puts it in a tool's name: every character but letters, digits, _ and - becomes _. */
export function mcpToolPart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_*-]/g, "_");
}

/**
 * The names a server's tools reach a session under. A server the user configured is
 * `mcp__<server>__<tool>`; one a plugin ships is `mcp__plugin_<plugin>_<server>__<tool>`, and
 * a plugin's name is kebab-case, so the first underscore after `plugin_` ends it. A team's
 * rule names the server as its `.mcp.json` does and holds under both.
 */
function mcpCall(toolName: string): { servers: string[]; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice(5);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const server = rest.slice(0, split);
  const servers = [server];
  const plugin = server.startsWith("plugin_") ? server.slice(7) : null;
  const end = plugin?.indexOf("_") ?? -1;
  if (plugin && end > 0) servers.push(plugin.slice(end + 1));
  return { servers, tool: rest.slice(split + 2) };
}

/** Words a shell reads as its own grammar ahead of a command: `{ cmd; }`, `if`/`while` bodies, `! cmd`. */
const SHELL_KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "time"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
/** xargs options that take the next word as their value. */
const XARGS_VALUED = new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]);

/** The text inside each `$(...)`, `<(...)`, `>(...)` and backtick pair: commands the shell runs before the line's own. */
function substitutions(line: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < line.length; i++) {
    if ((line[i] === "$" || line[i] === "<" || line[i] === ">") && line[i + 1] === "(") {
      let depth = 0;
      for (let j = i + 1; j < line.length; j++) {
        if (line[j] === "(") depth++;
        else if (line[j] === ")" && --depth === 0) {
          found.push(line.slice(i + 2, j));
          break;
        }
      }
    }
  }
  for (const m of line.matchAll(/`([^`]*)`/g)) found.push(m[1]!);
  return found;
}

/**
 * What a shell rule's pattern is matched against: the line as written and each command the
 * shell would run from it, past its grammar (`{ }`, `if`, `do`), substitutions, wrappers
 * (`env`, `timeout`, `xargs`), `sh -c` and `eval`, with the program also read by its base name
 * and in lower case, since `/usr/bin/git` and, on a case-insensitive disk, `GIT` both run git.
 * It narrows what habit reaches, and is no sandbox: a script or an alias still runs unseen.
 */
function shellCandidates(line: string, depth: number): Set<string> {
  const out = new Set<string>([line.trim()]);
  if (depth > 3) return out;
  for (const inner of substitutions(line)) for (const c of shellCandidates(inner, depth + 1)) out.add(c);
  for (const cmd of simpleCommands(line)) {
    let words = cmd.words;
    while (words.length && SHELL_KEYWORDS.has(words[0]!)) words = words.slice(1);
    words = programOf({ ...cmd, words });
    while (words.length && basename(words[0]!) === "xargs") {
      let i = 1;
      while (i < words.length && words[i]!.startsWith("-")) i += XARGS_VALUED.has(words[i]!) ? 2 : 1;
      words = programOf({ ...cmd, words: words.slice(i) });
    }
    if (!words.length) continue;
    const program = basename(words[0]!);
    const at = words.indexOf("-c");
    if (SHELLS.has(program) && at > 0 && words[at + 1]) for (const c of shellCandidates(words[at + 1]!, depth + 1)) out.add(c);
    if (program === "eval") for (const c of shellCandidates(words.slice(1).join(" "), depth + 1)) out.add(c);
    const rest = words.slice(1);
    for (const name of [words[0]!, program, program.toLowerCase()]) out.add([name, ...rest].join(" "));
    out.add(cmd.words.join(" "));
  }
  return out;
}

/** What a tool rule's pattern is matched against: the input as given, and for a shell line each command in it. */
function toolValues(tool: string, input: Record<string, unknown>, cwd: string | undefined): string[] {
  const named = Object.entries(POLICY_TOOLS).find(([, spec]) => spec.tools.includes(tool));
  if (!named) return [];
  const field = named[1].field;
  const raw = field ? (input[field] ?? (tool === "NotebookEdit" ? input.notebook_path : undefined)) : undefined;
  const value = typeof raw === "string" ? raw : (field === "path" && cwd) || "";
  if (tool === "Bash") return [...shellCandidates(value, 0)];
  // An absolute path is read as written and as it resolves, so `/w/x/../secrets/a`,
  // `/w//secrets/a` and `/w/./secrets/a` meet a rule written for `/w/secrets/*`.
  if ((field === "file_path" || field === "path") && value) {
    if (isAbsolute(value)) return [value, resolve(value)];
    if (cwd) return [value, resolve(cwd, value)];
  }
  return [value];
}

/** The rule that decides a call, or null when none matches. The last match wins, so the reason shown is the one written last. */
export function policyDenial(rules: readonly PolicyRule[], call: Pick<HookInput, "tool_name" | "tool_input" | "cwd">): PolicyRule | null {
  const name = call.tool_name ?? "";
  const input = call.tool_input ?? {};
  const mcp = mcpCall(name);
  const skill = name === "Skill" && typeof input.skill === "string" ? input.skill : null;
  let decided: PolicyRule | null = null;
  for (const rule of rules) {
    const [kind, ...rest] = rule.resource.split(":");
    const value = rest.join(":");
    let hit = false;
    if (kind === "mcp" && mcp) {
      const [server, tool] = value.split("/").map(mcpToolPart);
      hit = mcp.servers.some((s) => patternMatches(server!, s)) && (tool === undefined || patternMatches(tool, mcp.tool));
    } else if (kind === "skill" && skill) {
      hit = patternMatches(value, skill) || patternMatches(value, skill.slice(skill.lastIndexOf(":") + 1));
    } else if (kind === "tool") {
      const spec = POLICY_TOOLS[rest[0]!];
      const pattern = rest.slice(1).join(":");
      hit = !!spec?.tools.includes(name) && toolValues(name, input, call.cwd).some((v) => patternMatches(pattern, v));
    }
    if (hit) decided = rule;
  }
  return decided;
}

/** The rules in force, where they were read, and why the team's own file was not used when it was not. */
export interface TeamPolicy {
  source: "none" | "team" | "cache";
  rules: PolicyRule[];
  /** The team's copy on this machine, where a rule's origin is looked up. */
  copy?: string;
  problem?: string;
  /** When the cached rules were read from a good file. */
  savedAt?: string;
}

interface PolicyCache {
  marketplace: string;
  rules: PolicyRule[];
  savedAt: string;
}

export function policyCacheFile(home: string = handbookHome()): string {
  return join(home, "policy-cache.json");
}

function readCache(home: string, marketplace: string): PolicyCache | null {
  try {
    const cache = JSON.parse(readFileSync(policyCacheFile(home), "utf8")) as PolicyCache;
    return cache.marketplace === marketplace && Array.isArray(cache.rules) && cache.rules.every((r) => ruleProblem(r) === null) ? cache : null;
  } catch {
    return null;
  }
}

/**
 * The policy this machine's copy of the team repository carries. A team file that cannot be
 * read, or whose policy breaks the grammar, does not lift the rules: the last policy read
 * from a good file stays in force, and the problem is reported. With no good file ever read
 * nothing is blocked, so a broken file can never lock every teammate out of their sessions.
 * Only the local copy is read; nothing here reaches the network.
 */
export function teamPolicy(home: string = handbookHome(), root: string = marketplacesRoot(), now: () => string = () => new Date().toISOString()): TeamPolicy {
  const team = loadTeamConfig(home);
  if (!team) return { source: "none", rules: [] };
  const copy = join(root, team.marketplaceName);
  let problem: string;
  let text: string | null = null;
  try {
    text = readFileSync(join(copy, TEAM_PREFIX_FILE), "utf8");
  } catch (err) {
    // A scaffold older than the team file has no policy to read; a copy that is not there at
    // all is the one this machine cannot read.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && readable(copy)) return { source: "team", rules: [], copy };
  }
  if (text === null) {
    problem = `${TEAM_PREFIX_FILE} in the team's copy cannot be read`;
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).policies : undefined;
    if (parsed === undefined || (parsed !== null && typeof parsed !== "object") || Array.isArray(parsed)) {
      problem = `${TEAM_PREFIX_FILE} in the team's copy is not a JSON object`;
    } else if (value === undefined) {
      return { source: "team", rules: [], copy };
    } else {
      const grammar = policiesProblem(value);
      if (!grammar) {
        const rules = policyRules(value as TeamFilePolicy[]);
        const cached = readCache(home, team.marketplaceName);
        if (!cached || JSON.stringify(cached.rules) !== JSON.stringify(rules)) {
          try {
            writeFileAtomic(policyCacheFile(home), JSON.stringify({ marketplace: team.marketplaceName, rules, savedAt: now() } satisfies PolicyCache, null, 2) + "\n");
          } catch {
            // A cache that cannot be written leaves this read in force; only a later broken file loses it.
          }
        }
        return { source: "team", rules, copy };
      }
      problem = `the policies in ${TEAM_PREFIX_FILE} are not valid: ${grammar}`;
    }
  }
  const cached = readCache(home, team.marketplaceName);
  return cached ? { source: "cache", rules: cached.rules, problem, savedAt: cached.savedAt, copy } : { source: "none", rules: [], problem, copy };
}

function readable(dir: string): boolean {
  try {
    readFileSync(join(dir, ".claude-plugin", "plugin.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The commit that brought a rule into the team's copy: the newest one that changed how often
 * its resource appears in the team file. Read only for a call being blocked, never on the
 * path every allowed call takes; null when the copy is not a git checkout or git is slow.
 */
export function policyOrigin(copy: string, rule: PolicyRule): string | null {
  try {
    const sha = execFileSync("git", ["-C", copy, "log", "-1", "--format=%h", `-S${JSON.stringify(rule.resource)}`, "--", TEAM_PREFIX_FILE], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The words a blocked call answers with: the team's reason, the rule, and where it came from. */
export function denialMessage(rule: PolicyRule, origin: string | null): string {
  return `Blocked by the team's policy: ${rule.reason} (${rule.action} ${rule.resource}${origin ? `, added in ${origin}` : ""}).`;
}

/** The session-start line for a policy that could not be read, or null when there is nothing to say. */
export function policyNotice(policy: TeamPolicy): string | null {
  if (!policy.problem) return null;
  if (policy.source === "cache") {
    return `TeamHandbook: ${policy.problem}. The team's policy as last read on ${policy.savedAt?.slice(0, 10)} stays in force (${policy.rules.length} rule(s)) until the team's copy carries a valid one.`;
  }
  return `TeamHandbook: ${policy.problem}. No valid policy was read on this machine before, so nothing is blocked until the team's copy carries one.`;
}

/**
 * A team's rules as Claude Code's own `permissions.deny` entries, for an organization that
 * enforces them through managed settings rather than, or beside, the plugin's hook. A rule
 * Claude Code's syntax cannot say is listed with the reason instead of being widened or
 * dropped in silence; a path rule is translated to Claude Code's gitignore-style paths, which
 * read `*` within one directory where a team rule's `*` spans directories, so each one is
 * named as approximate.
 */
export function claudeDenyRules(rules: readonly PolicyRule[], teamPlugin?: string): { deny: string[]; approximate: { resource: string; entry: string }[]; notMapped: { resource: string; why: string }[] } {
  const deny: string[] = [];
  const approximate: { resource: string; entry: string }[] = [];
  const notMapped: { resource: string; why: string }[] = [];
  const add = (...entries: string[]) => entries.forEach((e) => deny.includes(e) || deny.push(e));
  for (const rule of rules) {
    const [kind, ...rest] = rule.resource.split(":");
    const value = rest.join(":");
    if (kind === "mcp") {
      const [server, tool] = value.split("/").map(mcpToolPart);
      add(tool === undefined ? `mcp__${server}` : `mcp__${server}__${tool}`, `mcp__plugin_*_${server}__${tool ?? "*"}`);
    } else if (kind === "skill") {
      add(`Skill(${value})`);
      if (teamPlugin && !value.includes(":")) add(`Skill(${teamPlugin}:${value})`);
    } else if (kind === "tool") {
      const tool = rest[0]!;
      const pattern = rest.slice(1).join(":");
      if (pattern === "*") {
        add(tool);
      } else if (tool === "Bash") {
        add(`Bash(${pattern})`);
      } else if (tool === "Read" || tool === "Glob" || tool === "Grep" || tool === "Edit") {
        const path = pattern.includes("/") ? `${pattern.startsWith("/") ? "/" : ""}${pattern.replace(/\*/g, "**")}` : pattern;
        const entry = `${tool === "Edit" ? "Edit" : "Read"}(${path})`;
        add(entry);
        approximate.push({ resource: rule.resource, entry });
      } else if (tool === "WebFetch") {
        const host = /^(?:https?|\*):\/\/([A-Za-z0-9.*-]+)(?:\/.*)?$/.exec(pattern)?.[1];
        if (host) add(`WebFetch(domain:${host})`);
        else notMapped.push({ resource: rule.resource, why: "Claude Code holds a fetch to a domain, not to an address pattern" });
      } else {
        notMapped.push({ resource: rule.resource, why: `Claude Code holds ${tool} whole only` });
      }
    }
  }
  return { deny, approximate, notMapped };
}
