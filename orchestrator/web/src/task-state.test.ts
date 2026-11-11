import { describe, expect, it } from "vitest";
import { stateOf, stateSaid } from "./task-state";

describe("stateSaid", () => {
  it("given each state and a forge, when it is said, then every state has its one word and tone, and a task in review names its forge", () => {
    // when
    const said = [
      stateSaid("waiting", null),
      stateSaid("working", null),
      stateSaid("needs-you", null),
      stateSaid("kept", null),
      stateSaid("in-review", { kind: "gitlab", number: 12, url: "https://gitlab.example/x/-/merge_requests/12" }),
      stateSaid("in-review", { kind: "github", number: 3, url: "https://github.com/x/y/pull/3" }),
      stateSaid("merged", null),
      stateSaid("failed", null),
      stateSaid("stopped", null),
    ];

    // then
    expect(said.map((s) => s.word)).toEqual(["waiting its turn", "working", "needs you", "kept on this machine", "in review on GitLab", "in review on GitHub", "merged", "failed", "stopped"]);
    expect(said.map((s) => s.tone)).toEqual(["neutral", "info", "warn", "ok", "info", "info", "ok", "error", "neutral"]);
  });
});

describe("stateOf", () => {
  it("given the orchestrator's own word, it is the word; given a record without one, the same facts say the same state", () => {
    // then
    expect(stateOf({ state: "kept", status: "failed" })).toBe("kept");
    expect(stateOf({ status: "queued" })).toBe("waiting");
    expect(stateOf({ status: "running" })).toBe("working");
    expect(stateOf({ status: "running", waitingFor: "limit" })).toBe("usage-limit");
    expect(stateOf({ status: "running", waitingFor: "machine" })).toBe("waiting-machine");
    expect(stateOf({ status: "needs-review", phase: "review", request: { status: "open", provider: "local" } })).toBe("needs-you");
    expect(stateOf({ status: "failed", question: { text: "Which?" } as { answer?: string } })).toBe("needs-you");
    expect(stateOf({ status: "needs-review", phase: "merged", request: { status: "merged", provider: "local" } })).toBe("kept");
    expect(stateOf({ status: "needs-review", phase: "merged", request: { status: "merged", provider: "gitlab" } })).toBe("merged");
    expect(stateOf({ status: "needs-review", phase: "review", request: { status: "open", provider: "gitlab" } })).toBe("in-review");
    expect(stateOf({ status: "needs-review", request: { status: "closed", provider: "local" } })).toBe("undone");
    expect(stateOf({ status: "failed" })).toBe("failed");
    expect(stateOf({ status: "running", requests: [{ status: "pending", responseCapability: "live" }] })).toBe("needs-you");
    expect(stateOf({ status: "running", requests: [{ status: "answered", responseCapability: "live" }] })).toBe("working");
    expect(stateOf({ status: "cancelled" })).toBe("stopped");
    expect(stateOf({ status: "interrupted" })).toBe("stopped");
  });
});
