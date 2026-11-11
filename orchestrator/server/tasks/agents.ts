import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { safeRepoPath } from "../forge/local.js";
import type { TeamSetup } from "../inventory.js";
import type { PermissionMode } from "../../shared/permission-mode.js";
import { ASK_TOOL, ASKING_MODES, CLAUDE_CAPABILITIES, CLAUDE_MODE, CLAUDE_PLAN_ENV, CLAUDE_PLAN_MODE, CLAUDE_TWO_WAY_CAPABILITIES, claudeChoiceArgs, claudeCodeCodec, claudeCodeDecoder } from "./adapters/claude-code.js";
import type { AgentCapabilities, AgentChoices, AgentCodec, AgentDecoder } from "./adapters/contract.js";
import { choicesProblem } from "./adapters/contract.js";
import { MANIFEST } from "./adapters/manifest.js";
import { FAKE_CAPABILITIES, FAKE_TWO_WAY_CAPABILITIES, fakeCodec, fakeDecoder } from "./adapters/fake.js";
import { foldStdout, logLineOf } from "./adapters/fold.js";
import type { AgentReport } from "./adapters/fold.js";
import { parseLine } from "./adapters/frames.js";
import { opencodeCapabilities, opencodeDecoder } from "./adapters/opencode.js";
import type { Invocation, TaskPaths } from "./isolation.js";
import { serverForAgent } from "./mcp-tasks.js";
import { CLAUDE_PLANS_DIR, personalMcpFile, personalSettingsFile } from "./profile.js";

export type { AgentReport, RefusedCall } from "./adapters/fold.js";

/** One tool of one MCP server, written `server/tool` in the orchestrator's settings. */
export interface McpTool {
  server: string;
  tool: string;
}

/** The orchestrator's own MCP server for a task's agent: where the runner says it is, the task's token for it, and its tools by name. */
export interface OrchestratorAccess {
  url: string;
  bearer: string;
  tools: readonly string[];
}

/** What an agent is given of the team's setup: its skills, and only the MCP servers and tools allowed for tasks. */
export interface AgentSetup {
  skills: TeamSetup["skills"];
  /**
   * Folders the agent reads beside its working tree and never writes: the files people attached to
   * the task, copied outside the tree so none of them reaches a commit or a request.
   */
  readDirs?: string[];
  mcpServers: TeamSetup["mcpServers"];
  mcpTools: McpTool[];
  /** File tools the team's policies take away whole. */
  deniedTools?: string[];
  orchestrator?: OrchestratorAccess;
  /**
   * Servers of the checkout's own .mcp.json the person approved for this task on its card, as the
   * checkout defines them when the run starts and only those still matching what was approved
   * (approvedProjectServers). Only a run as you takes them, from a file of the task's beside the
   * user's own servers; every other entry of that file stays off.
   */
  approvedProjectMcp?: TeamSetup["mcpServers"];
  /**
   * For a run as you, decided on the orchestrator: whether the person's own Claude Code setup loads
   * (a team policy can keep it out) and whether the folder's own project and local settings do, as
   * for a folder the person opened themselves, never for one the orchestrator cloned. None given,
   * the run takes the sign-in alone.
   */
  personal?: { ownSetup: boolean; folderSettings: boolean };
}

/** The name the orchestrator's server is placed under; a team server of the same name is left out. */
export const ORCHESTRATOR_SERVER = "th-orchestrator";

/** The variable the task's orchestrator token reaches the agent in. Its config names the variable, never the value, so no file of the task's holds the token. */
export const ORCHESTRATOR_TOKEN_ENV = "TH_ORCHESTRATOR_TOKEN";

const orchestratorEnv = (setup: AgentSetup): Record<string, string> => (setup.orchestrator ? { [ORCHESTRATOR_TOKEN_ENV]: setup.orchestrator.bearer } : {});

/** JSON with its keys in order, so the same definition always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The hash a card's approval is bound to: the server's definition exactly as the card showed it. */
export function projectServerHash(server: unknown): string {
  return createHash("sha256").update(canonical(server)).digest("hex");
}

/**
 * The approved project servers a run takes: each approval (server name and the hash of the
 * definition the person saw) against the checkout's definitions now. A server whose definition
 * changed since, or that is gone, stays off and is named, since what runs would not be what was
 * approved.
 */
export function approvedProjectServers(approvals: Readonly<Record<string, string>>, current: TeamSetup["mcpServers"]): { servers: TeamSetup["mcpServers"]; changed: string[] } {
  const servers: TeamSetup["mcpServers"] = {};
  const changed: string[] = [];
  for (const [name, hash] of Object.entries(approvals)) {
    if (Object.hasOwn(current, name) && projectServerHash(current[name]) === hash) servers[name] = current[name]!;
    else changed.push(name);
  }
  return { servers, changed };
}

/** Where a run as you finds the project servers approved for its task. */
export const approvedProjectMcpFile = (paths: TaskPaths) => join(paths.home, "approved-project-mcp.json");

/**
 * Writes the approved project servers for a run as you, before it starts. A file and not a JSON
 * argument, and readable by its owner only: a process's arguments are visible to every account
 * on the machine, and a repository's server definition can hold a token.
 */
