import type { TeamNaming } from "../branches.js";
import { branchExampleProblem, commitPrefixProblem } from "../plugin.js";
import { claudeCodeAdapter, fakeAgentAdapter, opencodeAdapter } from "./agents.js";
import { parseJobs } from "./jobs.js";
import type { RepoJobs } from "./triggers.js";
import type { AgentAdapter, McpTool } from "./agents.js";
import type { IsolationConfig } from "./isolation.js";
import type { RunnerOptions } from "./runner.js";
import { DEFAULT_TEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from "./runner.js";
import { cloudMode, localMode } from "../mode.js";
import { ORCHESTRATOR_TOOLS } from "../mcp/orchestrator-tools.js";
import { ORCHESTRATOR_PATH } from "./orchestrator.js";

type Env = Record<string, string | undefined>;

function flag(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 1 or 0, not ${JSON.stringify(value)}`);
}

const list = (value: string | undefined) => (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);

function minutes(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of minutes`);
  return n * 60_000;
}

const MCP_TOOL = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_.-]{1,128})$/;

/** A repository's `mcpTools` from orchestrator.json: `server/tool` names, each exactly one tool. Anything else stops the orchestrator. */
/** Names that carry a forge's credential, as the forges' own CLIs and CI read them. */
const FORGE_TOKENS = /^(?:GH_|GITHUB_|GITLAB_|GLAB_|CI_JOB_|GITEA_|BITBUCKET_)\w*TOKEN$|^(?:GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/;

/**
 * A repository tasks change that is not a skills repository: no plugin version moves with its
 * requests, no skill template or scaffold applies to it, and its agent is given the skills,
 * MCP servers and policies of the team skills repository named in `skillsFrom`. Its own
 * `.teamhandbook.json`, when it has one, names its branches and commits; `naming` stands in
 * when it has none.
 */
export interface CodeTarget {
  skillsFrom: string | null;
  naming: TeamNaming;
}

export function parseCodeTarget(repo: { id: string; kind?: unknown; skillsFrom?: unknown; naming?: unknown }, configured: readonly { id: string; kind?: unknown }[]): CodeTarget | null {
  const where = `repository ${repo.id}`;
  if (repo.kind === undefined || repo.kind === "skills") {
    if (repo.skillsFrom !== undefined || repo.naming !== undefined) throw new Error(`${where}: skillsFrom and naming are for kind "code"; a skills repository names its own`);
    return null;
  }
  if (repo.kind !== "code") throw new Error(`${where}: kind is "skills" or "code", not ${JSON.stringify(repo.kind)}`);
  let skillsFrom: string | null = null;
  if (repo.skillsFrom !== undefined) {
    const from = configured.find((r) => r.id === repo.skillsFrom);
    if (!from || (from.kind !== undefined && from.kind !== "skills")) throw new Error(`${where}: skillsFrom names ${JSON.stringify(repo.skillsFrom)}, which is not a skills repository in this configuration`);
    skillsFrom = from.id;
  }
  const naming: TeamNaming = {};
  if (repo.naming !== undefined) {
    const raw = repo.naming as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((k) => k !== "commitPrefix" && k !== "branchExample")) throw new Error(`${where}: naming is {"commitPrefix", "branchExample"}`);
    if (raw.commitPrefix !== undefined) {
      const problem = typeof raw.commitPrefix === "string" ? commitPrefixProblem(raw.commitPrefix.trim()) : "not text";
      if (problem) throw new Error(`${where}: naming.commitPrefix is ${problem}`);
      naming.commitPrefix = (raw.commitPrefix as string).trim();
    }
    if (raw.branchExample !== undefined) {
      const problem = typeof raw.branchExample === "string" ? branchExampleProblem(raw.branchExample.trim()) : "not text";
      if (problem) throw new Error(`${where}: naming.branchExample is ${problem}`);
      naming.branchExample = (raw.branchExample as string).trim();
    }
  }
  return { skillsFrom, naming };
}

