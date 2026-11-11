import { describe, expect, it } from "vitest";
import { attentionOf, decisionOf, newCalls, taskRows } from "./attention";
import type { Attention } from "./attention";

const task = (id: string, status: "queued" | "running" | "needs-review" | "failed" | "cancelled", phase?: "working" | "review" | "merged" | "failed", attention?: "approval" | "answer" | "limited") => ({ id, status, phase, attention });

describe("what a task wants of its person", () => {
  it("given the agent's own call, a request in review, a failure and a merged task, when each is read, then the agent's call comes first and a merged task wants nothing", () => {
    // then
    expect(attentionOf(task("a", "running", "working", "approval"))).toBe("approval");
    expect(attentionOf(task("b", "needs-review", "review"))).toBe("review");
    expect(attentionOf(task("c", "failed"))).toBe("failed");
    expect(attentionOf(task("d", "needs-review", "merged"))).toBeNull();
    expect(attentionOf(task("e", "running", "working"))).toBeNull();
  });

  it("given a running task that waits on a plan, a permission or a question, when it is read, then it calls on its person with no flag from the agent", () => {
    // then
    expect(attentionOf({ ...task("a", "running", "working"), state: "needs-you" as const })).toBe("approval");
    expect(attentionOf({ ...task("b", "running", "working"), requests: [{ status: "pending", responseCapability: "live" }] })).toBe("approval");
    expect(attentionOf({ ...task("c", "running", "working"), requests: [{ status: "answered", responseCapability: "live" }] })).toBeNull();
  });
});

describe("a teammate's follow-up", () => {
  it("given a suggestion its starter can answer, when the task is read, then it calls as a follow-up after the agent's own calls and before review", () => {
    // given
    const suggested = { ...task("f", "needs-review", "review"), suggestions: [{ canAnswer: true }] as never };
    const asking = { ...task("g", "needs-review", "review", "answer"), suggestions: [{ canAnswer: true }] as never };
    const answered = { ...task("h", "needs-review", "review"), suggestions: [{ canAnswer: false }] as never };

    // then
    expect(attentionOf(suggested)).toBe("follow-up");
    expect(attentionOf(asking)).toBe("answer");
    expect(attentionOf(answered)).toBe("review");
  });
});

describe("which calls are notified", () => {
  it("given the first look, when tasks already want their person, then nothing is notified", () => {
    // then
    expect(newCalls(null, [task("a", "failed")], new Set(), null)).toEqual([]);
  });

  it("given a task that now waits for review and one that already did, when they are read again, then only the new call is notified", () => {
    // given
    const before = new Map<string, Attention | null>([["a", null], ["b", "review"]]);

    // when
    const calls = newCalls(before, [task("a", "needs-review", "review"), task("b", "needs-review", "review")], new Set(), null);

    // then
    expect(calls).toEqual([{ id: "a", attention: "review" }]);
  });

  it("given a call already seen and a task open on screen, when they turn up, then neither is notified", () => {
    // given
    const before = new Map<string, Attention | null>([["a", null], ["b", null]]);

    // when
    const calls = newCalls(before, [task("a", "failed"), task("b", "running", "working", "answer")], new Set(["a:failed"]), "b");

    // then
    expect(calls).toEqual([]);
  });
});