export async function writeApprovedProjectMcp(paths: TaskPaths, setup: AgentSetup): Promise<void> {
  if (!Object.keys(setup.approvedProjectMcp ?? {}).length) return;
  const file = approvedProjectMcpFile(paths);
  await writeFile(file, JSON.stringify({ mcpServers: setup.approvedProjectMcp }, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
}

/**
 * A run as you under a policy that keeps the person's own setup out takes their Claude Code sign-in
 * and nothing else of their profile. Restricted mode is an empty `--setting-sources` and more: none
 * of their user, project or local settings, so none of their hooks, permissions, CLAUDE.md or
 * skills; the `--settings` layer, managed settings and a `--plugin-dir` plugin stay; the
 * code-running tools are gone and the file tools are kept to the working directories.
 * `--strict-mcp-config` connects none of their MCP servers. The keychain sign-in is no settings
 * source and still works. Read from the CLI's own help text and code in 2.1.309, 2.1.316 and
 * 2.1.317, never by running it. It refuses bypassPermissions, so a run as you offers no Full access.
 */
const PERSONAL_SIGN_IN_ONLY = ["--restricted", "--strict-mcp-config"];

/** The flag that adds the repository's approved servers to a run as you, the only MCP servers it has under `--strict-mcp-config`. */
const approvedProjectArgs = (paths: TaskPaths, setup: AgentSetup): string[] => (Object.keys(setup.approvedProjectMcp ?? {}).length ? ["--mcp-config", approvedProjectMcpFile(paths)] : []);

/** Where a run as you finds the team's skills: a plugin of the task's own, loaded for that session alone with `--plugin-dir`, never installed in the person's profile. */
export const teamSkillsDir = (paths: Pick<TaskPaths, "root">) => join(paths.root, "team-skills");

/** Writes the team's skills as the task's own plugin for a run as you; nothing when the team has none. */
export async function writeTeamSkills(paths: Pick<TaskPaths, "root">, setup: AgentSetup): Promise<void> {
  if (!setup.skills.length) return;
  const dir = teamSkillsDir(paths);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, ".claude-plugin"), { recursive: true });
  await writeFile(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: TEAM_SKILLS_PLUGIN, description: "The team's skills for this task." }, null, 2) + "\n");
  await writeSkills(join(dir, "skills"), setup);
}

/** A name of the task's own, so the team's plugin a person installed is not overridden for the session. */
const TEAM_SKILLS_PLUGIN = "teamhandbook-task-skills";

/** The servers a run as you is given beside the person's own: the orchestrator's, with its token, and the approved ones beside it. */
export function personalMcp(setup: AgentSetup): Record<string, unknown> {
  const orchestrator = setup.orchestrator ? { [ORCHESTRATOR_SERVER]: { type: "http", url: setup.orchestrator.url, headers: { Authorization: `Bearer ${setup.orchestrator.bearer}` } } } : {};
  return setup.orchestrator ? { ...setup.approvedProjectMcp, ...orchestrator } : {};
}

const orchestratorTools = (setup: AgentSetup): string[] => (setup.orchestrator?.tools ?? []).map((t) => `mcp__${ORCHESTRATOR_SERVER}__${t}`);

/**
 * The flags of a run as you: the person's own settings, the folder's too when they opened it
 * themselves, or the sign-in alone under a policy that keeps their setup out; the orchestrator's
 * guard layer; the team's skills; and the orchestrator's own server beside the approved ones.
 */
function personalArgs(paths: TaskPaths, setup: AgentSetup): string[] {
  const own = setup.personal?.ownSetup === true;
  const sources = own ? ["--setting-sources", setup.personal!.folderSettings ? "user,project,local" : "user"] : PERSONAL_SIGN_IN_ONLY;
  const mcp = setup.orchestrator ? ["--mcp-config", personalMcpFile(paths)] : approvedProjectArgs(paths, setup);
  return [...sources, "--settings", personalSettingsFile(paths), ...(setup.skills.length ? ["--plugin-dir", teamSkillsDir(paths)] : []), ...mcp, ...readOnlyDirs(setup)];
}

/**
 * The team's setup narrowed to what an operator allowed. A server's tools are not known
 * until the server runs, so only tools named one by one can be allowed, and a server none
 * of whose tools is allowed is not placed at all: an agent connects to every server it is
 * given at start, and a stdio server runs its command even if no tool of it is ever called.
 * An agent the orchestrator cannot hold to named tools gets no MCP server.
 */
