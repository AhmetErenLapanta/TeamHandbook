import { LeaseGone, MachineRefused, NotTaken, ProtocolMismatch } from "./http-link.js";
import type { ChecksAnswer, ChecksAsk, FolderAnswer, FolderAsk, LessonAnswer, LessonAsk, LessonOpAnswer, LessonOpAsk, PushAnswer, PushAsk, RunnerLink, SetupAnswer, SetupAsk, TaskOutcome, UndoAnswer, UndoAsk } from "./link.js";
import { runLeasedTask } from "./task.js";
import type { LeasedTask, TaskExecutor, TaskOptions } from "./task.js";

/** How long one poll waits: under the half minute after which NATs and corporate proxies cut a quiet connection. */
export const POLL_WAIT_MS = 25_000;
/** The first wait after a failed poll, doubled on each failure up to the ceiling. */
export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_CEILING_MS = 300_000;
/** How long polls have to keep succeeding before the next failure starts from the first wait again. */
export const STABLE_MS = 30_000;

/** The wait after the `failures`-th failure in a row: between half and all of its doubled step, so many runners do not return together. */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const step = Math.min(BACKOFF_CEILING_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

export interface RunnerLoop {
  /** Stops polling and the task running, which still reports its outcome; resolves when both are done. */
  stop(): Promise<void>;
  readonly stopped: Promise<void>;
  /** How many tasks it runs now. */
  busy(): number;
}

export interface LoopOptions extends TaskOptions {
  random?: () => number;
  /** Told each failed poll and the wait before the next, for the runner's own log. */
  onPollFailed?: (error: unknown, waitMs: number) => void;
  /** This machine's folders for a list its person asked for; a runner without it answers none, and the screen says the machine did not answer. */
  listFolders?: (ask: FolderAsk) => Promise<FolderAnswer>;
  /** This machine's undo of a task's change in one of its folders, as its person asked. */
  undoInFolder?: (ask: UndoAsk) => Promise<UndoAnswer>;
  /** This machine's queueing of a lesson from one of its person's tasks into their own review queue. */
  queueLesson?: (ask: LessonAsk) => Promise<LessonAnswer>;
  /** This machine's reading of a folder project's checks, for the screen that approves them. */
  readChecks?: (ask: ChecksAsk) => Promise<ChecksAnswer>;
  pushBranch?: (ask: PushAsk) => Promise<PushAnswer>;
  setupHere?: (ask: SetupAsk) => Promise<SetupAnswer>;
  /** This machine's read or decision of a lesson in its person's queue, as they asked on a task's page. */
  lessonOp?: (ask: LessonOpAsk) => Promise<LessonOpAnswer>;
  /** How many tasks the runner takes at once, asked before each poll; one when left out. */
  slots?: () => number;
  /**
   * Told when the orchestrator refuses this machine for good (it was removed, or one side has to be
   * updated); the loop then ends, since asking again changes nothing.
   */
  onRefused?: (error: MachineRefused | ProtocolMismatch) => void;
}

/** Leases tasks up to its slots, hands each running task its own commands, and keeps polling through outages. */
export function startRunnerLoop(link: RunnerLink, executor: TaskExecutor, options: LoopOptions): RunnerLoop {
  const { random = Math.random, onPollFailed = () => {}, now = Date.now, listFolders, undoInFolder, queueLesson, readChecks, lessonOp, pushBranch, setupHere, slots = () => 1, onRefused = () => {} } = options;
  const running = new Map<string, LeasedTask>();
  const late = new Map<string, NonNullable<TaskOutcome["changes"]>>();
  const halt = new AbortController();
  const deliverLate = async () => {
    for (const [taskId, changes] of late) {
      try {
        await link.lateChanges!(taskId, changes);
        late.delete(taskId);
      } catch (error) {
        if (error instanceof LeaseGone || error instanceof NotTaken) late.delete(taskId);
        else throw error;
      }
    }
  };
  let wakeSleep: (() => void) | null = null;
  // The poll under way when it began with every slot taken. It says for its whole wait that the runner takes nothing,
  // so a task that ended meanwhile left its slot unoffered until the wait ran out, and a task waiting for this runner
  // read as waiting its turn for up to that long. It is ended as a task finishes, and the next poll offers the slot.
  let full: AbortController | null = null;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const stopped = (async () => {
    let failures = 0;
    let stableSince: number | null = null;
    while (!halt.signal.aborted) {
      const turn = new AbortController();
      const endTurn = () => turn.abort();
      halt.signal.addEventListener("abort", endTurn, { once: true });
      const canTake = running.size < slots();
      full = canTake ? null : turn;
      try {
        await deliverLate();
        const { lease, commands, folders = [], undos = [], lessons = [], checks = [], lessonOps = [], pushes = [], setups = [] } = await link.poll(POLL_WAIT_MS, canTake && late.size === 0, turn.signal);
        if (stableSince === null) stableSince = now();
        if (now() - stableSince >= STABLE_MS) failures = 0;
        for (const command of commands) running.get(command.taskId)?.command(command);
        // Answered beside the polls, never holding one up; one that does not go through leaves the screen to say the machine did not answer.
        if (listFolders && link.folders) for (const ask of folders) void listFolders(ask).then((answer) => link.folders!(ask.nonce, answer)).catch(() => {});
        if (undoInFolder && link.undo) for (const ask of undos) void undoInFolder(ask).then((answer) => link.undo!(ask.nonce, answer)).catch(() => {});
        if (queueLesson && link.lesson) for (const ask of lessons) void queueLesson(ask).then((answer) => link.lesson!(ask.nonce, answer)).catch(() => {});
        if (readChecks && link.checks) for (const ask of checks) void readChecks(ask).then((answer) => link.checks!(ask.nonce, answer)).catch(() => {});
        if (lessonOp && link.lessonOp) for (const ask of lessonOps) void lessonOp(ask).then((answer) => link.lessonOp!(ask.nonce, answer)).catch(() => {});
        if (pushBranch && link.push) for (const ask of pushes) void pushBranch(ask).then((answer) => link.push!(ask.nonce, answer)).catch(() => {});
        if (setupHere && link.setup) for (const ask of setups) void setupHere(ask).then((answer) => link.setup!(ask.nonce, answer)).catch(() => {});
        // A lease the poll was not asked for is still run: the orchestrator holds it for this runner now.
        if (lease && !running.has(lease.task.id) && !halt.signal.aborted) {
          const task = runLeasedTask(lease, link, executor, options);
          running.set(lease.task.id, task);
          void task.done
            .then(({ outcome, reported }) => {
              if (!reported && outcome.changes && link.lateChanges) late.set(lease.task.id, outcome.changes);
            })
            .finally(() => {
              if (running.get(lease.task.id) === task) running.delete(lease.task.id);
              full?.abort();
            });
        }
      } catch (error) {
        if (halt.signal.aborted) break;
        // A poll this loop ended to offer a freed slot failed nothing.
        if (turn.signal.aborted) continue;
        if (error instanceof MachineRefused || error instanceof ProtocolMismatch) {
          onRefused(error);
          for (const task of running.values()) task.shutDown();
          break;
        }
        stableSince = null;
        failures += 1;
        const wait = backoffMs(failures, random);
        onPollFailed(error, wait);
        await sleep(wait);
      } finally {
        halt.signal.removeEventListener("abort", endTurn);
        if (full === turn) full = null;
      }
    }
    await Promise.all([...running.values()].map((task) => task.done));
  })();

  return {
    async stop() {
      halt.abort();
      for (const task of running.values()) task.shutDown();
      wakeSleep?.();
      await stopped;
    },
    stopped,
    busy: () => running.size,
  };
}