describe("the task list as its reader works it", () => {
  const mine = (t: ReturnType<typeof task>) => ({ ...t, createdBy: "ada@example.test" });
  const theirs = (t: ReturnType<typeof task>) => ({ ...t, createdBy: "pat@example.test" });
  const tasks = [mine(task("old", "running", "working")), theirs(task("t-fail", "failed")), mine(task("m-review", "needs-review", "review")), mine(task("m-ask", "running", "working", "approval"))];

  it("given the reader's own calls among others, when all are listed, then their calls lead most pressing first, the rest keep their order, and an opened call is not unread", () => {
    // when
    const rows = taskRows(tasks, "ada@example.test", new Set(["m-review:review"]), "all");

    // then
    expect(rows.map((r) => [r.task.id, r.call, r.unread])).toEqual([["m-ask", "approval", true], ["m-review", "review", false], ["old", null, false], ["t-fail", null, false]]);
  });

  it("given the same tasks, when the reader keeps theirs or only what needs them, then a teammate's failure is left out of both", () => {
    // when
    const own = taskRows(tasks, "ada@example.test", new Set(), "mine").map((r) => r.task.id);
    const calls = taskRows(tasks, "ada@example.test", new Set(), "needs-you").map((r) => r.task.id);

    // then
    expect(own).toEqual(["m-ask", "m-review", "old"]);
    expect(calls).toEqual(["m-ask", "m-review"]);
  });
});

describe("decisionOf", () => {
  const ended = { status: "needs-review" as const };
  it("given changes undone, kept or a request closed, read from the task itself, when its decision is asked, then each names what the person decided", () => {
    // then
    expect(decisionOf({ ...ended, result: "changes", changes: { files: [], undone: { at: "t", by: "Ada", kept: [] } } })).toBe("undone");
    expect(decisionOf({ ...ended, result: "changes", changes: { files: [], undone: null, kept: { at: "t", by: "Ada" } } })).toBe("kept");
    expect(decisionOf({ ...ended, result: "request", request: { status: "closed" } })).toBe("closed");
  });

  it("given only the phase the board reads, when its decision is asked, then a failed phase on a task that ended for review is the person's undo or close, not the agent", () => {
    // then
    expect(decisionOf({ ...ended, result: "changes", phase: "failed" })).toBe("undone");
    expect(decisionOf({ ...ended, result: "changes", phase: "merged" })).toBe("kept");
    expect(decisionOf({ ...ended, result: "request", phase: "failed", requests: [{ status: "closed" }] })).toBe("closed");
  });

  it("given a task the agent failed, one still waiting for review and one merged, when its decision is asked, then none is the person's", () => {
    // then
    expect(decisionOf({ status: "failed", phase: "failed" })).toBeNull();
    expect(decisionOf({ ...ended, result: "changes", phase: "review", changes: { files: [], undone: null } })).toBeNull();
    expect(decisionOf({ ...ended, result: "request", phase: "merged", request: { status: "merged" } })).toBeNull();
  });
});

describe("attentionOf and a decision", () => {
  it("given changes undone, kept and a request closed, when the task's call is read, then none calls on its person and none is notified", () => {
    // given
    const undone = { id: "u", status: "needs-review" as const, phase: "failed" as const, result: "changes" as const, changes: { files: [], undone: { at: "t", by: "Ada", kept: [] } } };
    const kept = { id: "k", status: "needs-review" as const, phase: "merged" as const, result: "changes" as const, changes: { files: [], undone: null, kept: { at: "t", by: "Ada" } } };
    const closed = { id: "c", status: "needs-review" as const, phase: "failed" as const, result: "request" as const, request: { status: "closed" } };

    // when
    const calls = [undone, kept, closed].map((t) => attentionOf(t));
    const notified = newCalls(new Map(), [undone, kept, closed], new Set(), null);

    // then
    expect(calls).toEqual([null, null, null]);
    expect(notified).toEqual([]);
    expect(attentionOf({ status: "failed", phase: "failed" })).toBe("failed");
  });
});

describe("a run that stopped to ask", () => {
  it("given a failed task with a question waiting, one already answered and one with none, when each is read, then the waiting one calls for its answer and the others are a failure or nothing", () => {
    // given
    const waiting = { ...task("i", "failed"), question: { text: "Which environment?", options: [] } };
    const answered = { ...task("j", "failed"), question: { text: "Which environment?", options: [], answer: "staging" } };

    // then
    expect(attentionOf(waiting)).toBe("answer");
    expect(attentionOf(answered)).toBe("failed");
    expect(attentionOf(task("k", "failed"))).toBe("failed");
  });
});