export function agentSetup(
  team: TeamSetup,
  allowed: readonly McpTool[],
  placesMcp: boolean,
  mcpProblem: (name: string, server: Record<string, unknown>) => string | null = () => null,
): { setup: AgentSetup; notes: string[] } {
  const notes: string[] = [];
  if (Object.hasOwn(team.mcpServers, ORCHESTRATOR_SERVER)) notes.push(`MCP server ${ORCHESTRATOR_SERVER} left out: the name is the orchestrator's own.`);
  const shared = Object.fromEntries(Object.entries(team.mcpServers).filter(([name]) => name !== ORCHESTRATOR_SERVER));
  // The one rule for whether a server reaches a task (mcp-tasks.ts); the repository page and
  // the readiness check report the same verdicts.
  const verdicts = new Map(Object.entries(shared).map(([name, server]) => [name, serverForAgent(name, server, allowed, { label: "this agent", placesMcp, mcpProblem })] as const));
  for (const [name, verdict] of verdicts) if (!verdict.usable && verdict.why === "agent-problem") notes.push(`MCP server ${name} ${verdict.detail}.`);
  const usable = allowed.filter((t) => verdicts.get(t.server)?.usable === true);
  const kept = new Set(usable.map((t) => t.server));
  const mcpServers = Object.fromEntries(Object.entries(shared).filter(([name]) => kept.has(name)));
  const left = [...verdicts].filter(([, v]) => !v.usable && v.why !== "agent-problem").map(([name]) => name);
  if (left.length) {
    notes.push(
      placesMcp
        ? `MCP servers left out, no tool of theirs is allowed for tasks: ${left.join(", ")}.`
        : `MCP servers left out, this agent cannot be held to named tools: ${left.join(", ")}.`,
    );
  }
  const unknown = placesMcp ? allowed.filter((t) => !Object.hasOwn(shared, t.server)) : [];
  if (unknown.length) notes.push(`Allowed tools whose server the team does not share: ${unknown.map((t) => `${t.server}/${t.tool}`).join(", ")}.`);
  return { setup: { skills: team.skills, mcpServers, mcpTools: usable }, notes };
}

export interface AgentTask {
  title: string;
  prompt: string;
  /** What the task chose of the agent's options (capabilities.options). */
  choices?: AgentChoices;
  /** The orchestrator's own instructions, kept apart from the person's prompt where the agent has a place for them. */
  system?: string;
}

/** The task's prompt for an agent with no separate place for the orchestrator's instructions: they come first. */
export const promptWithSystem = (task: AgentTask): string => (task.system?.trim() ? `${task.system.trim()}\n\n${task.prompt}` : task.prompt);

