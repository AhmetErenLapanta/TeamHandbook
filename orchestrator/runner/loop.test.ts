import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderAnswer, FolderAsk, Lease, LessonAnswer, LessonAsk, LessonOpAnswer, LessonOpAsk, RunnerCommand, RunnerLink, TaskOutcome, UndoAnswer, UndoAsk } from "./link.js";
import { MachineRefused } from "./http-link.js";
import { BACKOFF_CEILING_MS, STABLE_MS, backoffMs, startRunnerLoop } from "./loop.js";
import { SHUT_DOWN } from "./task.js";
import type { ExecutorHooks, TaskExecutor } from "./task.js";

const lease: Lease = { leaseId: "lease-1", nextEvent: 1, task: { id: "task-1", title: "Add a field", agent: "claude-code", nativeSession: null } };
const mask = (text: string) => text;

type Poll = { lease: Lease | null; commands: RunnerCommand[]; folders?: FolderAsk[]; undos?: UndoAsk[]; lessons?: LessonAsk[]; lessonOps?: LessonOpAsk[] };

/** A link whose polls answer from a script, one entry per poll; past the script every poll waits a moment and brings nothing. */
function scriptedLink(script: (Poll | Error)[]) {
  const asked: boolean[] = [];
  const finished: TaskOutcome[] = [];
  const link: RunnerLink = {
    async poll(_wait, canTake, signal) {
      asked.push(canTake);
      const next = script.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
      return { lease: null, commands: [] };
    },
    renew: async () => true,
    events: async () => {},
    request: async () => {},
    progress: async () => {},
    finish: async (_task, _lease, outcome) => void finished.push(outcome),
  };
  return { link, asked, finished };
}

function heldExecutor() {
  let hooks: ExecutorHooks | null = null;
  const executor: TaskExecutor = {
    run: (_task, given) =>
      new Promise<TaskOutcome>((resolve) => {
        hooks = given;
        given.signal.addEventListener("abort", () => resolve({ status: "interrupted", error: (given.signal.reason as Error).message, nativeSessionId: null, branch: null, position: null, request: null }));
      }),
  };
  return { executor, hooks: () => hooks };
}

