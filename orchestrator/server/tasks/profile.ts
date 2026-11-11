import { chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestratorContext } from "../app.js";
import type { PolicyRule } from "../plugin.js";
import { guardHookSource } from "./guard-hook.js";
import type { TaskPaths } from "./isolation.js";
import { runProcess, taskEnv } from "./isolation.js";

export const PERSONAL_NOTE = "Runs as you: your own Claude Code, with your skills, plugins, MCP servers and memory, plus the team's skills.";

/** A run as you under a policy that keeps the person's own setup out, naming the policy. */
export const signInOnlyNote = (policy: string) => `Runs as you with your Claude Code sign-in alone: "${policy}" keeps the rest of your Claude Code setup out of tasks here.`;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Why this orchestrator may not run tasks with its user's own profile, or null. The profile holds
 * one person's sign-ins, and one orchestrator process has one profile whichever of its organizations
 * a task belongs to, so it serves only an orchestrator one person reaches: listening on this machine
 * alone, with one account across every organization it serves, none of them a service account.
 */
export async function personalProfileRefusal(ctx: OrchestratorContext, hostEnv: Record<string, string | undefined>, tenants: readonly string[] = [ctx.tenant], managed: ManagedSettingsPlaces = managedSettingsPlaces(hostEnv)): Promise<string | null> {
  return (await onePersonRefusal(ctx, hostEnv, tenants)) ?? personalHooksRefusal(managed);
}

/**
 * Why this orchestrator is not one person's alone, or null: one that listens on this machine
 * alone, with one account across every organization it serves, none of them a service account.
 * What acts with that one person's own sign-ins, their Claude Code or their forge CLI, is held to it.
 */
export async function onePersonRefusal(ctx: Pick<OrchestratorContext, "store" | "tenant">, hostEnv: Record<string, string | undefined>, tenants: readonly string[] = [ctx.tenant]): Promise<string | null> {
  const host = hostEnv.ORCHESTRATOR_HOST ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) return `Run as me needs an orchestrator only this machine reaches, and this one listens on ${host}`;
  const users = (await Promise.all([...new Set([ctx.tenant, ...tenants])].map((t) => ctx.store.listUsers(t)))).flat();
  if (users.some((u) => u.id.startsWith("service:"))) return "Run as me is for one person's orchestrator, and this one has a service account";
  if (users.length > 1) return `Run as me is for one person's orchestrator, and this one has ${users.length} accounts`;
  return null;
}

/**
 * Where Claude Code reads its managed settings, the tier no other layer overrides, as its own code
 * in 2.1.317 names them: the system file and its drop-in folder, the copy of server-managed
 * settings in the person's config folder, and on macOS the managed preferences.
 */
export interface ManagedSettingsPlaces {
  files: string[];
  dropIns: string[];
  plists: string[];
}

export function managedSettingsPlaces(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): ManagedSettingsPlaces {
  const root = platform === "darwin" ? "/Library/Application Support/ClaudeCode" : platform === "win32" ? "C:\\Program Files\\ClaudeCode" : "/etc/claude-code";
  const config = env.CLAUDE_CONFIG_DIR || join(env.HOME ?? "", ".claude");
  const plists = platform === "darwin" ? [...(env.USER ? [`/Library/Managed Preferences/${env.USER}/${MDM_DOMAIN}.plist`] : []), `/Library/Managed Preferences/${MDM_DOMAIN}.plist`] : [];
  return { files: [join(root, "managed-settings.json"), join(config, "remote-settings.json")], dropIns: [join(root, "managed-settings.d")], plists };
}

const MDM_DOMAIN = "com.anthropic.claudecode";

/**
 * Why a folder the person trusted cannot hold the orchestrator's guard, or null: Claude Code drops
 * every hook of the `--settings` layer when the folder's own project or local settings switch hooks
 * off, as its own code says, so a run that loads them is refused while one of them does.
 */