/**
 * A repository's jobs and the secret its forge's comment deliveries are checked with. The
 * secret is named, never written, in the configuration: `triggerSecretEnv` names the variable
 * that holds it, and a named variable that is not set stops the orchestrator rather than leave the
 * hook open or silently closed.
 */
export function parseRepoJobs(repo: { id: string; jobs?: unknown; triggerSecretEnv?: unknown }, env: Record<string, string | undefined>): RepoJobs {
  const jobs = parseJobs(repo.jobs, repo.id);
  if (repo.triggerSecretEnv === undefined) return { jobs, triggerSecret: null };
  const name = repo.triggerSecretEnv;
  if (typeof name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`repository ${repo.id}: triggerSecretEnv names an environment variable, in capitals, digits and _`);
  const secret = env[name];
  if (!secret || secret.length < 16) throw new Error(`repository ${repo.id}: ${name}, which triggerSecretEnv names, is not set to a secret of at least 16 characters`);
  return { jobs, triggerSecret: secret };
}

export function parseMcpTools(value: unknown, repoId: string): McpTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`mcpTools of ${repoId} must be a list of server/tool names`);
  return value.map((entry) => {
    const match = typeof entry === "string" ? MCP_TOOL.exec(entry) : null;
    if (!match) throw new Error(`mcpTools of ${repoId} names ${JSON.stringify(entry)}, which is not one server/tool name`);
    return { server: match[1]!, tool: match[2]! };
  });
}

/**
 * A repository's `tracker` settings from orchestrator.json. `writeBack` - a comment on the issue
 * linking the request, asked for by the orchestrator after the request opens - is designed and
 * not built, so the only value accepted is false: an operator who turns it on is told so at
 * start instead of believing the orchestrator reports back.
 */
