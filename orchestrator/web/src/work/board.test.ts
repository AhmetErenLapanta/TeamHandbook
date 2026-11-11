import { describe, expect, it } from "vitest";
import type { WorkItem, WorkItems, WorkTaskLink } from "./api";
import { isMine, morningSummary, nextIssue, placeItems, sprintSummary, taskBadge } from "./board";

const item = (key: string, status: string, category: WorkItem["status"]["category"], over: Partial<WorkItem> = {}): WorkItem => ({
  key, url: `https://tracker.example/browse/${key}`, summary: key, type: null, status: { name: status, category },
  column: null, assignee: null, priority: null, epic: null, labels: [], storyPoints: null, tasks: [], ...over,
});

const task = (over: Partial<WorkTaskLink> = {}): WorkTaskLink => ({ taskId: "t1", status: "running", targets: [], requests: [], startedBy: "Ada", costUsd: null, ...over });

describe("placing issues on the board", () => {
  it("given the server's placement, when issues are placed, then each sits in that column whatever its status is named, and one with no column goes to Other", () => {
    // given
    const columns = [{ name: "In Dev", statuses: ["In Dev"] }, { name: "Code Review", statuses: ["Code Review"] }];

    // when
    const placed = placeItems(columns, [item("E-1", "In Dev", "doing", { column: "Code Review" }), item("E-2", "Parked", "todo", { column: null })]);

    // then
    expect(placed.map((c) => [c.name, c.items.map((i) => i.key)])).toEqual([["In Dev", []], ["Code Review", ["E-1"]], ["Other", ["E-2"]]]);
  });

  it("given a tracker that names no columns, when issues are placed, then they fall into To do, In progress and Done by their status category and no Other is added", () => {
    // when
    const placed = placeItems([], [item("B-1", "Open", "todo"), item("B-2", "Closed", "done")]);

    // then
    expect(placed.map((c) => [c.name, c.items.map((i) => i.key)])).toEqual([["To do", ["B-1"]], ["In progress", []], ["Done", ["B-2"]]]);
  });
});

describe("the sprint header", () => {
  it("given tasks with requests and costs, when the sprint is summed, then an open request counts once however many issues name it, and a task without a cost marks the total partial", () => {
    // given
    const shared = { repoId: "api", number: 7, status: "open" as const, url: null, name: "api #7" };
    const read: WorkItems = {
      columns: [], fetchedAt: "", stale: false, truncated: false,
      progress: { todo: 1, doing: 1, done: 2, points: null },
      items: [
        item("C-1", "In Dev", "doing", { blocked: true, tasks: [task({ costUsd: 1.5, requests: [shared] })] }),
        item("C-2", "Code Review", "doing", { tasks: [task({ costUsd: null, requests: [shared, { ...shared, number: 8, status: "merged" }] })] }),
      ],
    };

    // when
    const summary = sprintSummary(read);

    // then
    expect(summary).toEqual({ done: 2, total: 4, openRequests: 1, blocked: 1, costUsd: 1.5, costPartial: true, reviewOn: null });
  });

  it("given open requests on one forge, and then on a forge and a local copy, when the sprint is summed, then the forge is named only while it is the one place they wait", () => {
    // given
    const onGitlab = (number: number) => ({ repoId: "shop", number, status: "open" as const, url: `https://gitlab.example/shop/-/merge_requests/${number}`, name: `Merge request !${number} on GitLab` });
    const local = { repoId: "api", number: 3, status: "open" as const, url: null, name: "api #3" };
    const sprint = (tasks: WorkTaskLink[]) => ({ columns: [], fetchedAt: "", stale: false, truncated: false, progress: { todo: 0, doing: 2, done: 0, points: null }, items: [item("E-1", "Review", "doing", { tasks })] }) as WorkItems;

    // when
    const one = sprintSummary(sprint([task({ requests: [onGitlab(1)] }), task({ requests: [onGitlab(2)] })]));
    const mixed = sprintSummary(sprint([task({ requests: [onGitlab(1)] }), task({ requests: [local] })]));

    // then
    expect([one.openRequests, one.reviewOn, mixed.openRequests, mixed.reviewOn]).toEqual([2, "GitLab", 2, null]);
  });

  it("given no task reported a cost, when the sprint is summed, then the cost is unknown rather than zero", () => {
    // when
    const summary = sprintSummary({ columns: [], fetchedAt: "", stale: false, truncated: false, progress: { todo: 0, doing: 0, done: 0, points: null }, items: [item("D-1", "To Do", "todo", { tasks: [task()] })] });

    // then
    expect([summary.costUsd, summary.costPartial]).toEqual([null, false]);
  });
});

