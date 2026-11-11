import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestratorDataDir } from "./data-lock.js";
import { localDataDir } from "./local.js";
import { drainTurns, gitAsync, gitAsyncMaybe, oneAtATime, turnKey } from "./git.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("work on one repository taking turns", () => {
  it("given three pieces of work on one repository and one on another, when they start at once, then the first three never overlap and the other runs alongside", async () => {
    // given
    const log: string[] = [];
    const work = (repo: string, name: string) =>
      oneAtATime(repo, async () => {
        log.push(`${name} start`);
        await pause(15);
        log.push(`${name} end`);
        return name;
      });

    // when
    const results = await Promise.all([work("/repos/a.git", "a1"), work("/repos/a.git", "a2"), work("/repos/b.git", "b1"), work("/repos/a.git", "a3")]);

    // then
    expect(results).toEqual(["a1", "a2", "b1", "a3"]);
    const onA = log.filter((line) => line.startsWith("a"));
    expect(onA).toEqual(["a1 start", "a1 end", "a2 start", "a2 end", "a3 start", "a3 end"]);
    expect(log.indexOf("b1 start")).toBeLessThan(log.indexOf("a1 end"));
  });

  it("given a piece of work that fails, when the next one on the same repository runs, then it still runs and the failure reaches only its own caller", async () => {
    // given
    const first = oneAtATime("/repos/a.git", async () => {
      throw new Error("git refused");
    });
    const second = oneAtATime("/repos/a.git", async () => "ran");

    // then
    await expect(first).rejects.toThrow("git refused");
    await expect(second).resolves.toBe("ran");
  });

  it("given two spellings of one path, when work is queued under each, then they share one turn", async () => {
    const log: string[] = [];
    const work = (repo: string, name: string) =>
      oneAtATime(repo, async () => {
        log.push(`${name} start`);
        await pause(10);
        log.push(`${name} end`);
      });
    await Promise.all([work("/repos/a.git", "x"), work("/repos/./a.git", "y")]);
    expect(log).toEqual(["x start", "x end", "y start", "y end"]);
  });
});

describe("a stop waiting for writes", () => {
  it("given a write under way, when a stop drains, then it returns only after the write finished", async () => {
    // given
    let finished = false;
    void oneAtATime("/repos/drain.git", async () => {
      await pause(40);
      finished = true;
    });

    // when
    const drained = await drainTurns(2_000);

    // then
    expect(drained).toBe(true);
    expect(finished).toBe(true);
  });

  it("given a write longer than the grace, when a stop drains, then it gives up at the limit and says so", async () => {
    void oneAtATime("/repos/slow.git", () => pause(300));
    const started = Date.now();
    expect(await drainTurns(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
    await drainTurns(2_000);
  });
});

describe("a read the caller gave up on", () => {
  it("given a signal that is already aborted, when git is asked, then it does not run and the caller sees the abort, not a missing object", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-git-"));
    await gitAsync(["init", "--quiet"], dir);
    const controller = new AbortController();
    controller.abort();

    // when
    const read = gitAsyncMaybe(["rev-parse", "HEAD"], dir, { signal: controller.signal });

    // then
    await expect(read).rejects.toThrow(/abort/i);
    expect(await gitAsyncMaybe(["rev-parse", "HEAD"], dir)).toBeNull();
  });

  it("given a git that a signal from outside ends, as a stop of the orchestrator's process group does, when it is asked, then the caller sees the stop, not a missing object", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-git-"));
    await gitAsync(["init", "--quiet"], dir);

    // when
    const read = gitAsyncMaybe(["-c", "alias.stopped=!kill -TERM $PPID", "stopped"], dir);

    // then
    await expect(read).rejects.toMatchObject({ signal: "SIGTERM" });
  });
});

describe("a repository whose folder is gone", () => {
  it("given a folder that was deleted, when git is asked to work in it, then the error names the missing repository rather than a missing git", async () => {
    // given
    const gone = join(mkdtempSync(join(tmpdir(), "orchestrator-git-gone-")), "team.git");

    // when
    const attempt = gitAsync(["rev-parse", "HEAD"], gone);

    // then
    await expect(attempt).rejects.toThrow(`the repository at ${gone} is no longer there`);
  });
});

describe("the data directory from the environment", () => {
  it("given ORCHESTRATOR_DATA_DIR unset, empty or set, when it is read, then empty counts as unset for every reader, a team's defaults to ./data and a local one to the system's place for application data", () => {
    expect(orchestratorDataDir({})).toBe(orchestratorDataDir({ ORCHESTRATOR_DATA_DIR: "" }));
    expect(orchestratorDataDir({ ORCHESTRATOR_MODE: "self-hosted" })).toMatch(/\/data$/);
    expect(orchestratorDataDir({})).toBe(localDataDir({}));
    expect(orchestratorDataDir({ ORCHESTRATOR_DATA_DIR: "/srv/orchestrator" })).toBe("/srv/orchestrator");
  });
});

describe("one repository's turn before and after it exists", () => {
  function linked() {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-turn-")));
    const link = `${real}-link`;
    symlinkSync(real, link);
    return { real, link };
  }

  it("given a repository not yet cloned, reached through a symbolic link, when its name is taken before and after the clone, then it is one name", () => {
    // given
    const { real, link } = linked();
    const before = turnKey(join(link, "mirrors", "a.git"));

    // when
    mkdirSync(join(real, "mirrors", "a.git"), { recursive: true });

    // then
    expect(turnKey(join(real, "mirrors", "a.git"))).toBe(before);
    expect(turnKey(join(link, "mirrors", "a.git/"))).toBe(before);
  });

  it("given a first clone under way through a link, when a sync of the folder it creates arrives, then the sync waits for the clone", async () => {
    // given
    const { real, link } = linked();
    const log: string[] = [];
    const clone = oneAtATime(join(link, "a.git"), async () => {
      log.push("clone start");
      mkdirSync(join(real, "a.git"));
      await pause(40);
      log.push("clone end");
    });
    await pause(5);

    // when
    const sync = oneAtATime(join(real, "a.git"), async () => void log.push("sync"));
    await Promise.all([clone, sync]);

    // then
    expect(log).toEqual(["clone start", "clone end", "sync"]);
  });
});