/** An agent's own session id, as a resume names it: it came from the agent's output, so only a plain id is passed on. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** How a two-way session starts. */
export interface LaunchOptions {
  mode: PermissionMode;
  /** With the orchestrator user's own profile and sign-in. */
  personal?: boolean;
  choices?: AgentChoices;
  /** The orchestrator's own instructions (AgentTask.system). */
  system?: string;
  /** Keep the agent's session so a later run can resume it; off unless asked, since a kept session is a copy of the work. */
  persist?: boolean;
  /** The agent's own session id (a terminal's nativeSessionId) to continue, kept by an earlier run with `persist`. */
  resume?: string;
  /**
   * The id a new kept session takes, chosen by the runner so it is known before the process
   * starts and a crash with no terminal event can still be resumed. Implies `persist`; not with
   * `resume`, which continues a session that already has one.
   */
  sessionId?: string;
  /**
   * The runner carries an answer to the agent's own question back to it (`AgentSession.reply`), so
   * an agent with `questions` asks the person on a card; without it those questions are refused at
   * once, since a card nobody can answer would only hold the agent until its time runs out.
   */
  questions?: boolean;
  /**
   * Needs `plan`: the agent starts by planning, changes nothing, and puts its plan to the person as
   * a `plan` request; once it is approved it goes on in `mode`.
   */
  plan?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a CLI's own status command found a credential, in words that carry no account detail. */
export interface SignIn {
  present: boolean;
  how: string;
}

/**
 * What the readiness check asks of an agent CLI before any task runs it. Nothing here starts a
 * task: the version and the status command are the CLI's own read-only answers.
 */
export interface AgentProbe {
  program: string;
  /** The setting that names the program, for the operator who has to point it elsewhere. */
  setting: string;
  /** The version whose flags and output the adapter was checked against, by reading that CLI rather than running a task with it. */
  checkedVersion: string;
  /** The CLI's read-only status command and how to read its answer; absent when the CLI has none. */
  signIn?: { args: string[]; read(stdout: string): SignIn | null };
  /** The version whose behaviour holding the agent to named MCP tools rests on, when the orchestrator gives it MCP servers. */
  mcpVersion?: string;
  /** The version a two-way session was checked against, for an agent that has one. */
  twoWayVersion?: string;
  /** What gives the agent MCP servers when the orchestrator does not. */
  mcpSetting?: string;
}

/**
 * One agent CLI behind the orchestrator, configured: the program the operator pointed at and what
 * it was turned on for. The runner never names a program: it asks the instance where the
 * team's setup goes, how to start the agent and what it can do, and reads the agent's output
 * through the instance's decoder as one stream of events (adapters/contract.ts). A real CLI
 * exists only behind this interface, at the path the operator configured; tests hand every
 * instance a stand-in program.
 */
export interface AgentInstance {
  readonly id: string;
  readonly label: string;
  readonly capabilities: AgentCapabilities;
  /** Host variables the agent needs to reach its model. They are the only ones that cross besides the basics. */
  readonly credentialEnv: readonly string[];
  /** Hosts the agent reaches its model at, let through a repository's allow list since the agent cannot run without them. */
  readonly modelHosts?: readonly string[];
  /** Why a server the team shares cannot be given to this agent, or null when it can. */
  mcpProblem?(name: string, server: Record<string, unknown>): string | null;
  configure(paths: TaskPaths, setup: AgentSetup): Promise<void>;
  /** `personal` starts the agent with the orchestrator user's own profile: no config of the task's is written or named. */
  invocation(paths: TaskPaths, task: AgentTask, setup: AgentSetup, personal?: boolean): Omit<Invocation, "env" | "cwd"> & { env?: Record<string, string> };
  /** A fresh decoder for one run's output; `work` is the task's folder, which a changed file is named inside. */
  decoder(work?: string): AgentDecoder;
  /** How a two-way session starts, for a runner whose transport keeps stdin open; absent for an agent with only one-shot runs. */
  readonly twoWay?: TwoWayLaunch;
  /** Absent for an agent with no CLI to check, the stand-in. */
  readonly probe?: AgentProbe;
  /**
   * An agent whose run as the person is a session of its own server on this machine, the one
   * place its rules outrank the person's own config: its program and the task's environment for it.
   */
  readonly servedAsYou?: { program: string; env(paths: TaskPaths, setup: AgentSetup): Record<string, string> };
}

/**
 * A two-way session's start. The process gets no prompt on stdin: the runner opens the session
 * and sends the task's prompt as its first message. The mode is the one the session runs in,
 * which is lower than the one asked for when the setup would not be held to it.
 */
export interface TwoWayLaunch {
  readonly capabilities: AgentCapabilities;
  /** `personal` starts the agent with the orchestrator user's own profile and sign-in, as one-shot runs do. */
  launch(paths: TaskPaths, setup: AgentSetup, options: LaunchOptions): { call: Omit<Invocation, "env" | "cwd" | "stdin"> & { env?: Record<string, string> }; codec: AgentCodec; mode: PermissionMode; notes: string[] };
}

/**
 * An instance as the runner reads it until it consumes the event stream: the capability flags
 * it checks today, and the log line and the report folded from the decoder's events.
 */
export interface AgentAdapter extends AgentInstance {
  /** Whether the orchestrator can hold this agent to the allowed MCP tools, one by one. */
  readonly placesMcp: boolean;
  /** Whether the agent can run with the orchestrator user's own profile. */
  readonly runsAsYou?: boolean;
  /**
   * A line of the agent's own output as the log shows it, or null for a line not worth a log
   * entry. Never shortened here: the runner masks credentials and secrets first and only then
   * cuts a long line, since a cut through a token leaves a part neither the credential's value
   * nor a secret pattern recognises.
   */
  logLine(line: string): string | null;
  report(stdout: string, exitCode: number | null): AgentReport;
}

/** A choice the agent does not offer stops the start: the task never runs on a default it did not ask for. */
function checked(options: AgentCapabilities["options"], choices: AgentChoices | undefined): void {
  const problem = choicesProblem(options, choices);
  if (problem) throw new Error(problem);
}

export function adapterFrom(instance: AgentInstance): AgentAdapter {
  const twoWay = instance.twoWay;
  return {
    ...instance,
    invocation(paths, task, setup, personal) {
      checked(instance.capabilities.options, task.choices);
      return instance.invocation(paths, task, setup, personal);
    },
    ...(twoWay
      ? {
          twoWay: {
            capabilities: twoWay.capabilities,
            launch(paths, setup, options) {
              checked(twoWay.capabilities.options, options.choices);
              if (options.resume !== undefined && (!twoWay.capabilities.resume || !SESSION_ID.test(options.resume))) throw new Error("this session cannot be resumed by that id");
              if (options.sessionId !== undefined && (!twoWay.capabilities.resume || !UUID.test(options.sessionId) || options.resume !== undefined)) throw new Error("a new session takes a UUID of its own, and not when it resumes another");
              return twoWay.launch(paths, setup, options);
            },
          },
        }
      : {}),
    placesMcp: instance.capabilities.mcp,
    runsAsYou: instance.capabilities.runsAsYou || instance.servedAsYou !== undefined,
    logLine: (line) => logLineOf(instance.decoder(), line),
    report: (stdout, exitCode) => foldStdout(instance.decoder(), stdout, exitCode),
  };
}

/** File tools, plus the MCP tools allowed by name. The runner runs the team's tests itself, so the agent needs no shell and no web. */
export const CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
export const CLAUDE_DENIED = ["Bash", "WebFetch", "WebSearch"];

/** Files written at once while the team's skills are installed: enough to keep the disk busy, few enough not to exhaust file handles. */
export const SKILL_WRITES_AT_ONCE = 16;

/**
 * The team's skills, written where an agent reads them, in the background and a few files at
 * a time. A team with thousands of skill files would otherwise hold up every request to the
 * orchestrator for as long as the writes take, and opening all of them at once runs out of file
 * handles.
 */
async function writeSkills(dir: string, setup: AgentSetup): Promise<void> {
  const files = setup.skills.flatMap((skill) => skill.files.map((file) => ({ target: safeRepoPath(join(dir, skill.slug), file.path), content: file.content })));
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const { target, content } = files[next++]!;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SKILL_WRITES_AT_ONCE, files.length) }, worker));
}

/**
 * `claude auth status` answers in JSON. Only whether a credential is there and of which kind
 * is kept: the same answer carries the account's email and organisation, which have no place
 * in a readiness report. A key alone reads as `loggedIn: false` with `apiKeySource` set, and
 * the adapter passes a key, so either counts.
 */