export async function folderHooksRefusal(folder: string): Promise<string | null> {
  for (const name of ["settings.json", "settings.local.json"]) {
    const text = await readFile(join(folder, ".claude", name), "utf8").catch(() => null);
    if (text === null) continue;
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      continue;
    }
    if (settings && typeof settings === "object" && (settings as Record<string, unknown>).disableAllHooks === true) {
      return `the folder's .claude/${name} switches off every hook (disableAllHooks), which would switch off the orchestrator's guard; remove disableAllHooks from that file`;
    }
  }
  return null;
}

/** What a refusal of a run as you tells its reader to do, said once wherever it is shown. */
export const ISOLATED_ACTION = "run tasks in the isolated profile (ORCHESTRATOR_TASK_PROFILE=isolated)";

/** The managed settings that drop a hook of the `--settings` layer, the orchestrator's guard among them, whatever that layer says. */
function hooksSwitchedOff(settings: Record<string, unknown>): string | null {
  if (settings.disableAllHooks === true) return "switch off every hook (disableAllHooks)";
  if (settings.allowManagedHooksOnly === true) return "allow only their own hooks (allowManagedHooksOnly)";
  const strict = settings.strictPluginOnlyCustomization;
  if (strict === true || (Array.isArray(strict) && strict.includes("hooks"))) return "allow hooks only from plugins (strictPluginOnlyCustomization)";
  return null;
}

/**
 * Why a run as you cannot hold the orchestrator's guard, or null. The person's own user, project
 * and local settings are merged before the guard's layer, so its `disableAllHooks: false` wins over
 * theirs; managed settings are merged after it and can drop its hook. A managed file that cannot
 * be read refuses too: a switch nobody could read would leave the guard off unseen.
 */
export async function personalHooksRefusal(places: ManagedSettingsPlaces): Promise<string | null> {
  const found: { from: string; text: string }[] = [];
  const named = async (file: string) => {
    const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" || err.code === "ENOTDIR" ? null : ""));
    if (text !== null) found.push({ from: file, text });
  };
  for (const file of places.files) await named(file);
  for (const dir of places.dropIns) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) await named(join(dir, name));
  }
  for (const plist of places.plists) {
    if (!(await stat(plist).catch(() => null))) continue;
    const read = await runProcess({ program: "/usr/bin/plutil", args: ["-convert", "json", "-o", "-", "--", plist], env: { PATH: "/usr/bin:/bin" }, cwd: "/" }, { timeoutMs: 10_000, signal: new AbortController().signal, onLine: () => {} });
    found.push({ from: plist, text: read.code === 0 ? read.stdout : "" });
  }
  for (const { from, text } of found) {
    let settings: unknown;
    try {
      settings = JSON.parse(text);
    } catch {
      return `the managed Claude Code settings in ${from} cannot be read, so whether they switch off the orchestrator's guard is not known; ${ISOLATED_ACTION}`;
    }
    const off = settings && typeof settings === "object" && !Array.isArray(settings) ? hooksSwitchedOff(settings as Record<string, unknown>) : null;
    if (off) return `the managed Claude Code settings in ${from} ${off}, which switches off the orchestrator's guard for a task that runs as you; ${ISOLATED_ACTION}`;
  }
  return null;
}

/**
 * The environment a task's agent gets when it runs as the orchestrator's user: that user's own home,
 * so their Claude Code profile, MCP servers and sign-ins, beside the task's own temporary
 * directory. Nothing else of the orchestrator's environment crosses.
 */
export function personalEnv(host: Record<string, string | undefined>, paths: TaskPaths, pass: readonly string[] = []): Record<string, string> {
  const { XDG_CONFIG_HOME: _c, XDG_DATA_HOME: _d, XDG_CACHE_HOME: _k, XDG_STATE_HOME: _s, ...env } = taskEnv(host, paths, [...pass, "USER", "LOGNAME", "SHELL", "CLAUDE_CONFIG_DIR"]);
  return { ...env, HOME: host.HOME ?? paths.home };
}

