import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import type { TaskTarget } from "../tasks/types.js";
import { openKeptChange } from "./machine-request.js";

const HEAD = "d".repeat(40);
const ADA = { id: "u-ada", email: "ada@example.invalid" } as Principal;
const PAT = { id: "u-pat", email: "pat@example.invalid" } as Principal;

const kept = (fields: Partial<TaskTarget> = {}): TaskTarget => ({ repoId: "code", status: "local", reason: "unpushed", path: "alpha", head: HEAD, origin: "https://gitlab.example.invalid/acme/alpha.git", baseSha: "b".repeat(40), branch: "handbook/fix", tests: null, requestNumber: null, error: null, cost: { usd: null, inputTokens: null, outputTokens: null }, ...fields });

/** Ada's task in her machine's folder, with one change kept on the machine as `target` says. */
async function taskWith(target: TaskTarget) {
  const store = openSqliteStore(":memory:");
  const at = new Date().toISOString();
  await store.upsertRepo({ tenant: "acme", id: "code", team: "Payments", name: "code", url: "machine:m1:~/code" });
  await store.createTask({ tenant: "acme", id: "tsk_a", repoId: "code", team: "Payments", title: "Fix the retry", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review", createdBy: ADA.email, createdAt: at, startedAt: at, finishedAt: at, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, stage: "tests", skills: [], targetMode: "pinned" });
  await store.setTaskTargets("acme", "tsk_a", [target]);
  return { store, tenant: "acme" } as unknown as OrchestratorContext;
}

/** A machine and an opener that note what they were handed and answer as given. */
function standIns(pushed: { pushed: true } | { unread: string }, opened: TaskTarget | { refused: string } = kept({ status: "request", reason: "changed by the agent in alpha", requestNumber: 7 })) {
  const handed: unknown[] = [];
  const push = async (_ctx: OrchestratorContext, project: { id: string }, entry: unknown) => (handed.push({ project: project.id, entry }), pushed);
  const open = async (_ctx: OrchestratorContext, taskId: string, position: number) => (handed.push({ taskId, position }), opened);
  return { push, open, handed };
}

describe("a change kept on its machine, opened as a request because its starter pressed", () => {
  it("given the task's starter, when they press, then the machine is handed the branch and head the task recorded, and the request opens for that change", async () => {
    const ctx = await taskWith(kept());
    const { push, open, handed } = standIns({ pushed: true });

    const target = await openKeptChange(ctx, ADA, "tsk_a", 0, push, open);

    expect(target).toMatchObject({ status: "request", requestNumber: 7 });
    expect(handed).toEqual([{ project: "code", entry: { path: "alpha", branch: "handbook/fix", head: HEAD } }, { taskId: "tsk_a", position: 0 }]);
  });

  it("given someone other than the task's starter, when they press, then it is refused and the machine is never asked", async () => {
    const ctx = await taskWith(kept());
    const { push, open, handed } = standIns({ pushed: true });

    await expect(openKeptChange(ctx, PAT, "tsk_a", 0, push, open)).rejects.toMatchObject({ code: "not-starter", status: 403 });
    expect(handed).toEqual([]);
  });

  it("given a change with no remote, or one already opened, when its starter presses, then it is refused as not kept for a push", async () => {
    for (const target of [kept({ reason: "no-remote", origin: undefined }), kept({ status: "request", requestNumber: 3 })]) {
      const ctx = await taskWith(target);
      const { push, open, handed } = standIns({ pushed: true });

      await expect(openKeptChange(ctx, ADA, "tsk_a", 0, push, open)).rejects.toMatchObject({ code: "not-kept", status: 409 });
      expect(handed).toEqual([]);
    }
  });

  it("given the machine refusing the push, when its starter presses, then its reason comes back and no request is asked for", async () => {
    const ctx = await taskWith(kept());
    const { push, open, handed } = standIns({ unread: "ada-laptop did not push handbook/fix: handbook/fix of alpha moved since the task ended, so it was not pushed; push it yourself once it is ready" });

    await expect(openKeptChange(ctx, ADA, "tsk_a", 0, push, open)).rejects.toMatchObject({ code: "not-pushed", status: 409, message: expect.stringContaining("moved since the task ended") });
    expect(handed).toHaveLength(1);
  });

  it("given a change the machine pushed to a remote no organization connected, when its starter presses, then the request opens with their sign-in and the change records it as the forge's, with no machine push", async () => {
    // given
    const ctx = await taskWith(kept({ reason: "not-connected" }));
    const { push, open, handed } = standIns({ pushed: true });
    const unconnected = async () => ({ opened: { forge: "GitLab", account: "ada", number: 12, url: "https://gitlab.example.invalid/acme/alpha/-/merge_requests/12" } });

    // when
    const target = await openKeptChange(ctx, ADA, "tsk_a", 0, push, open, unconnected);

    // then
    expect(target).toMatchObject({ status: "request", reason: "opened on GitLab as ada", forgeRequest: { forge: "GitLab", number: 12, url: "https://gitlab.example.invalid/acme/alpha/-/merge_requests/12" } });
    expect(handed).toEqual([]);
  });

  it("given the branch pushed and the request refused by the orchestrator's checks, when its starter presses, then it says the branch was pushed and why no request opened", async () => {
    const ctx = await taskWith(kept());
    const { push, open } = standIns({ pushed: true }, { refused: "the task's starter is no longer on record here" });

    await expect(openKeptChange(ctx, ADA, "tsk_a", 0, push, open)).rejects.toMatchObject({ code: "not-opened", message: "handbook/fix was pushed, and the request did not open: the task's starter is no longer on record here" });
  });
});
