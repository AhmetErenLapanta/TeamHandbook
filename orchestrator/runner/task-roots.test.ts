import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEEP_STOPPED_TASK_MS, sweepTaskRoots } from "./task-roots.js";

describe("the folders a machine keeps for its stopped tasks", () => {
  let tasks: string;
  beforeEach(() => void (tasks = mkdtempSync(join(tmpdir(), "task-roots-"))));
  afterEach(() => {
    execFileSync("chmod", ["-R", "u+w", tasks]);
    rmSync(tasks, { recursive: true, force: true });
  });

  const kept = (name: string, ageMs: number) => {
    const root = join(tasks, name);
    mkdirSync(join(root, "guard"), { recursive: true });
    writeFileSync(join(root, "guard", "personal-settings.json"), "{}\n");
    chmodSync(join(root, "guard"), 0o500);
    const at = (Date.now() - ageMs) / 1000;
    utimesSync(root, at, at);
    return root;
  };

  it("given a task stopped longer ago than a task is kept and one stopped yesterday, when the runner starts, then the old one's folder goes, its guard with it, and yesterday's stays for Continue", async () => {
    // given
    const old = kept("tsk_old", KEEP_STOPPED_TASK_MS + 60_000);
    const recent = kept("tsk_recent", 24 * 60 * 60_000);

    // when
    const removed = await sweepTaskRoots(tasks);

    // then
    expect(removed).toEqual(["tsk_old"]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("given a machine that never kept a task, when the runner starts, then nothing is swept", async () => {
    // when
    const removed = await sweepTaskRoots(join(tasks, "none-here"));

    // then
    expect(removed).toEqual([]);
  });
});