/**
 * The MCP tools an agent run as the user keeps: those whose name starts with a reading verb.
 * The user's own servers carry their sign-ins, so a tool that merges, comments, edits or sends
 * would put the agent's work in front of people with nobody approving it; a verb not on this
 * list counts as writing.
 */
export const READING_VERBS = ["get", "list", "search", "read", "view", "fetch", "query", "describe", "show", "find", "lookup", "count", "download", "semantic"];
// Case-sensitive on purpose: the verb is lower case or capitalized, and the word ends at a
// separator, a digit or a capital. Read without case, the capital in that boundary matches any
// letter, and lists_delete or views_create would pass as reading.
export const READING_TOOL = new RegExp(`^(?:${[...READING_VERBS, ...READING_VERBS.map((v) => v[0]!.toUpperCase() + v.slice(1))].join("|")})(?=$|[_\\-A-Z0-9])`);

/**
 * A tool of an issue tracker or its wiki, whatever the server is called: Jira, Confluence and the
 * rest of Atlassian's, worklogs and issues. The organization's people review what a task writes
 * as a request; a task changing the tracker would reach them with nobody approving it, so a
 * tracker tool that does not read is refused in every task, the tool's own allow rules aside.
 */
/** The words that name a tracker in an MCP tool's or its server's name. */
export const TRACKER_WORDS = ["jira", "confluence", "atlassian", "tracker", "worklog", "issue"];
export const TRACKER_TOOL = new RegExp(TRACKER_WORDS.join("|"), "i");
/**
 * A product prefix a server puts before its verb (jira_get_issue, github_list_pulls, slack_search_messages), read past
 * to the verb. Named one by one: read past any word, a tool like send_list would pass as reading.
 */
export const PRODUCT_PREFIX = /^(?:jira|confluence|atlassian|github|gitlab|gitea|slack|linear|notion|google|gmail|gdrive|drive|figma|sentry|asana)[_-]/i;

export const PERSONAL_READ_REASON = "A tool that reads runs in a task run as you, as in your own sessions.";

/** The words that name a forge, or its requests and reviews, in an MCP tool's or its server's name. */
export const FORGE_WORDS = ["github", "gitlab", "gitea", "merge_request", "mergerequest", "pull_request", "pullrequest", "review"];

/**
 * A forge's tool, whatever the server is called: GitHub's, GitLab's and Gitea's, requests and
 * reviews. A task's change reaches people only as a request a person reviews, and the team's push
 * check and review hold it there; a forge tool that writes would merge, approve or change it past
 * them, so one that does not read is refused in every task, the person's own allow rules aside.
 */
export const FORGE_TOOL = new RegExp(FORGE_WORDS.join("|"), "i");

export const FORGE_REASON = "A task's agent merges, approves, reviews, comments on or changes nothing on the forge: its change reaches people only as a request a person reviews.";

export const TRACKER_REASON = "This organization keeps tasks from writing to its tracker: a task creates, changes, transitions, comments on, links, logs work on or deletes no issue or page.";

/** The families of MCP tools no task's agent writes through, on any path and under no setting, each with the reason its refusal gives. */
export const REFUSED_FAMILIES: readonly { tool: RegExp; reason: string }[] = [
  { tool: TRACKER_TOOL, reason: TRACKER_REASON },
  { tool: FORGE_TOOL, reason: FORGE_REASON },
];

/** Why an MCP tool of `server` is refused to every task, or null: named for a tracker or a forge and not reading. */
export function refusedTool(server: string, tool: string): string | null {
  if (READING_TOOL.test(tool.replace(PRODUCT_PREFIX, ""))) return null;
  return REFUSED_FAMILIES.find((family) => family.tool.test(`${server}__${tool}`))?.reason ?? null;
}

