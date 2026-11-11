import { describe, expect, it } from "vitest";
import { checksToSay, checkWords, stillFails } from "./verification-read";
import type { ProjectVerification } from "./verification-read";

const run = (code: number | null, timedOut = false) => ({ code, timedOut, ms: 1200, output: "", cut: 0 });

describe("checkWords", () => {
  it("given a check green before and after the agent's own turn, when its line is said, then it names no repair round", () => {
    // then
    expect(checkWords({ before: run(0), after: [run(0)] })).toBe("passed before, passed after");
  });

  it("given a check that failed after the agent and passed after one repair round, when its line is said, then it counts the round", () => {
    // then
    expect(checkWords({ before: run(0), after: [run(1), run(0)] })).toBe("passed before, passed after 1 repair round");
  });

  it("given a check that timed out before and failed after two repair rounds, when its line is said, then each state is its own word", () => {
    // then
    expect(checkWords({ before: run(null, true), after: [run(1), run(1), run(2)] })).toBe("timed out before, failed after 2 repair rounds");
  });

  it("given a check that never ran after the agent, when its line is said, then it says so", () => {
    // then
    expect(checkWords({ before: null, after: [] })).toBe("not run before, not run after");
  });
});

describe("stillFails", () => {
  it("given each verdict, when the line's tone is chosen, then only a check failing once the agent is done is drawn in danger", () => {
    // then
    expect(["passed", "fixed", "broken", "failing-before", "not-run"].map((verdict) => stillFails({ verdict: verdict as never }))).toEqual([false, false, true, true, false]);
  });
});

describe("checksToSay", () => {
  const check = (command: string) => ({ kind: "test" as const, command, runs: command, source: "package.json", network: false, long: false, digest: `d-${command}` });
  const found = { setup: null, checks: [check("npm test"), check("npm run lint")] };
  const verification = (over: Partial<ProjectVerification>): ProjectVerification => ({ configured: null, approved: null, detected: found, unread: null, changed: [], ...over });

  it("given a project nobody approved checks for, when the first box says them, then it proposes the first found and Start approves it", () => {
    // when
    const said = checksToSay(verification({}), null);

    // then
    expect(said.checks.map((c) => c.command)).toEqual(["npm test"]);
    expect(said.approve?.checks.map((c) => c.digest)).toEqual(["d-npm test"]);
    expect(said.canChange).toBe(true);
  });

  it("given approved checks whose files have not changed, when the box says them, then nothing waits on the person", () => {
    // when
    const said = checksToSay(verification({ approved: { checks: [check("npm test"), check("npm run lint")], setup: null, by: "Ada", at: "2026-11-04T10:00:00Z" } }), null);

    // then
    expect(said.checks.map((c) => c.command)).toEqual(["npm test", "npm run lint"]);
    expect(said.approve).toBeNull();
    expect(said.canChange).toBe(true);
  });

  it("given approved checks that changed since, when the box says them, then the found ones are proposed again", () => {
    // when
    const said = checksToSay(verification({ approved: { checks: [check("npm test")], setup: null, by: "Ada", at: "2026-11-04T10:00:00Z" }, changed: ["package.json"] }), null);

    // then
    expect(said.approve?.checks.map((c) => c.command)).toEqual(["npm test"]);
  });

  it("given a command the configuration sets, when the box says it, then it is said without Change and asks nothing", () => {
    // then
    expect(checksToSay(verification({ configured: "make check" }), null)).toEqual({ configured: "make check", checks: [], setup: null, approve: null, canChange: false });
  });

  it("given the person picked both found checks, when the box says them, then both are approved on Start", () => {
    // then
    expect(checksToSay(verification({}), ["npm test", "npm run lint"]).approve?.checks.map((c) => c.command)).toEqual(["npm test", "npm run lint"]);
  });

  it("given a project that installs before its checks, when the box says the first check, then the install is said with it and Start approves the very values said", () => {
    // given
    const setup = { command: "npm ci", runs: "npm ci", source: "package-lock.json", network: true, long: false, digest: "d-npm ci" };

    // when
    const said = checksToSay(verification({ detected: { setup, checks: found.checks } }), null);

    // then
    expect(said.setup).toBe(setup);
    expect(said.approve).toEqual({ checks: said.checks, setup: said.setup });
  });

  it("given a project that installs and every check unticked, when the box says them, then neither the install nor a check is said or approved", () => {
    // given
    const setup = { command: "npm ci", runs: "npm ci", source: "package-lock.json", network: true, long: false, digest: "d-npm ci" };

    // when
    const said = checksToSay(verification({ detected: { setup, checks: found.checks } }), []);

    // then
    expect(said.setup).toBeNull();
    expect(said.approve).toBeNull();
  });
});
