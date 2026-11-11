import { describe, expect, it } from "vitest";
import { folderPlace } from "../projects-read";
import { firstAgent, machineAgent } from "./FirstTask";
import type { MachineAgent } from "../machines/api";

const agent = (id: string, ready: boolean | null) => ({ id, label: id, readiness: ready === null ? null : { ready, state: ready ? ("ready" as const) : ("not-ready" as const) } });

describe("firstAgent", () => {
  it("given agents where only the second is ready, one not yet checked and none at all, when the first task's agent is chosen, then the ready one, then the first there is, then none", () => {
    // then
    expect(firstAgent([agent("opencode", false), agent("claude-code", true)])).toBe("claude-code");
    expect(firstAgent([agent("claude-code", null)])).toBe("claude-code");
    expect(firstAgent([])).toBeNull();
  });
});

describe("machineAgent", () => {
  const agent = (over: Partial<MachineAgent>): MachineAgent => ({ id: "claude-code", label: "Claude Code", installed: true, version: "2.1.316", supported: "ok", signIn: "signed-in", signInCommand: null, ...over });

  it("given a computer that runs one agent signed out and one signed in, when its first task's agent is chosen, then the signed-in one goes", () => {
    // when
    const chosen = machineAgent([agent({ signIn: "signed-out" }), agent({ id: "opencode", label: "OpenCode" })]);

    // then
    expect(chosen).toBe("opencode");
  });

  it("given a computer whose agents are all missing or too old, or that has reported none, when its first task's agent is chosen, then none goes", () => {
    // when
    const missing = machineAgent([agent({ installed: false }), agent({ id: "opencode", supported: "unsupported" })]);
    const unreported = machineAgent([]);

    // then
    expect(missing).toBeNull();
    expect(unreported).toBeNull();
  });

  it("given a computer whose only installed agent has not said whether it is signed in, when its first task's agent is chosen, then that one goes", () => {
    // when
    const chosen = machineAgent([agent({ installed: false }), agent({ id: "opencode", signIn: "unknown" })]);

    // then
    expect(chosen).toBe("opencode");
  });
});

describe("folderPlace", () => {
  it("given a folder on this machine and one on a connected machine, when the task box names where it works, then this machine's reads from home and the other's is its own ~ path, never its address", () => {
    // then
    expect(folderPlace({ url: "/Users/you/code/shop", machine: null }, "/Users/you")).toBe("~/code/shop");
    expect(folderPlace({ url: "file:///Users/you/code/shop" }, null)).toBe("/Users/you/code/shop");
    expect(folderPlace({ url: "machine:m1:~/code/shop", machine: { id: "m1", path: "~/code/shop" } }, null)).toBe("~/code/shop");
  });
});