/** Whether an MCP tool of `server` writes to a tracker. */
export const writesTracker = (server: string, tool: string): boolean => refusedTool(server, tool) === TRACKER_REASON;

/** The same for a call by the name an agent asks with: `mcp__server__tool` (Claude Code) or `server_tool` (OpenCode). */
export function refusedCall(name: string): string | null {
  if (name.startsWith("mcp__")) {
    const [server = "", ...tool] = name.slice(5).split("__");
    return refusedTool(server, tool.join("__"));
  }
  const at = name.indexOf("_");
  return at > 0 ? refusedTool(name.slice(0, at), name.slice(at + 1)) : null;
}

export const PERSONAL_UNREAD_REASON = "Run as me refuses a tool call its guard cannot read.";

/**
 * Writes the guard for a run as the user into the task's own directory, never into the profile:
 * a PreToolUse hook Claude Code is started with (`--settings`), which denies every MCP tool
 * whose name does not start with a reading verb. Returns the settings file to name.
 */
/**
 * The MCP servers a checkout's own `.mcp.json` names. Claude Code starts a project's servers in
 * print mode without asking, so Run as me turns each off by name, a fence that does not rest on
 * how `--setting-sources` scopes the file. A file it cannot read refuses the task: a server
 * nobody could name would start with the person's own sign-ins.
 */
