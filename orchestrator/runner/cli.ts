import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { localDataDir } from "../server/local.js";
import { RUNNER_SERVICE, serviceCommand, serviceInstalled } from "../server/service.js";
import type { ServiceHost } from "../server/service.js";
import { Redactor } from "../server/tasks/redact.js";
import { machineAdapters } from "./machine-agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import { agentStatus } from "./agent-status.js";
import { machineExecutor, machinePush } from "./machine-executor.js";
import { DEFAULT_SLOTS, MAX_SLOTS, machineLoad, slotsFor } from "./slots.js";
import type { MachineLoad } from "./slots.js";
import { startMachineRunner } from "./machine.js";
import type { MachineRunner } from "./machine.js";
import { ConnectRefused, connect } from "./connect.js";
import { ORG_NAME, connectedOrgs, orgDir, readProfile, removeProfile, signedCall } from "./profile.js";
import { RUNNER_PATHS } from "../shared/runner-wire.js";
import type { Fetch } from "./profile.js";
import { RUNNER_CONNECT } from "../shared/runner-command.js";

export const RUNNER_USAGE = `usage: ${RUNNER_CONNECT} <address> <code> [--name <name>]
       handbook-orchestrator runner start [<org>] [--tasks <1-3>]
       handbook-orchestrator runner status
       handbook-orchestrator runner disconnect <org>
       handbook-orchestrator runner service install | status | restart | uninstall

connect pairs this machine with a team's orchestrator and goes on to run the tasks you start
there on this machine, with the Claude Code you are signed in to, until you stop it with Ctrl-C.
The address and code come from Settings > Your machines > Connect a machine; the code works once,
for five minutes. start runs them again later on a machine already connected; service install
has it run them whenever you are logged in, and the last disconnect removes that service.
`;

export interface RunnerCliIo {
  dataDir: string;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: Fetch;
  name?: string;
  platform?: string;
  /** Ends `start`; the command line wires Ctrl-C and the service's stop to it. */
  signal?: AbortSignal;
  adapters?: readonly AgentAdapter[];
  hostEnv?: Record<string, string | undefined>;
  /** The machine's load and battery now; tests hand in their own. */
  load?: () => MachineLoad;
  /** The login's service manager, for `runner service`; only the installed executable has one, and tests leave it out. */
  service?: ServiceHost;
  /** More git settings and environment for the executor; tests only. */
  gitConfig?: readonly string[];
  gitEnv?: Record<string, string>;
}

/**
 * One `runner start` per organization at a time: a second would end the first one's agents as
 * leftovers of a crash. A lock left by a process that is gone is taken over.
 */
