import { describe, expect, it } from "vitest";
import type { RepoRecord, TaskRecord } from "../api";
import { changesToReview, lastTaskByProject, opensRequests } from "./review";

const task = (id: string, over: Partial<TaskRecord>) => ({ id, repoId: "shop", status: "needs-review", result: null, changes: null, ...over }) as TaskRecord;

describe("changesToReview", () => {
  it("given tasks that changed folders, one undone, one kept, one still running and one with a request, when listed, then only the ended change neither undone nor kept waits", () => {
    // when
    const waiting = changesToReview([
      task("a", { result: "changes", changes: { files: [], undone: null } }),
      task("b", { result: "changes", changes: { files: [], undone: { at: "2026-11-04T10:00:00Z", by: "Ada", kept: [] } } }),
      task("k", { result: "changes", changes: { files: [], undone: null, kept: { at: "2026-11-04T10:00:00Z", by: "Ada" } } }),
      task("c", { result: null, status: "running" }),
      task("d", { result: "request" }),
    ]).map((t) => t.id);

    // then
    expect(waiting).toEqual(["a"]);
  });
});

describe("lastTaskByProject", () => {
  it("given tasks newest first over two projects, when each project's last is taken, then it is the first seen for each", () => {
    // when
    const last = lastTaskByProject([task("n2", { repoId: "api" }), task("n1", { repoId: "shop" }), task("o1", { repoId: "api" })]);

    // then
    expect([...last].map(([repo, t]) => [repo, t.id])).toEqual([["api", "n2"], ["shop", "n1"]]);
  });
});

describe("opensRequests", () => {
  it("given a folder without Git, one with Git and a forge repository with no facts, when asked, then only the folder without Git opens none", () => {
    // then
    expect([{ facts: { git: "none" } }, { facts: { git: "repo" } }, { facts: null }, {}].map((r) => opensRequests(r as unknown as RepoRecord))).toEqual([false, true, true, true]);
  });
});