export function readClaudeAuthStatus(stdout: string): SignIn | null {
  let status: Record<string, unknown> | null = null;
  for (const line of [stdout.trim(), ...stdout.split("\n").reverse()]) {
    status = parseLine(line.trim());
    if (status) break;
  }
  if (!status || typeof status.loggedIn !== "boolean") return null;
  const word = (v: unknown) => (typeof v === "string" && /^[\w ./-]{1,40}$/.test(v) ? v : null);
  if (status.loggedIn) return { present: true, how: `signed in (${word(status.authMethod) ?? "method not named"})` };
  const key = word(status.apiKeySource);
  return key ? { present: true, how: `API key from ${key}` } : { present: false, how: "not logged in and no API key" };
}

/**
 * `opencode auth list` writes styled text: the stored credentials' count, then, only when a
 * provider's key is set, an Environment heading over those providers.
 */
export function readOpencodeAuthList(stdout: string): SignIn | null {
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  const stored = /(\d+) credentials?\b/.exec(text);
  if (!stored) return null;
  const fromEnv = /^\W*Environment\b/m.test(text);
  if (Number(stored[1]) > 0) return { present: true, how: `${stored[1]} stored credential(s)` };
  return fromEnv ? { present: true, how: "a provider key in the environment" } : { present: false, how: "no stored credential and no provider key in the environment" };
}

/** The file tools a task's Claude Code is allowed and the flag that keeps the rest away. */
const claudeFiles = (setup: AgentSetup): string[] => CLAUDE_TOOLS.filter((t) => !(setup.deniedTools ?? []).includes(t));

/**
 * A run as the person keeps their own rules for the shell and the web, as their sessions do: the orchestrator's
 * fixed refusals of Bash, WebFetch and WebSearch are for a run in the orchestrator's own profile. The guard's deny rules,
 * the team's denied tools and the guard's hook hold either way.
 */
function claudeTools(paths: TaskPaths, setup: AgentSetup, personal = false): { files: string[]; disallowed: string[] } {
  return { files: claudeFiles(setup), disallowed: ["--disallowedTools", [...(personal ? [] : CLAUDE_DENIED), ...(setup.deniedTools ?? []), ...guardRules(paths), ...dataFolderRules(paths)].join(",")] };
}

/** In Auto a run as the person has the shell, which Auto would otherwise refuse unasked; a mode that asks asks about it on the card. */
const personalShell = (setup: AgentSetup): string[] => ((setup.deniedTools ?? []).includes("Bash") ? [] : ["Bash"]);

/**
 * The parts of the orchestrator's data folder beside the task's own folder: its database with every secret it keeps,
 * its backups, its copies of the teams' repositories and the files people attached. A task's agent reads none of them,
 * in any mode and whoever it runs as; its own checkout and the copies of its attachments are in the task's folder.
 */
export const DATA_FOLDER_PARTS = ["orchestrator.db*", "backups/**", "mirrors/**", "attachments/**", "diagnostics/**", "shadow/**", "skill-sources/**", "request-checks/**", "task-starts/**", "task-tools/**", "task-git/**", "work/**", "address"];

/** The data folder holds a task's own as `tasks/<org>/<task>`; a task folder elsewhere, as on a person's machine, has no orchestrator data beside it. */
function dataFolderRules(paths: TaskPaths): string[] {
  const tasks = dirname(dirname(resolve(paths.root)));
  if (basename(tasks) !== "tasks") return [];
  return DATA_FOLDER_PARTS.map((part) => `Read(/${dirname(tasks)}/${part})`);
}

/** The tools that change a file, each refused anywhere in the task's home. */
const CLAUDE_WRITES = ["Edit", "Write", "NotebookEdit"];

/**
 * The task's home holds the orchestrator's own guard (its settings layer, hook script and MCP file),
 * so no edit reaches it in any mode, asked or not. `//` starts an absolute path in Claude Code's
 * permission rules.
 */
function guardRules(paths: TaskPaths): string[] {
  return CLAUDE_WRITES.map((tool) => `${tool}(/${paths.home}/**)`);
}

/**
 * Whether a call's input aims inside the task's home, as written or through a link. The agent
 * names paths from its own resolved working directory, which can differ from the orchestrator's
 * above the task's folder (/var against /private/var); the task's folder and its home name the
 * home whatever comes before them, so the check needs no file system call on the codec's loop.
 */
function aimsAtHome(paths: TaskPaths, input: Record<string, unknown>): boolean {
  const home = resolve(paths.home);
  const tail = sep + join(basename(dirname(home)), basename(home));
  return ["file_path", "notebook_path", "path"].some((k) => {
    const target = input[k];
    if (typeof target !== "string") return false;
    const aimed = resolve(target);
    return aimed === home || aimed.startsWith(home + sep) || aimed.endsWith(tail) || aimed.includes(tail + sep);
  });
}

/** Every tool a task's Claude Code may run: the file tools and the MCP tools allowed by full name, never a whole server. */
function claudeAllowed(setup: AgentSetup): string[] {
  return [...claudeFiles(setup), ...setup.mcpTools.map((t) => `mcp__${t.server}__${t.tool}`), ...(setup.orchestrator?.tools ?? []).map((t) => `mcp__${ORCHESTRATOR_SERVER}__${t}`)];
}

