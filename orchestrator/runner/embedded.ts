import { join } from "node:path";
import type { RunnerService } from "../server/runner-service.js";
import { killTaskGroup } from "../server/tasks/orphans.js";
import { localLink } from "./local-link.js";
import { startRunnerLoop } from "./loop.js";
import type { LoopOptions, RunnerLoop } from "./loop.js";
import { runnerDir } from "./profile.js";
import { RunnerState } from "./state.js";
import type { TaskExecutor } from "./task.js";

export const RESTARTED = "The orchestrator stopped before this task finished; Continue picks it up again.";

export interface EmbeddedRunner {
  loop: RunnerLoop;
  /** The tasks this start found leased from before and ended as interrupted. */
  recovered: string[];
  /** The agent process groups a previous run left and this start ended. */
  ended: number;
}

export interface EmbeddedOptions extends Omit<LoopOptions, "state"> {
  service: RunnerService;
  /** The local orchestrator's one person: only the tasks they start run here. */
  person: string;
  holder: string;
  executor: TaskExecutor;
  dataDir: string;
  kill?: typeof killTaskGroup;
}

/**
 * The runner inside a local orchestrator, started with it and stopped with it. Before it leases
 * anything it ends what a previous run left: the agent processes still running from a crash,
 * and the tasks still leased to it, which become interrupted rather than failed, so Continue
 * resumes them with the agent's own session.
 */
export async function startEmbeddedRunner({ service, person, holder, executor, dataDir, kill = killTaskGroup, ...options }: EmbeddedOptions): Promise<EmbeddedRunner> {
  const state = new RunnerState(join(runnerDir(dataDir), "local", "processes.json"));
  const ended = state.sweep((p) => kill(p.pgid, p.taskId, p.root)).length;
  const recovered = await service.recover(holder, RESTARTED);
  // A poll that fails waits longer each time before the next; said here, a slow first task is told apart from a slow checkout.
  const onPollFailed = (error: unknown, waitMs: number) => console.error(`runner: a poll failed (${error instanceof Error ? error.message : String(error)}); the next in ${Math.round(waitMs / 1000)} s`);
  const loop = startRunnerLoop(localLink(service, person, holder), executor, { onPollFailed, ...options, state });
  return { loop, recovered, ended };
}