export async function projectMcpServers(work: string): Promise<string[] | { refused: string }> {
  let text: string;
  try {
    text = await readFile(join(work, ".mcp.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return { refused: "the repository's .mcp.json cannot be read, so Run as me cannot keep its MCP servers off" };
  }
  let servers: unknown;
  try {
    servers = (JSON.parse(text) as { mcpServers?: unknown } | null)?.mcpServers;
  } catch {
    return { refused: "the repository's .mcp.json is not JSON, so Run as me cannot keep its MCP servers off" };
  }
  return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers) : [];
}

/**
 * Where Run as me keeps the orchestrator's guard: its hook script and its settings layer, outside the
 * checkout and the task's home. The agent runs as the same account, so the directory is closed
 * to writes on disk and a deny rule anchored at it keeps the agent's file tools away from it.
 */
export const personalGuardDir = (paths: Pick<TaskPaths, "root">) => join(paths.root, "guard");
export const personalSettingsFile = (paths: Pick<TaskPaths, "root">) => join(personalGuardDir(paths), "personal-settings.json");

/**
 * Where Claude Code writes a plan, inside the task's folder (its `plansDirectory`, which must sit
 * under the project): its default is the config directory, which the guard keeps every write from.
 * The runner keeps this folder out of what the task changed.
 */
export const CLAUDE_PLANS_DIR = ".orchestrator-plans";

/** Opens the guard directory again, for it to be written anew or removed with the task. */
export async function releasePersonalGuard(root: string): Promise<void> {
  try {
    await chmod(personalGuardDir({ root }), 0o700);
  } catch {
    // no guard here
  }
}

/**
 * The agent's file tools write in its checkout and nowhere they could lift the guard: not the
 * guard's own directory (anchored at the settings file, `/**`) and not the person's own Claude
 * Code settings, which every later session of theirs would load. Nor do they read the person's
 * sign-ins: the profile is theirs, and its keys, tokens and forge logins are no task's to see.
 */
const GUARD_DENIES = [
  "Edit(/**)",
  "Read(/**)",
  "Edit(~/.claude/**)",
  "Edit(~/.claude.json)",
  // A git directory's config names programs that run as the person on their next commit; the hook
  // holds the same in any case of the name, and this rule holds it when the person's hooks are off.
  "Edit(**/.git/**)",
  ...["~/.ssh/**", "~/.aws/**", "~/.config/gh/**", "~/.config/glab-cli/**", "~/.netrc", "~/.claude/**", "~/.claude.json"].map((path) => `Read(${path})`),
];

export const PERSONAL_EDIT_REASON = "Run as me keeps the agent's edits inside the folder the task works in; a path outside it, or one that climbs out with .., is refused.";

export const PERSONAL_GIT_REASON = "Run as me keeps the agent out of the folder's .git: its config would have the person's next commit run programs the agent chose.";

/** The tools that write a file, each naming it in its input. */
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * The team's rules on editing and reading paths, as Claude Code's own deny rules: restricted mode
 * loads no plugin, so the team's policy hook does not run in a run as you, and a path the team
 * keeps from the agent is refused before it is written, not only taken back after. A pattern deny
 * rules cannot hold is left to the check of the change after the run.
 */
export function teamPathDenies(rules: readonly PolicyRule[]): string[] {
  return rules.flatMap((rule) => {
    const [kind, tool, ...rest] = rule.resource.split(":");
    const pattern = rest.join(":");
    if (rule.effect !== "deny" || kind !== "tool" || (tool !== "Edit" && tool !== "Read") || !pattern || /[()\s]/.test(pattern)) return [];
    // A pattern starting with one / is read from the settings file's own folder; an absolute path takes two.
    return [`${tool}(${pattern.startsWith("/") && !pattern.startsWith("//") ? `/${pattern}` : pattern})`];
  });
}

/**
 * The MCP servers the orchestrator adds to a run as you, beside the person's own: its own server
 * and the repository's approved ones, written into the guard folder, which the agent's Read is
 * denied, so the task's token for the orchestrator is in no environment variable a person's own
 * stdio server would inherit.
 */
export interface GuardOptions {
  servers?: Record<string, unknown>;
}

export const personalMcpFile = (paths: Pick<TaskPaths, "root">) => join(personalGuardDir(paths), "mcp.json");

export async function writePersonalGuard(paths: Pick<TaskPaths, "root" | "work">, projectServers: readonly string[] = [], rules: readonly PolicyRule[] = [], guard: GuardOptions = {}, node: string = process.execPath): Promise<string> {
  const work = await realpath(paths.work);
  const dir = personalGuardDir(paths);
  await releasePersonalGuard(paths.root);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const script = join(dir, "personal-guard.mjs");
  await writeFile(
    script,
    guardHookSource({ work, editTools: EDIT_TOOLS, readingTool: READING_TOOL, refused: { families: REFUSED_FAMILIES, prefix: PRODUCT_PREFIX }, readReason: PERSONAL_READ_REASON, editReason: PERSONAL_EDIT_REASON, gitReason: PERSONAL_GIT_REASON, unreadReason: PERSONAL_UNREAD_REASON }),
    { mode: 0o400 },
  );
  const settings = personalSettingsFile(paths);
  const command = `${JSON.stringify(node)} ${JSON.stringify(script)}`;
  // Layers are merged and lists joined, so a person's own enableAllProjectMcpServers can still win
  // over this false; the names in disabledMcpjsonServers hold over every layer.
  const off = { enableAllProjectMcpServers: false, ...(projectServers.length ? { disabledMcpjsonServers: [...projectServers] } : {}) };
  if (Object.keys(guard.servers ?? {}).length) await writeFile(personalMcpFile(paths), JSON.stringify({ mcpServers: guard.servers }, null, 2) + "\n", { mode: 0o400 });
  // The person's own settings now load beside this layer, and a disableAllHooks of theirs would
  // switch this hook off with every other; layers merge in order and this one comes after theirs.
  await writeFile(settings, JSON.stringify({ disableAllHooks: false, plansDirectory: CLAUDE_PLANS_DIR, permissions: { deny: [...GUARD_DENIES, ...teamPathDenies(rules)] }, hooks: { PreToolUse: [{ matcher: `mcp__.*|${EDIT_TOOLS.join("|")}`, hooks: [{ type: "command", command }] }] }, ...off }, null, 2) + "\n", { mode: 0o400 });
  await chmod(dir, 0o500);
  return settings;
}
