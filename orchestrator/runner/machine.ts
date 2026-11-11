import { join } from "node:path";
import { killTaskGroup } from "../server/tasks/orphans.js";
import { checksInFolder, machineFolders, undoInFolder } from "./folders.js";
import { lessonOpHere, queueLessonHere } from "./lessons.js";
import { httpLink } from "./http-link.js";
import { startRunnerLoop } from "./loop.js";
import type { LoopOptions, RunnerLoop } from "./loop.js";
import { connectedOrgs, orgDir, readProfile } from "./profile.js";
import type { Fetch } from "./profile.js";
import { RunnerState } from "./state.js";
import { sweepTaskRoots } from "./task-roots.js";
import type { MachineAgentStatus } from "../server/runner-store.js";
import type { TaskExecutor } from "./task.js";

export interface MachineRunner {
  /** The organizations this machine runs tasks for now. */
  orgs: string[];
  /** Stops every loop: the agents stop and their outcomes are still reported. */
  stop(): Promise<void>;
  /** Settles once every loop has ended, on its own (the orchestrator refused the machine) or by stop. */
  readonly stopped: Promise<void>;
  /** How many tasks it runs now. */
  busy(): number;
}

/** How often the machine tells its orchestrators what its agents are: often enough that a sign-in shows within minutes. */
export const STATUS_EVERY_MS = 5 * 60_000;

export interface MachineOptions extends Omit<LoopOptions, "state"> {
  /** What this machine's agents are now; asked at start and every STATUS_EVERY_MS. */
  agents?: () => Promise<MachineAgentStatus[]>;
  dataDir: string;
  /** The person's home folder, the one folder lists are read under. */
  home: string;
  /** The person's environment: the credentials a lesson is screened for, and their TEAMHANDBOOK_HOME. */
  env?: Record<string, string | undefined>;
  /** How many more tasks this runner may take now, asked before each poll; the caller shares the machine's slots between its runners. */
  slots?: () => number;
  /** The folders the executor works in in place now, the ones an undo is refused in. */
  working?: ReadonlySet<string>;
  executor: TaskExecutor;
  /** One organization, or every one this machine is paired with. */
  org?: string;
  fetch?: Fetch;
  kill?: typeof killTaskGroup;
}

/**
 * The runner of a machine paired with one or more teams' orchestrators: one loop for each, each
 * with its own record of the agents it started, so a crash is cleaned up per organization and
 * never touches what the local orchestrator on the same machine runs.
 */
export function startMachineRunner({ dataDir, home, env = {}, working = new Set(), slots, executor, org, fetch: fetchImpl, kill = killTaskGroup, agents, ...options }: MachineOptions): MachineRunner {
  const orgs = org ? [org] : connectedOrgs(dataDir);
  const loops: RunnerLoop[] = [];
  const links: ReturnType<typeof httpLink>[] = [];
  for (const name of orgs) {
    const profile = readProfile(dataDir, name);
    if (!profile) throw new Error(`this machine is not connected to ${name}; connect it from Settings > Your machines`);
    const state = new RunnerState(join(orgDir(dataDir, name), "processes.json"));
    state.sweep((p) => kill(p.pgid, p.taskId, p.root));
    void sweepTaskRoots(join(orgDir(dataDir, name), "tasks")).catch(() => {});
    const link = httpLink(profile, fetchImpl);
    links.push(link);
    const where = { home, dataDir, shadows: join(orgDir(dataDir, name), "shadow") };
    loops.push(startRunnerLoop(link, executor, { ...options, state, listFolders: (ask) => machineFolders(ask.under, ask.q, where), undoInFolder: (ask) => undoInFolder(ask, where, working), readChecks: (ask) => checksInFolder(ask, where), queueLesson: async (ask) => queueLessonHere(ask, home, env), lessonOp: async (ask) => lessonOpHere(ask, home, env), ...(slots ? { slots } : {}) }));
  }
  // A status that does not go through is sent again at the next round; it never holds a task up.
  const announced = new Set<ReturnType<typeof httpLink>>();
  const report = async () => {
    if (!agents) return;
    const seen = await agents().catch(() => null);
    if (seen) await Promise.all(links.map((link) => link.status?.(seen, !announced.has(link)).then(() => void announced.add(link), () => undefined)));
  };
  void report();
  const timer = setInterval(() => void report(), STATUS_EVERY_MS);
  const stopped = Promise.all(loops.map((loop) => loop.stopped)).then(() => clearInterval(timer));
  return {
    orgs,
    async stop() {
      clearInterval(timer);
      await Promise.all(loops.map((loop) => loop.stop()));
    },
    stopped,
    busy: () => loops.reduce((sum, loop) => sum + loop.busy(), 0),
  };
}