function holdOrg(dataDir: string, org: string): (() => void) | string {
  const file = join(orgDir(dataDir, org), "runner.lock");
  const holder = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  if (holder && holder !== process.pid) {
    try {
      process.kill(holder, 0);
      return `this machine already runs tasks for ${org} (process ${holder}); stop that one first`;
    } catch {
      rmSync(file, { force: true });
    }
  }
  const fd = openSync(file, "w", 0o600);
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

/**
 * How `runner start` ends when it cannot run, so a service manager can tell the two apart:
 * nothing to run for (pair the machine first; restarting will not help) or another start already
 * running for an organization (it may be gone later). The BSD sysexits numbers.
 */
export const NOT_CONNECTED_EXIT = 78;
export const ALREADY_RUNNING_EXIT = 75;

/** Runs the tasks of these organizations on this machine until the signal ends it; one run per organization at a time. */
async function runOrgs(orgs: readonly string[], io: RunnerCliIo, tasks = DEFAULT_SLOTS): Promise<number> {
  const held: (() => void)[] = [];
  for (const org of orgs) {
    const release = holdOrg(io.dataDir, org);
    if (typeof release === "string") {
      held.forEach((r) => r());
      io.err(`handbook-orchestrator: ${release}\n`);
      return ALREADY_RUNNING_EXIT;
    }
    held.push(release);
  }
  const hostEnv = io.hostEnv ?? process.env;
  const adapters = io.adapters ?? machineAdapters(hostEnv);
  // One record for every organization this start runs: a folder is the person's whatever team's task works in it.
  const working = new Set<string>();
  // The machine's slots are shared: a task one organization runs is one fewer another takes.
  const runners: MachineRunner[] = [];
  const free = (self: () => MachineRunner | undefined) => slotsFor(tasks, io.load?.() ?? machineLoad()) - runners.filter((r) => r !== self()).reduce((sum, r) => sum + r.busy(), 0);
  const refused: string[] = [];
  const git = { ...(io.gitConfig ? { gitConfig: io.gitConfig } : {}), ...(io.gitEnv ? { gitEnv: io.gitEnv } : {}) };
  for (const org of orgs) {
    let runner: MachineRunner | undefined;
    runner = startMachineRunner({ dataDir: io.dataDir, home: hostEnv.HOME || homedir(), env: hostEnv, working, slots: () => free(() => runner), onRefused: (error) => {
      refused.push(org);
      io.err(`handbook-orchestrator: ${org}: ${error.message}\n`);
    }, org, executor: machineExecutor({ dataDir: io.dataDir, org, machineId: readProfile(io.dataDir, org)!.machineId, working, adapters, hostEnv, ...git }), pushBranch: machinePush({ dataDir: io.dataDir, org, hostEnv, ...git }), mask: (t) => new Redactor().line(t), agents: () => agentStatus(adapters), ...(io.fetch ? { fetch: io.fetch } : {}) });
    runners.push(runner);
  }
  io.out(`Running the tasks you start in ${orgs.join(", ")} on this machine; Ctrl-C stops.\n`);
  // It runs until it is stopped, or until every orchestrator it runs for has refused it: asking again would change nothing.
  await Promise.race([new Promise<void>((resolve) => (io.signal?.aborted ? resolve() : io.signal?.addEventListener("abort", () => resolve(), { once: true }))), Promise.all(runners.map((r) => r.stopped))]);
  await Promise.all(runners.map((r) => r.stop()));
  held.forEach((r) => r());
  if (refused.length === orgs.length) return NOT_CONNECTED_EXIT;
  io.out("Stopped; a task that was running is held for Continue.\n");
  return 0;
}

/** `handbook-orchestrator runner ...`; returns the exit code. */
/**
 * `handbook-orchestrator runner ...` as both entries run it, the installed executable and the
 * package: the process's environment, with what --env-file and --data-dir set in it already, the
 * default data folder, and Ctrl-C or a service's stop ending `start`.
 */
export async function runnerMain(args: readonly string[], env: NodeJS.ProcessEnv = process.env, service?: ServiceHost): Promise<number> {
  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
  return runnerCommand(args, { dataDir: env.ORCHESTRATOR_DATA_DIR ?? localDataDir(), out: (t) => void process.stdout.write(t), err: (t) => void process.stderr.write(t), signal: stop.signal, hostEnv: env, ...(service ? { service } : {}) });
}

export async function runnerCommand(args: readonly string[], io: RunnerCliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === "connect") {
    const nameAt = rest.indexOf("--name");
    const name = nameAt >= 0 ? rest[nameAt + 1] : (io.name ?? hostname());
    const positional = rest.filter((_, i) => nameAt < 0 || (i !== nameAt && i !== nameAt + 1));
    if (positional.length !== 2 || !name) {
      io.err(RUNNER_USAGE);
      return 2;
    }
    const [address, code] = positional as [string, string];
    try {
      const profile = await connect({ address, code, dataDir: io.dataDir, name: name.slice(0, 80), platform: io.platform ?? `${process.platform}-${process.arch}`, ...(io.fetch ? { fetch: io.fetch } : {}) });
      io.out(`This machine is connected to ${profile.org} as ${name}.\nTo run your tasks whenever you are logged in, without this terminal: ${RUNNER_SERVICE.command} install\n`);
      // Paired, it goes straight on to run the person's tasks: one command from Settings to a working machine.
      return runOrgs([profile.org], io);
    } catch (error) {
      io.err(`handbook-orchestrator: ${error instanceof ConnectRefused ? error.message : "the connection did not go through; check the address and try again"}\n`);
      return 1;
    }
  }
  const tasksAt = rest.indexOf("--tasks");
  const tasks = tasksAt >= 0 ? Number(rest[tasksAt + 1]) : DEFAULT_SLOTS;
  if (tasksAt >= 0 && !(Number.isInteger(tasks) && tasks >= 1 && tasks <= MAX_SLOTS)) {
    io.err(`handbook-orchestrator: --tasks takes how many of your tasks this machine runs at once, 1 to ${MAX_SLOTS}\n`);
    return 2;
  }
  const words = tasksAt >= 0 ? rest.filter((_, i) => i !== tasksAt && i !== tasksAt + 1) : rest;
  if (command === "start" && words.length <= 1) {
    const orgs = words.length ? [words[0]!] : connectedOrgs(io.dataDir);
    if (!orgs.length || orgs.some((o) => !ORG_NAME.test(o) || !readProfile(io.dataDir, o))) {
      io.err(`handbook-orchestrator: ${orgs.length ? `this machine is not connected to ${orgs.find((o) => !ORG_NAME.test(o) || !readProfile(io.dataDir, o))}` : "this machine is not connected to any orchestrator"}; connect it from Settings > Your machines\n`);
      return NOT_CONNECTED_EXIT;
    }
    return runOrgs(orgs, io, tasks);
  }
  if (command === "status" && rest.length === 0) {
    const orgs = connectedOrgs(io.dataDir).flatMap((org) => {
      const profile = readProfile(io.dataDir, org);
      return profile ? [`${profile.org}  ${profile.address}  machine ${profile.machineId}`] : [];
    });
    io.out(orgs.length ? `${orgs.join("\n")}\n` : "This machine is not connected to any orchestrator; connect it from Settings > Your machines.\n");
    return 0;
  }
  if (command === "service") {
    // launchd restarts on any exit, so a service with nothing to run would start and stop every half minute.
    if (rest[0] === "install" && !connectedOrgs(io.dataDir).length) {
      io.err("handbook-orchestrator: this machine is not connected to any orchestrator; connect it first (runner connect), then install the service\n");
      return 1;
    }
    if (io.service) return serviceCommand(rest, io.service, RUNNER_SERVICE);
    io.err("handbook-orchestrator: a service runs the installed executable; install it, then run: handbook-orchestrator runner service install\n");
    return 1;
  }
  if (command === "disconnect" && rest.length === 1) {
    const org = rest[0]!;
    if (!ORG_NAME.test(org)) {
      io.err(`handbook-orchestrator: ${JSON.stringify(org)} is not an organization's short name; see runner status\n`);
      return 2;
    }
    const profile = readProfile(io.dataDir, org);
    if (!profile) {
      io.err(`handbook-orchestrator: this machine is not connected to ${org}\n`);
      return 1;
    }
    // The orchestrator is told first, so the token stops working there; the file goes either way.
    const revoked = await signedCall(profile, "POST", RUNNER_PATHS.disconnect, {}, io.fetch)
      .then((r) => r.ok)
      .catch(() => false);
    removeProfile(io.dataDir, org);
    io.out(revoked ? `This machine is disconnected from ${org}; its key no longer works there.\n` : `This machine forgot its connection to ${org}, but the orchestrator did not answer; remove it under Settings > Your machines so its key stops working there.\n`);
    // With no connection left the service would only start, find nothing to run and stop again.
    if (io.service && !connectedOrgs(io.dataDir).length && serviceInstalled(io.service.platform, io.service.home, RUNNER_SERVICE)) return serviceCommand(["uninstall"], io.service, RUNNER_SERVICE);
    return 0;
  }
  io.err(RUNNER_USAGE);
  return 2;
}