describe("a card's agent badge", () => {
  const gitlab = { repoId: "shop", number: 12, status: "open" as const, url: "https://gitlab.example/shop/-/merge_requests/12", name: "Merge request !12 on GitLab" };

  it("given a task at each stage, when the badge is read, then it is the one word every list says, kept on this machine apart from merged on a forge", () => {
    // then
    expect(taskBadge(task({ status: "queued", phase: "planned" }))).toEqual({ label: "waiting its turn", tone: "neutral" });
    expect(taskBadge(task({ status: "running", phase: "working" }))).toEqual({ label: "working", tone: "info" });
    expect(taskBadge(task({ phase: "merged", status: "needs-review" }))).toEqual({ label: "kept on this machine", tone: "ok" });
    expect(taskBadge(task({ phase: "merged", status: "needs-review", requests: [{ ...gitlab, status: "merged" }] }))).toEqual({ label: "merged", tone: "ok" });
    expect(taskBadge(task({ phase: "review", status: "needs-review", requests: [gitlab] }))).toEqual({ label: "in review on GitLab", tone: "info" });
    expect(taskBadge(task({ phase: "review", status: "needs-review", result: "request", requests: [{ ...gitlab, url: null, name: "shop" }] }))).toEqual({ label: "needs you", tone: "warn" });
  });

  it("given a task in a folder with no Git, or undone, or failed, or stopped, when the badge is read, then the words are the same ones", () => {
    // then
    expect(taskBadge(task({ phase: "review", status: "needs-review", result: "changes" }))).toEqual({ label: "needs you", tone: "warn" });
    expect(taskBadge(task({ phase: "merged", status: "needs-review", result: "changes" }))).toEqual({ label: "kept on this machine", tone: "ok" });
    expect(taskBadge(task({ phase: "failed", status: "needs-review", result: "changes" }))).toEqual({ label: "undone", tone: "neutral" });
    expect(taskBadge(task({ phase: "failed", status: "needs-review", result: "request", requests: [{ repoId: "shop", number: 4, status: "closed", url: null, name: "shop" }] }))).toEqual({ label: "undone", tone: "neutral" });
    expect(taskBadge(task({ phase: "failed", status: "failed" }))).toEqual({ label: "failed", tone: "error" });
    expect(taskBadge(task({ phase: "failed", status: "cancelled" }))).toEqual({ label: "stopped", tone: "neutral" });
  });
});

describe("the person's own work", () => {
  const me = { name: "Ada Admin", email: "ada@example.invalid" };

  it("given the server's word on the assignee, when it is read, then it wins over the names, and a task the person started makes the issue theirs too", () => {
    // then
    expect(isMine(item("F-1", "In Dev", "doing", { assignee: { name: "Ada Admin", you: false } as WorkItem["assignee"] }), me)).toBe(false);
    expect(isMine(item("F-2", "In Dev", "doing", { assignee: { name: "Someone", you: true } as WorkItem["assignee"] }), me)).toBe(true);
    expect(isMine(item("F-3", "In Dev", "doing", { tasks: [task({ startedBy: "ada@example.invalid" })] }), me)).toBe(true);
  });

  it("given no word from the server, when the assignee's name is the person's orchestrator name in another case, then the issue is theirs, and nobody else's is", () => {
    // then
    expect(isMine(item("G-1", "In Dev", "doing", { assignee: { name: "ada admin" } }), me)).toBe(true);
    expect(isMine(item("G-2", "In Dev", "doing", { assignee: { name: "Pat Payments" }, tasks: [task({ startedBy: "pat@example.invalid" })] }), me)).toBe(false);
    expect(isMine(item("G-3", "In Dev", "doing"), me)).toBe(false);
  });
});

describe("the morning summary and what to start next", () => {
  const me = { name: "Ada Admin", email: "ada@example.invalid" };
  const sprint = (items: WorkItem[]): WorkItems => ({
    columns: [], items, fetchedAt: "2026-11-04T08:00:00.000Z", stale: false, truncated: false,
    progress: { todo: items.filter((i) => i.status.category === "todo").length, doing: items.filter((i) => i.status.category === "doing").length, done: items.filter((i) => i.status.category === "done").length, points: null },
  });

  it("given waiting issues, one already started by an agent, one blocked, one of the person's and one of higher priority, when the next one is picked, then it is the person's own, then by priority", () => {
    // given
    const read = sprint([
      item("F-1", "To Do", "todo", { priority: "Highest", tasks: [task({ status: "running" })] }),
      item("F-2", "To Do", "todo", { priority: "High", blocked: true }),
      item("F-3", "To Do", "todo", { priority: "High" }),
      item("F-4", "To Do", "todo", { priority: "Low", assignee: { name: "Ada Admin", you: true } as WorkItem["assignee"] }),
    ]);

    // then
    expect(nextIssue(read, me)?.key).toBe("F-4");
    expect(nextIssue(sprint(read.items.filter((i) => i.key !== "F-4")), me)?.key).toBe("F-3");
  });

  it("given a sprint with work in review, at work and blocked, when the summary is made, then it says where the sprint stands and lists each, one issue a line, ending with what to start next", () => {
    // given
    const read = sprint([
      item("F-1", "In Review", "doing", { summary: "Round refunds", tasks: [task({ status: "needs-review", requests: [{ repoId: "pay", number: 7, status: "open", url: null, name: "pay #7" }] })] }),
      item("F-2", "In Dev", "doing", { summary: "Export statements", tasks: [task({ status: "running" })] }),
      item("F-3", "To Do", "todo", { summary: "Card limits", blocked: true }),
      item("F-4", "To Do", "todo", { summary: "Receipt payee" }),
      item("F-5", "Done", "done", { summary: "Ledger" }),
    ]);

    // when
    const said = morningSummary("Payments Sprint 31", read, me);

    // then
    expect(said).toBe(["Payments Sprint 31: 1 of 5 done, 2 in progress, 2 to do.", "", "In review:", "- F-1 Round refunds", "", "Agents at work on:", "- F-2 Export statements", "", "Blocked:", "- F-3 Card limits", "", "Next up:", "- F-4 Receipt payee"].join("\n"));
  });
});

