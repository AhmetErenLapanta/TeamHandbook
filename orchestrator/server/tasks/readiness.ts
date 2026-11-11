import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { readTeamSetupAsync } from "../inventory.js";
import type { AgentAdapter, AgentProbe } from "./agents.js";
import { serverForAgent } from "./mcp-tasks.js";
import { containerInvocation, dockerEnv, makeTaskDirs, runProcess, taskEnv, taskPaths } from "./isolation.js";
import type { RunOutcome } from "./isolation.js";
import { Redactor } from "./redact.js";
import type { RunnerOptions } from "./runner.js";
import { ISOLATED_ACTION, PERSONAL_NOTE, personalEnv, personalProfileRefusal } from "./profile.js";

export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface ReadinessCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** For a warning or a failure: what it is in a few fixed words, with nothing the check found, so the task form can say it to anyone who starts tasks. */
  short?: string;
}

export interface AgentReadiness {
  id: string;
  label: string;
  /** No check failed. A warning or an unknown still lets a task start; readiness never blocks one. */
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface Readiness {
  checkedAt: string;
  agents: AgentReadiness[];
}

export const PROBE_TIMEOUT_MS = 20_000;

const probeName = (id: string, tenant: string) => `teamhandbook-${id}-${tenant}`;

/**
 * Removes the probe containers an orchestrator that stopped in the middle of a check left on the
 * daemon: a probe's own limit ends it only while the orchestrator that started it runs. Only this
 * tenant's are touched, by their exact name, before any check of this orchestrator starts one.
 */
export async function removeLeftoverProbes(ctx: OrchestratorContext, options: RunnerOptions): Promise<string[]> {
  const env = { PATH: options.hostEnv.PATH ?? "/usr/bin:/bin", ...dockerEnv(options.hostEnv) };
  const names: string[] = [];
  const listed = await runProcess(
    { program: "docker", args: ["ps", "-a", "--filter", "name=teamhandbook-probe-", "--format", "{{.Names}}"], env, cwd: ctx.dataDir },
    { timeoutMs: 30_000, signal: new AbortController().signal, onLine: (stream, line) => void (stream === "stdout" && names.push(line.trim())) },
  );
  if (listed.code !== 0) return [];
  const ours = new RegExp(`^${probeName("probe-[0-9a-f]{8}", ctx.tenant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}$`);
  const leftover = names.filter((name) => ours.test(name));
  for (const name of leftover) {
    await runProcess({ program: "docker", args: ["rm", "-f", name], env, cwd: ctx.dataDir }, { timeoutMs: 30_000, signal: new AbortController().signal, onLine: () => {} });
  }
  return leftover;
}

const EMPTY_SETUP = { skills: [], mcpServers: {}, mcpTools: [] };

export function version(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export const compare = (a: readonly number[], b: readonly number[]) => a.map((n, i) => n - b[i]!).find((d) => d !== 0) ?? 0;

/** The program as a task would start it under process isolation: a path, or the first match on the orchestrator's PATH. */
async function onPath(program: string, path: string | undefined): Promise<string | null> {
  const candidates = program.includes("/") ? [program] : (path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, program));
  for (const candidate of candidates) {
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

/**
 * Asks an agent CLI something read-only - its version, its sign-in - the way a task would
 * start it: the task's stripped environment with the adapter's credentials, a HOME of its own
 * that the adapter has configured as for a task, and under container isolation the task's
 * image and network. The scratch directories are deleted afterwards.
 */
async function ask(ctx: OrchestratorContext, options: RunnerOptions, agent: AgentAdapter, probe: AgentProbe, args: string[]): Promise<RunOutcome & { said: string[] }> {
  const id = `probe-${randomBytes(4).toString("hex")}`;
  const paths = taskPaths(ctx.dataDir, ctx.tenant, id);
  const said: string[] = [];
  try {
    await makeTaskDirs(paths);
    const personal = options.profile === "personal" && agent.runsAsYou === true;
    if (!personal) await agent.configure(paths, EMPTY_SETUP);
    const own = agent.invocation(paths, { title: "", prompt: "" }, EMPTY_SETUP, personal).env ?? {};
    const pass = [...agent.credentialEnv, ...(options.passEnv ?? [])];
    // Asked as a task runs it: under Run as me, with the user's own profile and its sign-in.
    const inv = { program: probe.program, args, env: { ...(personal ? personalEnv(options.hostEnv, paths, pass) : taskEnv(options.hostEnv, paths, pass)), ...own }, cwd: paths.work };
    const name = probeName(id, ctx.tenant);
    const wrapped = options.isolation.mode === "container" ? containerInvocation(inv, paths, options.isolation, name, options.hostEnv) : inv;
    const outcome = await runProcess(wrapped, {
      timeoutMs: options.readinessTimeoutMs ?? PROBE_TIMEOUT_MS,
      signal: new AbortController().signal,
      onLine: (_stream, line) => void (line.trim() && said.push(line)),
    });
    // Ending the docker client does not end its container, which holds the task's credentials:
    // it is removed before the check answers, so no answer leaves one running.
    if (outcome.timedOut && options.isolation.mode === "container") {
      await runProcess({ program: "docker", args: ["rm", "-f", name], env: wrapped.env, cwd: paths.root }, { timeoutMs: 30_000, signal: new AbortController().signal, onLine: () => {} });
    }
    return { ...outcome, said };
  } finally {
    await Promise.all([rm(paths.root, { recursive: true, force: true }), rm(paths.git, { recursive: true, force: true })]);
  }
}

/** One line of what a CLI said, for a failure's detail: clipped, and with every credential a task gets taken out. */
function firstWords(said: string[], options: RunnerOptions, agent: AgentAdapter): string {
  const values = [...agent.credentialEnv, ...(options.passEnv ?? [])].map((name) => options.hostEnv[name]).filter((v): v is string => !!v);
  const line = new Redactor(values).line(said.find((l) => l.trim()) ?? "").trim();
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

async function programChecks(ctx: OrchestratorContext, options: RunnerOptions, agent: AgentAdapter, probe: AgentProbe): Promise<{ checks: ReadinessCheck[]; found: string | null }> {
  if (options.isolation.mode === "container") {
    // Inspected, never run: `docker run` pulls an image it does not have, and a readiness check
    // must not fetch anything.
    const image = options.isolation.image;
    const inspected = await runProcess(
      { program: "docker", args: ["image", "inspect", "--format", "{{.Id}}", image], env: { PATH: options.hostEnv.PATH ?? "/usr/bin:/bin", ...dockerEnv(options.hostEnv) }, cwd: ctx.dataDir },
      { timeoutMs: options.readinessTimeoutMs ?? PROBE_TIMEOUT_MS, signal: new AbortController().signal, onLine: () => {} },
    );
    if (inspected.code !== 0) return { checks: [{ name: "Image", status: "fail", short: "image not on the Docker daemon", detail: `${image} is not on the Docker daemon; build or pull it (the check never pulls)` }], found: null };
    return { checks: [{ name: "Image", status: "ok", detail: `${image} is on the Docker daemon` }], found: `${probe.program} in ${image}` };
  }
  const found = await onPath(probe.program, options.hostEnv.PATH);
  return found
    ? { checks: [{ name: "Program", status: "ok", detail: found }], found }
    : {
        checks: [{
          name: "Program",
          status: "fail",
          short: "program not found",
          detail: probe.program.includes("/")
            ? `${probe.program}, named by ${probe.setting}, is not an executable file`
            : `${probe.program} is not on the orchestrator's PATH; install it, or name it with ${probe.setting}`,
        }],
        found: null,
      };
}

function versionCheck(probe: AgentProbe, outcome: RunOutcome & { said: string[] }, where: string, words: string): { check: ReadinessCheck; seen: [number, number, number] | null } {
  const seen = outcome.code === 0 ? version(outcome.said.join("\n")) : null;
  const checked = version(probe.checkedVersion)!;
  if (!seen) {
    // In a container the program is found only by starting it.
    const missing = outcome.code === 127 || /executable file not found|no such file/i.test(outcome.said.join("\n"));
    if (missing) return { check: { name: "Version", status: "fail", short: "program did not start", detail: `${where}: the program did not start (${words})` }, seen };
    return { check: { name: "Version", status: "unknown", detail: `${probe.program} --version printed no version${words ? ` (${words})` : ""}` }, seen };
  }
  const text = seen.join(".");
  const difference = compare(seen, checked);
  if (difference === 0) return { check: { name: "Version", status: "ok", detail: `${text}, the version the orchestrator was checked with` }, seen };
  // Claude Code ships a patch nearly every day and keeps its flags and output within a minor; a warning on each would
  // be the screen's usual state, so a newer patch of the checked minor is fine and only a newer minor or major warns.
  if (difference > 0 && seen[0] === checked[0] && seen[1] === checked[1]) return { check: { name: "Version", status: "ok", detail: `${text}, a newer patch of ${probe.checkedVersion}, the version the orchestrator was checked with` }, seen };
  // Either way the fix is the same version; a newer one often works, so it says when to go back.
  const detail = difference < 0
    ? `${text} is older than ${probe.checkedVersion}, the version the orchestrator was checked with. Update the CLI to ${probe.checkedVersion}.`
    : `${text} is newer than ${probe.checkedVersion}, the version the orchestrator was checked with. If a task fails on a changed flag or output, install ${probe.checkedVersion}.`;
  return { check: { name: "Version", status: "warn", short: difference < 0 ? "version older than checked" : "version newer than checked", detail }, seen };
}

function credentialCheck(options: RunnerOptions, agent: AgentAdapter): ReadinessCheck {
  const set = agent.credentialEnv.filter((name) => options.hostEnv[name]);
  if (set.length) return { name: "Credential", status: "ok", detail: `set on the orchestrator: ${set.join(", ")}` };
  const passed = (options.passEnv ?? []).filter((name) => options.hostEnv[name]);
  if (passed.length) return { name: "Credential", status: "warn", short: "model key only passed through", detail: `none of ${agent.credentialEnv.join(", ")} is set; a task gets ${passed.join(", ")} through ORCHESTRATOR_TASK_ENV_PASS, which serves only if the agent reads its model key from one of them` };
  return { name: "Credential", status: "fail", short: "no model credential", detail: `none of ${agent.credentialEnv.join(", ")} is set on the orchestrator, and a task gets no other credential` };
}

/**
 * A subscription token signs one person's own Claude Code in; an orchestrator several people use
 * runs every teammate's tasks on it. Said only when the token is what tasks would use and
 * more than one account signs in to this orchestrator.
 */
async function subscriptionCheck(ctx: OrchestratorContext, options: RunnerOptions, agent: AgentAdapter): Promise<ReadinessCheck | null> {
  if (agent.id !== "claude-code" || !options.hostEnv.CLAUDE_CODE_OAUTH_TOKEN || options.hostEnv.ANTHROPIC_API_KEY) return null;
  if ((await ctx.store.listUsers(ctx.tenant)).length < 2) return null;
  return {
    name: "Credential kind",
    status: "warn",
    short: "personal subscription token on a shared orchestrator",
    detail: "A personal subscription token is meant for one person's own use; a shared orchestrator should use an API key or a Team or Enterprise plan. See Anthropic's terms.",
  };
}

async function mcpChecks(ctx: OrchestratorContext, options: RunnerOptions, agent: AgentAdapter, probe: AgentProbe, seen: [number, number, number] | null): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    const allowed = options.mcpTools?.(repo) ?? [];
    if (!allowed.length || !repo.head) continue;
    const named = allowed.map((t) => `${t.server}/${t.tool}`).join(", ");
    if (!agent.placesMcp) {
      checks.push({ name: `MCP tools, ${repo.id}`, status: "warn", short: "allowed MCP tools not placed", detail: `the repository allows ${named}, and ${agent.label} gets no MCP server${probe.mcpSetting ? ` without ${probe.mcpSetting}` : ""}` });
      continue;
    }
    let team;
    try {
      team = await readTeamSetupAsync(mirrorDir(ctx, repo.id), repo.head);
    } catch (err) {
      checks.push({ name: `MCP tools, ${repo.id}`, status: "unknown", detail: `the team's .mcp.json was not read: ${(err as Error).message.split("\n")[0]}` });
      continue;
    }
    const problems: string[] = [];
    for (const server of new Set(allowed.map((t) => t.server))) {
      const refused = team.refused.find((r) => r.name === server);
      const definition = team.mcpServers[server];
      if (refused) problems.push(`${server} is in the team's .mcp.json but held back by the share rule (${refused.reason})`);
      else if (!definition) problems.push(`${server} is not in the team's .mcp.json, so its tools are never given`);
      else {
        const verdict = serverForAgent(server, definition, allowed, agent);
        if (!verdict.usable) problems.push(`${server} is ${verdict.detail}`);
      }
    }
    if (probe.mcpVersion && seen && seen.slice(0, 2).join(".") !== version(probe.mcpVersion)!.slice(0, 2).join(".")) {
      problems.push(`holding ${agent.label} to named MCP tools rests on how ${probe.mcpVersion} behaves, and this is ${seen.join(".")}`);
    }
    checks.push(problems.length
      ? { name: `MCP tools, ${repo.id}`, status: "warn", short: "allowed MCP tools not placed", detail: problems.join("; ") }
      : { name: `MCP tools, ${repo.id}`, status: "ok", detail: `${named} from the team's .mcp.json` });
  }
  return checks;
}

async function checkAgent(ctx: OrchestratorContext, options: RunnerOptions, agent: AgentAdapter): Promise<AgentReadiness> {
  const probe = agent.probe;
  if (!probe) return { id: agent.id, label: agent.label, ready: true, checks: [{ name: "Program", status: "ok", detail: "the stand-in needs no CLI and no credential" }] };
  const { checks, found } = await programChecks(ctx, options, agent, probe);
  let seen: [number, number, number] | null = null;
  if (found) {
    const asked = await ask(ctx, options, agent, probe, ["--version"]);
    const result = versionCheck(probe, asked, found, firstWords(asked.said, options, agent));
    checks.push(result.check);
    seen = result.seen;
  }
  if (options.profile === "personal") {
    const refused = agent.runsAsYou ? await personalProfileRefusal(ctx, options.hostEnv, options.orgs) : `Run as me starts ${agent.label} with no profile of yours to use`;
    checks.push(refused ? { name: "Profile", status: "fail", short: "Run as me refused here", detail: refused.endsWith(ISOLATED_ACTION) ? refused : `${refused}; tasks do not run until ORCHESTRATOR_TASK_PROFILE is isolated` } : { name: "Profile", status: "ok", detail: PERSONAL_NOTE });
  }
  checks.push(options.profile === "personal" && agent.runsAsYou ? { name: "Credential", status: "ok", detail: "your own Claude Code profile's sign-in" } : credentialCheck(options, agent));
  const kind = options.profile === "personal" ? null : await subscriptionCheck(ctx, options, agent);
  if (kind) checks.push(kind);
  const started = found !== null && checks.every((c) => c.status !== "fail" || c.name === "Credential");
  if (!probe.signIn) {
    checks.push({ name: "Sign-in", status: "unknown", detail: `${agent.label} has no read-only status command; the first task shows whether the model takes the credential` });
  } else if (!started) {
    checks.push({ name: "Sign-in", status: "unknown", detail: "not asked: the program did not start" });
  } else {
    const command = `${probe.program} ${probe.signIn.args.join(" ")}`;
    const asked = await ask(ctx, options, agent, probe, probe.signIn.args);
    const answer = asked.timedOut ? null : probe.signIn.read(asked.said.join("\n"));
    if (!answer) {
      // Never quoted: an answer the orchestrator cannot read is exactly one whose account details it cannot pick out.
      const why = asked.timedOut ? `gave no answer within ${Math.round((options.readinessTimeoutMs ?? PROBE_TIMEOUT_MS) / 1000)} s` : `gave an answer the orchestrator does not read (exit code ${asked.code ?? "none"})`;
      checks.push({ name: "Sign-in", status: "unknown", detail: `${command} ${why}` });
    } else if (answer.present) {
      checks.push({ name: "Sign-in", status: "ok", detail: `${command}, with what a task gets: ${answer.how}. A credential is there; whether the model takes it shows at the first task` });
    } else {
      checks.push({ name: "Sign-in", status: "fail", short: "not signed in", detail: `${command}, with what a task gets: ${answer.how}` });
    }
  }
  checks.push(...(await mcpChecks(ctx, options, agent, probe, seen)));
  return { id: agent.id, label: agent.label, ready: !checks.some((c) => c.status === "fail"), checks };
}

/**
 * What can go wrong before an agent's first real task, found without starting one: whether
 * its CLI is there (or its image, under container isolation), which version it is against the
 * one the adapter was checked with, whether a credential reaches it, what its own status
 * command says with only what a task gets, and whether the MCP tools each repository allows
 * exist in the team's `.mcp.json`. Every probe is read-only and runs only when asked.
 */
export async function checkReadiness(ctx: OrchestratorContext, options: RunnerOptions, checkedAt = new Date().toISOString()): Promise<Readiness> {
  const agents = await Promise.all(
    options.agents.map((agent) =>
      checkAgent(ctx, options, agent).catch((err: Error) => ({
        id: agent.id,
        label: agent.label,
        ready: false,
        checks: [{ name: "Check", status: "unknown" as const, detail: `the check itself failed: ${err.message.split("\n")[0]}` }],
      })),
    ),
  );
  return { checkedAt, agents };
}
