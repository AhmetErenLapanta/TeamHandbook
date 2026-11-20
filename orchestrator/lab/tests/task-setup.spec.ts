import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildScaleHome } from "../../browser-tests/handbook-scale-home.js";
import { claudeStandIn, personsRepository, soloSession, until } from "../solo.js";
import { labDir } from "../state.js";

/**
 * "This task will use" at the size of a real person's own setup: thirty skills and the commands, hooks and servers
 * beside them (the stand-in home of the handbook scenarios; its plugins are Claude Code's own state, which the lab's
 * stand-in claude does not answer, so they are not in this scenario). One task turns one skill off for itself alone and starts without it, said in
 * its log and its record; the next task, started with nothing turned off, loads it again, and the person's own
 * default is unchanged between the two. The home is the stand-in home of the handbook scenarios, laid under the
 * clean machine's; the agent is the stand-in claude.
 */
const stamp = (what: string) => join(labDir(), "task-setup", `${what}-${Date.now().toString(36)}`);
const TITLE = "Expose the delivery-window endpoint";

interface Source {
  id: string;
  kind: string;
  skills?: { name: string }[];
}

test("given a real-size setup and a skill turned off for one task, when that task starts and the next one starts after it, then the first runs without the skill, the second loads it again, and the default is unchanged", async ({ page }) => {
  test.setTimeout(600_000);
  // given
  const root = stamp("one-skill");
    const scaleRoot = mkdtempSync(join(tmpdir(), "task-setup-"));
  const scale = buildScaleHome(scaleRoot);
  const solo = await soloSession(page, join(root, "machine"), (machine) => {
    cpSync(join(scale.home, ".claude"), join(machine.home, ".claude"), { recursive: true });
    return { ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(join(root, "machine")) };
  });
  try {
    const repo = personsRepository(solo.machine);
    const { project } = await solo.call<{ project: { id: string } }>("POST", "/api/projects", { path: repo });
    const read = await solo.call<{ available: boolean; sources: Source[] }>("GET", `/api/handbook/sources?folder=${encodeURIComponent(repo)}`);
    expect(read.available).toBe(true);
    const own = read.sources.find((s) => s.kind === "yours" && (s.skills ?? []).length > 0)!;
    expect(own.skills!.length, "skills of the person's own setup").toBeGreaterThanOrEqual(30);
    const skill = own.skills![0]!.name;
    const defaultsBefore = await solo.call<{ off: unknown }>("GET", "/api/handbook/defaults");
    const run = async (extra: Record<string, unknown>) => {
      const { task } = await solo.call<{ task: { id: string } }>("POST", "/api/tasks", { title: TITLE, description: "", repoId: project.id, agent: "claude-code", ...extra });
      const done = await until(() => solo.call<{ task: { status: string; error: string | null; off?: { skills: { name: string }[] }; offChanges?: number }; log: { text: string }[] }>("GET", `/api/tasks/${task.id}`), (r) => !["queued", "running"].includes(r.task.status), 2400);
      return done;
    };

    // when the first task turns the skill off for itself, and the next one turns nothing off
    const first = await run({ off: { skills: [{ source: own.id, name: skill }] } });
    const next = await run({});

    // then
    expect([first.task.status, first.task.error]).toEqual(["needs-review", null]);
    expect(first.task.off?.skills.map((s) => s.name)).toEqual([skill]);
    expect(first.task.offChanges).toBe(1);
    expect(first.log.some((l) => l.text.startsWith("Turned off for this task alone:") && l.text.includes(skill))).toBe(true);
    expect([next.task.status, next.task.error]).toEqual(["needs-review", null]);
    expect(next.task.off).toBeUndefined();
    expect(next.log.some((l) => l.text.startsWith("Turned off for this task alone:"))).toBe(false);
    expect(await solo.call("GET", "/api/handbook/defaults")).toEqual(defaultsBefore);
  } finally {
    await solo.stop();
    rmSync(scaleRoot, { recursive: true, force: true });
  }
});
