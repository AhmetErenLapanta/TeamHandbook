import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../server/tasks/adapters/contract.js";
import { MachineRefused, NotTaken } from "./http-link.js";
import type { Lease, NumberedEvent, RunnerLink, TaskOutcome, TaskProgress } from "./link.js";
import { FENCE_MS, FLUSH_MS, LOST_LEASE, RENEW_MS, STOPPED, runLeasedTask } from "./task.js";
import type { ExecutorHooks, TaskExecutor } from "./task.js";

const lease = (nextEvent = 1): Lease => ({ leaseId: "lease-1", nextEvent, task: { id: "task-1", title: "Add a field", agent: "claude-code", nativeSession: null } });
const done: TaskOutcome = { status: "needs-review", error: null, nativeSessionId: "native-1", branch: "handbook/add-a-field", position: null, request: null };
const mask = (text: string) => text.replaceAll("hunter2-secret", "[redacted]");

function fakeLink(overrides: Partial<RunnerLink> = {}) {
  const sent: NumberedEvent[][] = [];
  const requests: AgentRequest[] = [];
  const finished: TaskOutcome[] = [];
  const recorded: TaskProgress[] = [];
  const link: RunnerLink = {
    poll: async () => ({ lease: null, commands: [] }),
    renew: async () => true,
    events: async (_task, _lease, events) => void sent.push(events),
    request: async (_task, _lease, request) => void requests.push(request),
    progress: async (_task, _lease, progress) => void recorded.push(progress),
    finish: async (_task, _lease, outcome) => void finished.push(outcome),
    ...overrides,
  };
  return { link, sent, requests, finished, recorded };
}

/** An executor that hands its hooks to the test and ends when the test says so, or when it is stopped. */
function heldExecutor() {
  let hooks: ExecutorHooks | null = null;
  let end: (outcome: TaskOutcome) => void = () => {};
  const executor: TaskExecutor = {
    run: (_task, given) =>
      new Promise<TaskOutcome>((resolve) => {
        hooks = given;
        end = resolve;
        given.signal.addEventListener("abort", () => resolve({ status: "interrupted", error: String(given.signal.reason), nativeSessionId: null, branch: null, position: null, request: null }));
      }),
  };
  return { executor, hooks: () => hooks!, end: (outcome: TaskOutcome) => end(outcome) };
}

