import { describe, expect, it } from "vitest";
import type { RequestRecord } from "../forge/types.js";
import { taskForge, taskState } from "./state.js";
import type { TaskRecord } from "./types.js";

const one = (status: TaskRecord["status"], more: Partial<TaskRecord> = {}) => ({ status, repoId: "payments", requestNumber: null, ...more }) as TaskRecord;
const request = (number: number, status: RequestRecord["status"], provider: RequestRecord["provider"]) => ({ repoId: "payments", number, status, provider, url: provider === "local" ? "" : `https://gitlab.example.com/acme/payments/-/merge_requests/${number}` }) as RequestRecord;
const REQUESTS = new Map([request(1, "open", "gitlab"), request(2, "merged", "github"), request(3, "closed", "gitlab"), request(4, "merged", "local"), request(5, "open", "local")].map((r) => [`${r.repoId}#${r.number}`, r]));
const requestOf = (repoId: string, number: number) => REQUESTS.get(`${repoId}#${number}`);

describe("where a task stands, in one word", () => {
  it("given tasks in each state a person sees, when each is read, then each has the one state its screens say and only a change on a forge carries its link", () => {
    // given
    const asked = { text: "What does PAY-142 ask for?", options: ["Paste the issue text"] };
    const tasks: [TaskRecord, string | null, boolean][] = [
      [one("queued"), null, false],
      [one("queued"), "machine", false],
      [one("queued"), "limit", false],
      [one("running"), null, false],
      [one("running"), null, true],
      [one("failed", { question: asked }), null, false],
      [one("failed", { question: { ...asked, answer: "It adds a refund lookup." } }), null, false],
      [one("failed"), null, false],
      [one("cancelled"), null, false],
      [one("interrupted"), null, false],
      [one("needs-review", { result: "changes" }), null, false],
      [one("needs-review", { result: "changes", changes: { files: [], undone: null, kept: { at: "", by: "" } } }), null, false],
      [one("needs-review", { result: "changes", changes: { files: [], undone: { at: "", by: "", kept: [] } } }), null, false],
      [one("needs-review", { requestNumber: 1 }), null, false],
      [one("needs-review", { requestNumber: 2 }), null, false],
      [one("needs-review", { requestNumber: 3 }), null, false],
      [one("needs-review", { requestNumber: 4 }), null, false],
      [one("needs-review", { requestNumber: 5 }), null, false],
    ];

    // when
    const states = tasks.map(([task, waitingFor, asking]) => taskState(task, requestOf, waitingFor, asking));
    const forges = [1, 4].map((n) => taskForge(one("needs-review", { requestNumber: n }), requestOf));

    // then
    expect(states).toEqual(["waiting", "waiting-machine", "usage-limit", "working", "needs-you", "needs-you", "failed", "failed", "stopped", "stopped", "needs-you", "kept", "undone", "in-review", "merged", "undone", "kept", "needs-you"]);
    expect(forges).toEqual([{ kind: "gitlab", number: 1, url: "https://gitlab.example.com/acme/payments/-/merge_requests/1" }, null]);
  });
});
