import { describe, expect, it } from "vitest";
import type { MachineAgentStatus } from "../server/runner-store.js";
import { machineOffers } from "./machine-agents.js";

describe("the agents a person's machine offers on the task form", () => {
  const claude = (fields: Partial<MachineAgentStatus>): MachineAgentStatus => ({ id: "claude-code", installed: true, version: "2.1.309", supported: "ok", signIn: "signed-in", ...fields });

  it("given Claude Code signed in on the machine, older than the version the orchestrator was checked with, or signed out, when the form reads it, then each says where it stands with its code", () => {
    // when
    const [current] = machineOffers([claude({})]);
    const [older] = machineOffers([claude({ version: "2.0.3", supported: "update" })]);
    const [signedOut] = machineOffers([claude({ signIn: "signed-out" })]);

    // then
    expect(current!.readiness).toEqual({ ready: true, state: "ready", first: null, code: null, fix: null });
    expect(older!.readiness).toMatchObject({ ready: true, state: "warnings", first: "version older than checked on your machine", code: "version-older" });
    expect(signedOut!.readiness).toMatchObject({ ready: false, state: "not-ready", first: "not signed in on your machine", code: "signin-missing" });
  });

  it("given two machines with Claude Code, one up to date, when the form reads them, then the agent counts as current", () => {
    // when
    const [both] = machineOffers([claude({ version: "2.0.3", supported: "update" }), claude({})]);

    // then
    expect(both!.readiness.state).toBe("ready");
  });
});