/** Tools that only read run without a question even in a mode that asks before edits and commands. */
const CLAUDE_READ_ONLY = new Set(["Read", "Glob", "Grep"]);

/** The task's own MCP file and the tools that run without asking: all allowed ones, or in a mode that asks, only those that read. */
function claudeTaskArgs(paths: TaskPaths, setup: AgentSetup, asks = false): string[] {
  const tools = claudeAllowed(setup).filter((t) => !asks || CLAUDE_READ_ONLY.has(t));
  return ["--strict-mcp-config", "--mcp-config", join(paths.home, "mcp.json"), "--allowedTools", tools.join(","), ...claudeTools(paths, setup).disallowed, ...readOnlyDirs(setup)];
}

/** Each folder the agent reads beside its tree, added for its Read tool, with every write into it denied: Claude Code lets a tool edit in an added folder unless told not to. */
function readOnlyDirs(setup: AgentSetup): string[] {
  return (setup.readDirs ?? []).flatMap((dir) => ["--add-dir", dir, "--disallowedTools", CLAUDE_WRITES.map((tool) => `${tool}(/${dir}/**)`).join(",")]);
}

/**
 * Claude Code in print mode. Its config directory is the task's own, holding the team's skills;
 * only the servers placed for the task load (`--strict-mcp-config`), each tool of theirs is
 * allowed by its full name and never the whole server, and only user settings are read
 * (`--setting-sources user`), so a `.claude/settings.json` or `.mcp.json` in the repository
 * cannot widen the tools or start a server.
 */
export function claudeCodeAdapter(program: string): AgentAdapter {
  return adapterFrom({
    id: "claude-code",
    label: "Claude Code",
    capabilities: CLAUDE_CAPABILITIES,
    credentialEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    modelHosts: ["api.anthropic.com"],
    probe: {
      program,
      setting: "ORCHESTRATOR_CLAUDE_BIN",
      checkedVersion: MANIFEST["claude-code"].checkedVersion,
      twoWayVersion: MANIFEST["claude-code"].twoWayVersion,
      signIn: { args: ["auth", "status", "--json"], read: readClaudeAuthStatus },
    },
    async configure(paths, setup) {
      const config = join(paths.home, ".claude");
      await mkdir(config, { recursive: true });
      await writeSkills(join(config, "skills"), setup);
      // The task's home holds the agent's own settings and its MCP file: its file tools write in the checkout, never here.
      await writeFile(join(config, "settings.json"), JSON.stringify({ plansDirectory: CLAUDE_PLANS_DIR, permissions: { deny: [...CLAUDE_DENIED, ...(setup.deniedTools ?? []), `Edit(/${paths.home}/**)`] } }, null, 2) + "\n");
      const orchestrator = setup.orchestrator ? { [ORCHESTRATOR_SERVER]: { type: "http", url: setup.orchestrator.url, headers: { Authorization: `Bearer \${${ORCHESTRATOR_TOKEN_ENV}}` } } } : {};
      await writeFile(join(paths.home, "mcp.json"), JSON.stringify({ mcpServers: { ...setup.mcpServers, ...orchestrator } }, null, 2) + "\n");
    },
    invocation(paths, task, setup, personal = false) {
      const { files, disallowed } = claudeTools(paths, setup, personal);
      const print = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];
      const chosen = [...claudeChoiceArgs(task.choices), ...(task.system?.trim() ? ["--append-system-prompt", task.system.trim()] : [])];
      // The mode is named, so a person's own defaultMode, bypassPermissions among them, does not decide it.
      if (personal) return { program, args: [...print, ...personalArgs(paths, setup), "--permission-mode", CLAUDE_MODE.auto, ...chosen, "--allowedTools", [...files, ...personalShell(setup), ...orchestratorTools(setup)].join(","), ...disallowed], stdin: task.prompt, env: { ...CLAUDE_PLAN_ENV } };
      return { program, args: [...print, "--setting-sources", "user", ...chosen, ...claudeTaskArgs(paths, setup)], stdin: task.prompt, env: { CLAUDE_CONFIG_DIR: join(paths.home, ".claude"), ...CLAUDE_PLAN_ENV, ...orchestratorEnv(setup) } };
    },
    twoWay: {
      capabilities: CLAUDE_TWO_WAY_CAPABILITIES,
      launch(paths, setup, { mode: asked, personal = false, choices, system, persist = false, resume, sessionId, questions = false, plan = false }) {
        if (!CLAUDE_TWO_WAY_CAPABILITIES.permissionModes.includes(asked)) throw new Error(`a two-way Claude Code session does not run in ${asked}`);
        const notes: string[] = [];
        let mode = asked;
        // Bypass lets every tool of a placed server run, and the orchestrator allows those tools one by one;
        // with the user's own profile the servers are theirs and none of their tools is named to the orchestrator.
        if (mode === "full-access" && (personal || Object.keys(setup.mcpServers).length)) {
          mode = "auto";
          notes.push(personal ? "Full access runs as Auto when the agent runs as you: it would let every tool of your MCP servers run without a question." : "Full access runs as Auto for this task: it would let every tool of the task's MCP servers run, not only the allowed ones.");
        }
        // Claude Code takes Full access only in a session it opened in it, and a plan opens in its plan mode.
        if (plan && mode === "full-access") {
          mode = "auto";
          notes.push("Full access runs as Auto once the plan is approved: Claude Code takes Full access only in a session that starts in it.");
        }
        // Auto as its person asks too: what its list allows runs unasked, and Claude Code puts any other tool to the card.
        const autoAsks = personal && mode === "auto";
        const asks = autoAsks || ASKING_MODES.includes(mode);
        const working = autoAsks ? CLAUDE_MODE["approval-required"] : CLAUDE_MODE[mode];
        // The tool lists are the task mode's, set once for the session; planning asks over the prompt, where ExitPlanMode is.
        const planned = plan ? { mode: working, dir: join(paths.work, CLAUDE_PLANS_DIR) } : undefined;
        const opened = plan ? CLAUDE_PLAN_MODE : working;
        const head = [
          "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
          ...(persist || resume || sessionId ? [] : ["--no-session-persistence"]), ...(resume ? ["--resume", resume] : []), ...(sessionId ? ["--session-id", sessionId] : []),
          ...(personal ? [] : ["--setting-sources", "user"]), ...claudeChoiceArgs(choices), ...(system?.trim() ? ["--append-system-prompt", system.trim()] : []),
          "--permission-mode", opened, ...(asks || plan ? ["--permission-prompt-tool", "stdio"] : []),
        ];
        if (personal) {
          // The person's MCP tools run as their own rules allow, and in a mode that asks, any other tool, the shell and the
          // web among them, is asked about on the card; the deny rules and the guard's hook refuse what they hold first.
          const { files, disallowed } = claudeTools(paths, setup, true);
          const quiet = autoAsks ? [...files, ...personalShell(setup), ...orchestratorTools(setup)] : [...files, ...(asks ? [] : personalShell(setup)), ...orchestratorTools(setup)].filter((t) => !asks || CLAUDE_READ_ONLY.has(t));
          const args = [...head, ...personalArgs(paths, setup), "--allowedTools", quiet.join(","), ...disallowed];
          return { call: { program, args, env: { ...CLAUDE_PLAN_ENV } }, codec: claudeCodeCodec(mode, (tool, input) => tool !== ASK_TOOL && !aimsAtHome(paths, input), paths.work, questions && CLAUDE_TWO_WAY_CAPABILITIES.questions, opened, planned), mode, notes };
        }
        const allowed = new Set(claudeAllowed(setup));
        return { call: { program, args: [...head, ...claudeTaskArgs(paths, setup, asks)], env: { CLAUDE_CONFIG_DIR: join(paths.home, ".claude"), ...CLAUDE_PLAN_ENV, ...orchestratorEnv(setup) } }, codec: claudeCodeCodec(mode, (tool, input) => allowed.has(tool) && !aimsAtHome(paths, input), paths.work, questions && CLAUDE_TWO_WAY_CAPABILITIES.questions, opened, planned), mode, notes };
      },
    },
    decoder: (work) => claudeCodeDecoder(null, work),
  });
}

