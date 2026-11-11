import { describe, expect, it } from "vitest";
import type { OrchestratorEvent, RepoRecord, TaskRecord } from "./api";
import { changeLine, logCsv, logEntries } from "./Logs";

const repos = [{ id: "payments-skills", team: "payments", name: "payments-skills" } as RepoRecord];
const task = (id: string, createdAt: string) => ({ id, repoId: "payments-skills", team: "payments", title: `Task ${id}`, status: "needs-review", createdBy: "Ada", createdAt }) as TaskRecord;

describe("logEntries", () => {
  it("given tasks in and out of the window, when the log is built, then only the window remains, newest first, one row a task in the one word of its state, each linked, and the reader called you", () => {
    // given
    const tasks = [task("t1", "2026-10-20T10:00:00Z"), task("t0", "2026-09-01T10:00:00Z"), { ...task("t3", "2026-10-22T10:00:00Z"), createdBy: "Bo", status: "failed" } as TaskRecord];

    // when
    const log = logEntries("acme", tasks, "2026-10-01T00:00:00Z", "Ada");

    // then
    expect(log.map((e) => [e.title, e.to, e.status, e.by])).toEqual([
      ["Task t3", "/acme/tasks/t3", "failed", "Bo"],
      ["Task t1", "/acme/tasks/t1", "needs you", "you"],
    ]);
  });

  it("given a title a spreadsheet would run, when exported, then it stays text", () => {
    // given
    const log = logEntries("acme", [{ ...task("t2", "2026-10-20T10:00:00Z"), title: "=cmd()" }], "2026-10-01T00:00:00Z");

    // when
    const csv = logCsv(log);

    // then
    expect(csv.split("\r\n")[1]).toBe("2026-10-20T10:00:00Z,'=cmd(),payments-skills,payments,needs you,Ada");
  });
});

describe("changeLine", () => {
  it("given a change of three fields, when shown, then the first reads before and after and the rest are counted", () => {
    // given
    const event = { changes: [{ field: "role", from: "member", to: "admin" }, { field: "teams", from: null, to: "payments" }, { field: "name", from: "A", to: "B" }] } as OrchestratorEvent;

    // when
    const line = changeLine(event);

    // then
    expect(line).toBe("role: member → admin +2");
  });

  it("given an event without field changes, when shown, then its detail is the line", () => {
    // given
    const event = { detail: "merged #4 on payments-skills" } as OrchestratorEvent;

    // when
    const line = changeLine(event);

    // then
    expect(line).toBe("merged #4 on payments-skills");
  });
});