describe("a leased task on this machine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("given renewals that keep failing, when the fence time passes, then the agent is stopped and nobody is told an outcome", async () => {
    const { link, finished } = fakeLink({ renew: async () => Promise.reject(new Error("offline")) });
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });

    await vi.advanceTimersByTimeAsync(FENCE_MS - RENEW_MS);
    expect(held.hooks().signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(held.hooks().signal.aborted).toBe(true);
    const result = await running.done;
    expect(result).toEqual({ outcome: { status: "interrupted", error: LOST_LEASE, nativeSessionId: null, branch: null, position: null, request: null }, reported: false });
    expect(finished).toEqual([]);
  });

  it("given the orchestrator no longer takes this machine, when the runner renews, then the agent stops at once and nobody is told an outcome", async () => {
    // given
    const refused = new MachineRefused("the orchestrator no longer takes this machine");
    const { link, finished } = fakeLink({ renew: async () => Promise.reject(refused), events: async () => Promise.reject(refused), finish: async () => Promise.reject(refused) });
    const held = heldExecutor();

    // when
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(RENEW_MS);

    // then
    expect(held.hooks().signal.aborted).toBe(true);
    expect(await running.done).toEqual({ outcome: { status: "interrupted", error: LOST_LEASE, nativeSessionId: null, branch: null, position: null, request: null }, reported: false });
    expect(finished).toEqual([]);
  });

  it("given the orchestrator refuses a progress as it is, when the task ends, then that progress is left out and the outcome still reaches it, instead of the progress being sent again until the lease runs out", async () => {
    // given
    const { link, finished } = fakeLink({ progress: async () => Promise.reject(new NotTaken("progress names its stage, base, branch, tests, cost and session, each in its own shape")) });
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    // when
    held.hooks().record({ baseSha: "abc1234" });
    held.end({ status: "needs-review", error: null, nativeSessionId: null, branch: "task/x", position: null, request: null });
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 4);

    // then
    expect(await running.done).toMatchObject({ reported: true });
    expect(finished).toHaveLength(1);
  });

  it("given the orchestrator refuses a question as it is, when the agent asks, then the agent is told no at once instead of waiting on a card that never shows", async () => {
    // given
    const { link } = fakeLink({ request: async () => Promise.reject(new NotTaken("a request names its id, kind, tool and summary")) });
    const held = heldExecutor();
    runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    // when
    const answer = held.hooks().decide({ id: "req-9", kind: "command", tool: "Bash", summary: "npm test" });

    // then
    expect(await answer).toEqual({ decision: "deny" });
  });

  it("given the orchestrator says the lease is someone else's, when the runner renews, then it stops at once", async () => {
    const { link } = fakeLink({ renew: async () => false });
    const held = heldExecutor();
    runLeasedTask(lease(), link, held.executor, { mask });

    await vi.advanceTimersByTimeAsync(RENEW_MS);

    expect(held.hooks().signal.aborted).toBe(true);
    expect(await held.hooks().leaseHeld()).toBe(false);
  });

  it("given a held lease, when the executor asks before pushing, then it hears the lease is still this runner's", async () => {
    const { link } = fakeLink();
    const held = heldExecutor();
    runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    expect(await held.hooks().leaseHeld()).toBe(true);
  });

  it("given an events call that fails once, when it is sent again, then the same numbers go out and the outcome follows them", async () => {
    let calls = 0;
    const { link, sent, finished } = fakeLink({
      events: async (_task, _lease, events) => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        sent.push(events);
      },
    });
    const held = heldExecutor();
    const running = runLeasedTask(lease(7), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    held.hooks().onEvent({ type: "message", text: "reading the model" });
    held.hooks().onEvent({ type: "output", text: "token hunter2-secret" });
    held.hooks().log("Running the team's tests");
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    held.end(done);
    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(sent).toEqual([
      [
        { n: 7, event: { type: "message", text: "reading the model" } },
        { n: 8, event: { type: "output", text: "token [redacted]" } },
        { n: 9, event: { type: "log", text: "Running the team's tests" } },
      ],
    ]);
    expect(await running.done).toEqual({ outcome: done, reported: true });
    expect(finished).toEqual([done]);
  });

  it("given the agent asks its person a question, when their answers arrive, then the executor gets the answers and the orchestrator saw the question masked, its keys and values as asked", async () => {
    // given
    const { link, requests } = fakeLink();
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    // when
    const answer = held.hooks().decide({ id: "q-1", kind: "question", tool: "question", summary: "Which token?", questions: [{ key: "q1", title: "Use hunter2-secret?", choice: "one", options: [{ value: "yes", label: "yes, hunter2-secret" }] }] });
    await vi.advanceTimersByTimeAsync(0);
    running.command({ type: "answer", taskId: "task-1", requestId: "q-1", decision: "allow-once", answers: { q1: { chosen: ["yes"], other: null } } });

    // then
    expect(await answer).toEqual({ decision: "allow-once", answers: { q1: { chosen: ["yes"], other: null } } });
    expect(requests).toEqual([{ id: "q-1", kind: "question", tool: "question", summary: "Which token?", questions: [{ key: "q1", title: "Use [redacted]?", choice: "one", options: [{ value: "yes", label: "yes, [redacted]" }] }] }]);
  });

  it("given the agent asks, when the person's answer arrives, then the executor gets that decision and the orchestrator saw a masked summary", async () => {
    const { link, requests } = fakeLink();
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    const answer = held.hooks().decide({ id: "req-1", kind: "command", tool: "Bash", summary: "curl -H hunter2-secret" });
    await vi.advanceTimersByTimeAsync(0);
    running.command({ type: "answer", taskId: "task-2", requestId: "req-1", decision: "allow-once" });
    running.command({ type: "answer", taskId: "task-1", requestId: "req-1", decision: "deny", note: "not on this host" });

    expect(await answer).toEqual({ decision: "deny", note: "not on this host" });
    expect(requests).toEqual([{ id: "req-1", kind: "command", tool: "Bash", summary: "curl -H [redacted]" }]);
  });

  it("given a Stop, when it reaches the runner, then the agent is stopped and the outcome is reported as the task's", async () => {
    const { link, finished } = fakeLink();
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    running.command({ type: "stop", taskId: "task-1" });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(held.hooks().signal.reason).toEqual(new Error(STOPPED));
    expect((await running.done).reported).toBe(true);
    expect(finished[0]?.status).toBe("interrupted");
  });

  it("given progress whose first send fails, when it is sent again, then the stages arrive in order and before the outcome", async () => {
    let calls = 0;
    const order: string[] = [];
    const { link } = fakeLink({
      progress: async (_task, _lease, progress) => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        order.push(`progress ${JSON.stringify(progress)}`);
      },
      finish: async () => void order.push("finish"),
    });
    const held = heldExecutor();
    const running = runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    held.hooks().record({ baseSha: "abc123" });
    held.hooks().record({ stage: "tests", tests: "passed" });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    held.end(done);
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 2);

    expect(order).toEqual(['progress {"baseSha":"abc123"}', 'progress {"stage":"tests","tests":"passed"}', "finish"]);
    expect((await running.done).reported).toBe(true);
  });

  it("given an outcome whose request text carries a secret, when it is reported, then the orchestrator gets it masked", async () => {
    const { link, finished } = fakeLink();
    const held = heldExecutor();
    runLeasedTask(lease(), link, held.executor, { mask });
    await vi.advanceTimersByTimeAsync(0);

    held.end({ ...done, request: { title: "Add a field", body: "Tests passed with hunter2-secret in the env" } });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);

    expect(finished[0]?.request).toEqual({ title: "Add a field", body: "Tests passed with [redacted] in the env" });
  });
});