/** The name OpenCode registers an MCP tool under: `sanitize(server) + "_" + sanitize(tool)`, its own rule. */
export function opencodeToolName(server: string, tool: string): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${sanitize(server)}_${sanitize(tool)}`;
}

/** OpenCode's own permission names for the file tools a policy can take away whole. */
const OPENCODE_TOOLS: Record<string, string[]> = { Read: ["read", "list"], Edit: ["edit"], Glob: ["glob"], Grep: ["grep"] };

/** `${VAR}` as OpenCode writes a reference to the environment. */
function opencodeValue(value: unknown): unknown {
  return typeof value === "string" ? value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, "{env:$1}") : value;
}

function opencodeValues(values: unknown): Record<string, unknown> | undefined {
  if (!values || typeof values !== "object") return undefined;
  return Object.fromEntries(Object.entries(values as Record<string, unknown>).map(([k, v]) => [k, opencodeValue(v)]));
}

/**
 * A team's server in OpenCode's shape. A remote one has OAuth off: on a 401 OpenCode would
 * start a browser sign-in nobody is there to finish, and a task authenticates with the
 * token its definition references.
 */
export function opencodeServer(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? config.args.map(opencodeValue) : [];
    const environment = opencodeValues(config.env);
    return { type: "local", command: [config.command, ...args], ...(environment ? { environment } : {}), enabled: true };
  }
  const headers = opencodeValues(config.headers);
  return { type: "remote", url: opencodeValue(config.url), ...(headers ? { headers } : {}), oauth: false, enabled: true };
}

/** OpenCode fills these in from the host when it reads its config text, `{file:...}` with a file's content. */
const SUBSTITUTION = /\{(?:env|file):/;

/**
 * OpenCode's `run` in JSON event mode, held to what was read in its own source at version
 * 1.18.31. Its config file is the task's own and the checkout's is ignored
 * (`OPENCODE_DISABLE_PROJECT_CONFIG`): OpenCode merges a project's `opencode.json` and
 * `.opencode/` after its own config, and a project rule placed after this one would win.
 * Permissions deny everything first and then allow the file tools, skills and each allowed
 * MCP tool by its registered name; the last matching rule decides, every MCP call asks for
 * its tool's name, and `run` rejects what would ask. MCP servers are placed only when the
 * operator turned it on for a version that behaves this way (`ORCHESTRATOR_OPENCODE_MCP=1`).
 * Cost is the sum of what its step-finish events report; when none carries a number the
 * cost stays unknown.
 */
export function opencodeAdapter(program: string, mcp = false): AgentAdapter {
  return adapterFrom({
    id: "opencode",
    label: "OpenCode",
    capabilities: opencodeCapabilities(mcp),
    credentialEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"],
    modelHosts: ["api.anthropic.com", "api.openai.com", "openrouter.ai", "generativelanguage.googleapis.com"],
    probe: {
      program,
      setting: "ORCHESTRATOR_OPENCODE_BIN",
      checkedVersion: MANIFEST.opencode.checkedVersion,
      signIn: { args: ["auth", "list"], read: readOpencodeAuthList },
      ...(mcp ? { mcpVersion: MANIFEST.opencode.mcpVersion } : { mcpSetting: "ORCHESTRATOR_OPENCODE_MCP=1" }),
    },
    mcpProblem(name, server) {
      // A server name with "_" makes a tool name readable two ways: a_b + c and a + b_c both register as a_b_c.
      if (name.includes("_")) return "its name has an underscore, which makes OpenCode's tool names ambiguous";
      if (SUBSTITUTION.test(JSON.stringify(server))) return "its definition holds {env:...} or {file:...}, which OpenCode fills in from the host";
      return null;
    },
    async configure(paths, setup) {
      const config = join(paths.home, ".config", "opencode");
      await mkdir(config, { recursive: true });
      await writeSkills(join(config, "skill"), setup);
      const permission = {
        "*": "deny",
        read: "allow",
        edit: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        skill: "allow",
        ...Object.fromEntries(setup.mcpTools.map((t) => [opencodeToolName(t.server, t.tool), "allow"])),
        ...Object.fromEntries((setup.orchestrator?.tools ?? []).map((t) => [opencodeToolName(ORCHESTRATOR_SERVER, t), "allow"])),
        ...Object.fromEntries((setup.deniedTools ?? []).flatMap((t) => OPENCODE_TOOLS[t] ?? []).map((name) => [name, "deny"])),
      };
      const servers: Record<string, unknown> = Object.fromEntries(Object.entries(setup.mcpServers).map(([name, server]) => [name, opencodeServer(server)]));
      // The orchestrator's server is placed even where team servers are not: its token, not a tool list, bounds what a call reaches.
      if (setup.orchestrator) servers[ORCHESTRATOR_SERVER] = { type: "remote", url: setup.orchestrator.url, headers: { Authorization: `Bearer {env:${ORCHESTRATOR_TOKEN_ENV}}` }, oauth: false, enabled: true };
      const file = { $schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", permission, mcp: servers };
      await writeFile(join(config, "opencode.json"), JSON.stringify(file, null, 2) + "\n");
    },
    invocation(paths, task, setup) {
      return {
        program,
        args: ["run", "--format", "json", promptWithSystem(task)],
        env: {
          OPENCODE_CONFIG: join(paths.home, ".config", "opencode", "opencode.json"),
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          ...orchestratorEnv(setup),
        },
      };
    },
    decoder: opencodeDecoder,
    // As the person, a config file of the task's merges under OpenCode's own rules and the person's
    // allows outrank its denies, so the run is a session of `opencode serve` with its rules given there.
    // The task's config directory adds the team's skills and servers over the person's own; under a
    // policy that keeps the person's setup out, it is the only config there is (their sign-in is in
    // OpenCode's data directory, which stays theirs).
    servedAsYou: {
      program,
      env: (paths, setup) => {
        const config = join(paths.home, ".config");
        return { OPENCODE_CONFIG_DIR: join(config, "opencode"), ...(setup.personal?.ownSetup === true ? {} : { XDG_CONFIG_HOME: config }) };
      },
    },
  });
}

/**
 * A stand-in agent for the demo and the tests: a script that makes one deterministic change
 * (a skill named after the task) and reports no cost. Offered only when the operator lists
 * it or the orchestrator runs as the demo.
 */
export function fakeAgentAdapter(script: string, node: string = process.execPath): AgentAdapter {
  return adapterFrom({
    id: "fake",
    label: "Demo agent",
    capabilities: FAKE_CAPABILITIES,
    credentialEnv: [],
    configure(paths, setup) {
      return writeSkills(join(paths.home, "skills"), setup);
    },
    invocation(_paths, task, setup) {
      return { program: node, args: [script, "--title", task.title], stdin: promptWithSystem(task), env: orchestratorEnv(setup) };
    },
    decoder: fakeDecoder,
    twoWay: {
      capabilities: FAKE_TWO_WAY_CAPABILITIES,
      launch(paths, setup, { mode, personal = false }) {
        if (!FAKE_TWO_WAY_CAPABILITIES.permissionModes.includes(mode)) throw new Error(`the stand-in does not run in ${mode}`);
        const asks = ASKING_MODES.includes(mode) || (personal && mode === "auto");
        return { call: { program: node, args: [script, "--two-way", ...(asks ? ["--asks"] : [])], env: orchestratorEnv(setup) }, codec: fakeCodec(paths.work), mode, notes: [] };
      },
    },
  });
}