describe("the runner's poll loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("given a lease, when the task runs, then the next polls say the runner is busy and carry the task its commands", async () => {
    const { link, asked } = scriptedLink([
      { lease, commands: [] },
      { lease: null, commands: [{ type: "stop", taskId: "task-1" }] },
    ]);
    const held = heldExecutor();
    const loop = startRunnerLoop(link, held.executor, { mask });

    await vi.advanceTimersByTimeAsync(0);

    expect(asked.slice(0, 2)).toEqual([true, false]);
    expect(held.hooks()?.signal.aborted).toBe(true);
    await loop.stop();
  });

  it("given a poll that asks for a folder list while a task runs, when the machine lists it, then its answer goes back under the ask's nonce and the task is not held up", async () => {
    // given
    const ask: FolderAsk = { nonce: "nonce-1", under: "~/projects", q: null };
    const { link } = scriptedLink([{ lease, commands: [] }, { lease: null, commands: [], folders: [ask] }]);
    const answered: [string, FolderAnswer][] = [];
    link.folders = async (nonce, answer) => void answered.push([nonce, answer]);
    const listed: FolderAnswer = { under: "~/projects", parent: "~", folders: [], suggestions: [], truncated: false };
    const held = heldExecutor();

    // when
    const loop = startRunnerLoop(link, held.executor, { mask, listFolders: async (asked) => (asked.under === ask.under ? listed : { refused: "not-found", message: "no" }) });
    await vi.advanceTimersByTimeAsync(0);

    // then
    expect(answered).toEqual([["nonce-1", listed]]);
    expect(held.hooks()?.signal.aborted).toBe(false);
    await loop.stop();
  });

  it("given a poll that asks to undo a task's change in a folder, when the machine undoes it, then its answer goes back under the ask's nonce", async () => {
    // given
    const ask: UndoAsk = { nonce: "nonce-2", projectId: "prj_notes", path: "~/notes", before: "a".repeat(40), after: "b".repeat(40) };
    const { link } = scriptedLink([{ lease: null, commands: [], undos: [ask] }]);
    const answered: [string, UndoAnswer][] = [];
    link.undo = async (nonce, answer) => void answered.push([nonce, answer]);

    // when
    const loop = startRunnerLoop(link, heldExecutor().executor, { mask, undoInFolder: async (asked) => ({ undone: [asked.path], kept: [] }) });
    await vi.advanceTimersByTimeAsync(0);

    // then
    expect(answered).toEqual([["nonce-2", { undone: ["~/notes"], kept: [] }]]);
    await loop.stop();
  });

  it("given a poll that hands two lessons, one of which fails to queue, when the machine queues them, then the other's answer goes back under its own nonce and the polls go on", async () => {
    // given
    const asks: LessonAsk[] = [
      { nonce: "nonce-3", lesson: { draft: { slug: "log-with-the-app-logger" } } },
      { nonce: "nonce-4", lesson: { draft: { slug: "breaks" } } },
    ];
    const { link, asked } = scriptedLink([{ lease: null, commands: [], lessons: asks }]);
    const answered: [string, LessonAnswer][] = [];
    link.lesson = async (nonce, answer) => void answered.push([nonce, answer]);

    // when
    const loop = startRunnerLoop(link, heldExecutor().executor, {
      mask,
      queueLesson: async (ask) => {
        const slug = (ask.lesson as { draft: { slug: string } }).draft.slug;
        if (slug === "breaks") throw new Error("the queue is not writable");
        return { slug };
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    // then
    expect(answered).toEqual([["nonce-3", { slug: "log-with-the-app-logger" }]]);
    expect(asked.length).toBeGreaterThan(1);
    await loop.stop();
  });

  it("given a poll that hands a read and a keep of lessons, one of which fails, when the machine answers, then the other goes back under its own nonce and the polls go on", async () => {
    // given
    const asks: LessonOpAsk[] = [
      { nonce: "nonce-5", taskId: "tsk_1", slug: "log-with-the-app-logger", op: "keep" },
      { nonce: "nonce-6", taskId: "tsk_1", slug: "breaks", op: "read" },
    ];
    const { link, asked } = scriptedLink([{ lease: null, commands: [], lessonOps: asks }]);
    const answered: [string, LessonOpAnswer][] = [];
    link.lessonOp = async (nonce, answer) => void answered.push([nonce, answer]);

    // when
    const loop = startRunnerLoop(link, heldExecutor().executor, {
      mask,
      lessonOp: async (ask) => {
        if (ask.slug === "breaks") throw new Error("the queue is not readable");
        return { decided: "approved", muted: false };
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    // then
    expect(answered).toEqual([["nonce-5", { decided: "approved", muted: false }]]);
    expect(asked.length).toBeGreaterThan(1);
    await loop.stop();
  });

  it("given two slots and two tasks waiting, when the runner polls, then it runs both at once, asks for no third while both run, and hands each its own Stop", async () => {
    // given
    const second: Lease = { leaseId: "lease-2", nextEvent: 1, task: { id: "task-2", title: "Add a runbook", agent: "claude-code", nativeSession: null } };
    const { link, asked } = scriptedLink([{ lease, commands: [] }, { lease: second, commands: [] }, { lease: null, commands: [{ type: "stop", taskId: "task-2" }] }]);
    const started: ExecutorHooks[] = [];
    const executor: TaskExecutor = {
      run: (_task, given) =>
        new Promise<TaskOutcome>((resolve) => {
          started.push(given);
          given.signal.addEventListener("abort", () => resolve({ status: "interrupted", error: null, nativeSessionId: null, branch: null, position: null, request: null }));
        }),
    };

    // when
    const loop = startRunnerLoop(link, executor, { mask, slots: () => 2 });
    await vi.advanceTimersByTimeAsync(0);

    // then
    expect(asked.slice(0, 3)).toEqual([true, true, false]);
    expect(started).toHaveLength(2);
    expect(started.map((hooks) => hooks.signal.aborted)).toEqual([false, true]);
    expect(loop.busy()).toBe(1);
    await loop.stop();
  });

  it("given polls that keep failing, when the runner waits between them, then each wait grows and none passes the ceiling", async () => {
    const failures = Array.from({ length: 12 }, () => new Error("offline"));
    const { link } = scriptedLink(failures);
    const waits: number[] = [];
    const loop = startRunnerLoop(link, heldExecutor().executor, { mask, random: () => 1, onPollFailed: (_e, wait) => waits.push(wait) });

    await vi.advanceTimersByTimeAsync(BACKOFF_CEILING_MS * 12);

    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(Math.max(...waits)).toBe(BACKOFF_CEILING_MS);
    await loop.stop();
  });

  it("given a link that has been steady for the stable time, when a poll fails again, then the wait starts from the first step", async () => {
    const { link } = scriptedLink([new Error("offline"), new Error("offline"), new Error("offline")]);
    const waits: number[] = [];
    const loop = startRunnerLoop(link, heldExecutor().executor, { mask, random: () => 1, onPollFailed: (_e, wait) => waits.push(wait) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(waits).toEqual([1_000, 2_000, 4_000]);

    await vi.advanceTimersByTimeAsync(STABLE_MS + 2_000);
    const later = scriptedLink([new Error("offline")]);
    link.poll = later.link.poll;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(waits.at(-1)).toBe(1_000);
    await loop.stop();
  });

  it("given a task running, when the runner stops, then the agent is stopped and its outcome still reaches the orchestrator", async () => {
    const { link, finished } = scriptedLink([{ lease, commands: [] }]);
    const held = heldExecutor();
    const loop = startRunnerLoop(link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;

    expect(finished).toEqual([{ status: "interrupted", error: SHUT_DOWN, nativeSessionId: null, branch: null, position: null, request: null }]);
  });

  it("given a task running, when the orchestrator refuses the machine, then the agent stops at once and the loop ends without waiting for the lease to run out", async () => {
    // given
    const { link } = scriptedLink([{ lease, commands: [] }, new MachineRefused("the orchestrator no longer takes this machine")]);
    const held = heldExecutor();
    const refused: Error[] = [];
    let ended = false;

    // when
    const loop = startRunnerLoop(link, held.executor, { mask, onRefused: (error) => void refused.push(error) });
    void loop.stopped.then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(1_000);

    // then
    expect(refused).toHaveLength(1);
    expect(held.hooks()?.signal.aborted).toBe(true);
    expect(ended).toBe(true);
  });

  it("given random spread, when waits are drawn, then each lies between half and all of its step", () => {
    expect(backoffMs(3, () => 0)).toBe(2_000);
    expect(backoffMs(3, () => 1)).toBe(4_000);
    expect(backoffMs(40, () => 0)).toBe(BACKOFF_CEILING_MS / 2);
  });
});