export function parseTracker(value: unknown, repoId: string): { writeBack: false } {
  if (value === undefined) return { writeBack: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tracker of ${repoId} must be an object`);
  const unknown = Object.keys(value).filter((k) => k !== "writeBack");
  if (unknown.length) throw new Error(`tracker of ${repoId} has unknown settings: ${unknown.join(", ")}`);
  const writeBack = (value as { writeBack?: unknown }).writeBack;
  if (writeBack === true) throw new Error(`tracker.writeBack of ${repoId} is not available: the orchestrator writes nothing to an issue yet, so leave it false`);
  if (writeBack !== undefined && writeBack !== false) throw new Error(`tracker.writeBack of ${repoId} must be false`);
  return { writeBack: false };
}

/**
 * How tasks run, from the orchestrator's environment. A value it does not recognise stops the
 * orchestrator at start rather than falling back to something weaker: an operator who asked for
 * container isolation and mistyped it must not get process isolation without knowing.
 */
export function taskOptionsFromEnv(env: Env, dataDir: string, fakeAgentScript: string, testCommand: RunnerOptions["testCommand"]): RunnerOptions {
  const mode = env.ORCHESTRATOR_TASK_ISOLATION ?? "process";
  const network = env.ORCHESTRATOR_TASK_NETWORK ?? "open";
  if (network !== "open" && network !== "none") throw new Error(`ORCHESTRATOR_TASK_NETWORK must be open or none, not ${JSON.stringify(network)}`);
  let isolation: IsolationConfig;
  if (mode === "process") {
    isolation = { mode, network };
  } else if (mode === "container") {
    if (!env.ORCHESTRATOR_TASK_IMAGE) throw new Error("ORCHESTRATOR_TASK_ISOLATION=container needs ORCHESTRATOR_TASK_IMAGE, the image an agent runs in");
    isolation = {
      mode,
      network,
      image: env.ORCHESTRATOR_TASK_IMAGE,
      dataDir,
      ...(env.ORCHESTRATOR_TASK_VOLUME ? { volume: env.ORCHESTRATOR_TASK_VOLUME } : {}),
      ...(env.ORCHESTRATOR_TASK_USER ? { user: env.ORCHESTRATOR_TASK_USER } : {}),
    };
  } else {
    throw new Error(`ORCHESTRATOR_TASK_ISOLATION must be process or container, not ${JSON.stringify(mode)}`);
  }

  const available: Record<string, () => AgentAdapter> = {
    "claude-code": () => claudeCodeAdapter(env.ORCHESTRATOR_CLAUDE_BIN || "claude"),
    opencode: () => opencodeAdapter(env.ORCHESTRATOR_OPENCODE_BIN || "opencode", flag(env.ORCHESTRATOR_OPENCODE_MCP, "ORCHESTRATOR_OPENCODE_MCP")),
    fake: () => fakeAgentAdapter(fakeAgentScript),
  };
  const wanted = env.ORCHESTRATOR_AGENTS !== undefined ? list(env.ORCHESTRATOR_AGENTS) : [...(env.ORCHESTRATOR_DEMO === "1" ? ["fake"] : []), "claude-code", "opencode"];
  const unknown = wanted.filter((id) => !Object.hasOwn(available, id));
  if (unknown.length) throw new Error(`ORCHESTRATOR_AGENTS names unknown agents: ${unknown.join(", ")}`);

  // One person's orchestrator runs tasks with that person's own signed-in agent; a team's server, or
  // one whose tasks run in containers, keeps a profile of the task's own.
  const profile = env.ORCHESTRATOR_TASK_PROFILE ?? (localMode(env) && isolation.mode === "process" ? "personal" : "isolated");
  if (profile !== "isolated" && profile !== "personal") throw new Error(`ORCHESTRATOR_TASK_PROFILE must be isolated or personal, not ${JSON.stringify(profile)}`);
  if (profile === "personal" && isolation.mode !== "process") throw new Error("ORCHESTRATOR_TASK_PROFILE=personal runs the agent with your own Claude Code profile, which no container has; use ORCHESTRATOR_TASK_ISOLATION=process");

  // A forge token in a task would let the agent push past review or merge its own request.
  const passEnv = list(env.ORCHESTRATOR_TASK_ENV_PASS);
  const forge = passEnv.filter((name) => FORGE_TOKENS.test(name));
  if (forge.length) throw new Error(`ORCHESTRATOR_TASK_ENV_PASS names ${forge.join(", ")}, a forge credential; a task's agent never gets one, so it cannot push or merge its own request`);

  // A task's agent reaches the orchestrator at the orchestrator's own address, from this machine; a
  // container or a cloud runner has no way to it yet, so its agents are not offered one.
  const publicUrl = env.ORCHESTRATOR_PUBLIC_URL?.replace(/\/+$/, "");
  const orchestrator = isolation.mode === "process" && !cloudMode(env) && publicUrl ? { url: `${publicUrl}${ORCHESTRATOR_PATH}`, tools: ORCHESTRATOR_TOOLS.map((tool) => tool.name) } : undefined;

  return {
    agents: [...new Set(wanted)].map((id) => available[id]!()),
    isolation,
    testCommand,
    hostEnv: env,
    passEnv,
    profile,
    concurrency: Number(env.ORCHESTRATOR_TASK_CONCURRENCY ?? 1) || 1,
    timeoutMs: minutes(env.ORCHESTRATOR_TASK_TIMEOUT_MINUTES, DEFAULT_TIMEOUT_MS, "ORCHESTRATOR_TASK_TIMEOUT_MINUTES"),
    testTimeoutMs: minutes(env.ORCHESTRATOR_TASK_TEST_TIMEOUT_MINUTES, DEFAULT_TEST_TIMEOUT_MS, "ORCHESTRATOR_TASK_TEST_TIMEOUT_MINUTES"),
    cloud: cloudMode(env),
    serverTasks: env.ORCHESTRATOR_SERVER_TASKS === "1",
    ...(orchestrator ? { orchestrator } : {}),
  };
}
