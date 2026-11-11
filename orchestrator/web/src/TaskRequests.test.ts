import { describe, expect, it } from "vitest";
import type { TaskRequest } from "./api";
import { limitLine, machineWait, waitingFirst } from "./TaskRequests";

const asked = (id: string, status: TaskRequest["status"], responseCapability: TaskRequest["responseCapability"] = "live"): TaskRequest => ({ id, kind: "command", payload: { tool: "Bash", summary: id }, status, responseCapability, answer: null, answeredBy: null, createdAt: "2026-11-03T10:00:00Z" });

describe("waitingFirst", () => {
  it("given answered, expired and two waiting requests, when they are ordered, then the waiting ones lead newest first and the settled ones follow newest first", () => {
    // given
    const all = [asked("a-old", "answered"), asked("w-old", "pending"), asked("gone", "expired", "not_resumable"), asked("w-new", "pending"), asked("a-new", "answered")];

    // when
    const ordered = waitingFirst(all).map((r) => r.id);

    // then
    expect(ordered).toEqual(["w-new", "w-old", "a-new", "gone", "a-old"]);
  });

  it("given a pending request whose agent went away, when ordered, then it does not count as waiting", () => {
    // when
    const ordered = waitingFirst([asked("stale", "pending", "not_resumable"), asked("done", "answered")]).map((r) => r.id);

    // then
    expect(ordered).toEqual(["done", "stale"]);
  });
});

describe("machineWait", () => {
  it("given a team task with no machine connected and one whose machine is away, when each is read, then both wait for the machine with the step that moves each", () => {
    // when
    const none = machineWait({ waitingFor: "connect" }, { mode: "self-hosted" });
    const away = machineWait({ waitingFor: "machine" }, { mode: "cloud" });

    // then
    expect(none).toEqual({ badge: "waiting for your machine", line: "This task waits for your machine: none of yours is connected yet.", link: "Connect your machine" });
    expect(away?.link).toBe("Your machines");
  });

  it("given one person's own orchestrator or a task waiting on something else, when read, then it does not wait for a machine", () => {
    // then
    expect(machineWait({ waitingFor: "connect" }, { mode: "local" })).toBeNull();
    expect(machineWait({ waitingFor: "limit" }, { mode: "cloud" })).toBeNull();
    expect(machineWait({ waitingFor: null }, { mode: "cloud" })).toBeNull();
  });
});

describe("limitLine", () => {
  const now = new Date(2026, 10, 4, 10, 0);

  it("given a limit that resets later today, when it is said, then the task resumes at that local time by itself", () => {
    // then
    expect(limitLine(new Date(2026, 10, 4, 14, 0).toISOString(), now)).toBe("Your plan's usage limit is reached; the task goes on by itself at 14:00.");
  });

  it("given a limit that resets tomorrow within a day, when it is said, then it says tomorrow", () => {
    // then
    expect(limitLine(new Date(2026, 10, 5, 9, 30).toISOString(), now)).toBe("Your plan's usage limit is reached; the task goes on by itself at 09:30 tomorrow.");
  });

  it("given a limit more than a day off, when it is said, then the person continues it, and with no reset time they are told so", () => {
    // then
    expect(limitLine(new Date(2026, 10, 7, 9, 0).toISOString(), now)).toMatch(/^Your plan's usage limit is reached until .+ at 09:00; continue the task then\.$/);
    expect(limitLine(null, now)).toBe("Your plan's usage limit is reached; continue the task once it resets.");
  });
});
