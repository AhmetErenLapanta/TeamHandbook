import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { personsRepository, soloSession, until } from "../solo.js";
import { labDir } from "../state.js";

/**
 * What tasks like the next one have cost: the project's finished tasks with an agent give a range only
 * once there are five of them, and fewer give none. Five tasks of the stand-in claude, which reports one
 * cent each, are run one after the other and the range is asked after the fourth and after the fifth.
 */
const stamp = (what: string) => join(labDir(), "cost-range", `${what}-${Date.now().toString(36)}`);

test("given four finished tasks of one agent in a project, when a fifth finishes, then the range is none before it and the stand-in's cent after it", async ({ page }) => {
  test.setTimeout(900_000);
  // given
  const solo = await soloSession(page, stamp("five"));
  try {
    const repo = personsRepository(solo.machine);
    const { project } = await solo.call<{ project: { id: string } }>("POST", "/api/projects", { path: repo });
    const range = () => solo.call<{ tasks: number; lowUsd: number | null; highUsd: number | null }>("GET", `/api/tasks/cost-range?${new URLSearchParams({ repo: project.id, agent: "claude-code" })}`);
    const finish = async (n: number) => {
      const { task } = await solo.call<{ task: { id: string } }>("POST", "/api/tasks", { title: `Expose the delivery-window endpoint ${n}`, description: "", repoId: project.id, agent: "claude-code" });
      await until(() => solo.call<{ task: { status: string } }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status), 2400);
    };

    // when four have finished
    for (let n = 1; n <= 4; n++) await finish(n);

    // then there is no range
    expect(await range()).toEqual({ tasks: 4, lowUsd: null, highUsd: null });

    // when the fifth finishes
    await finish(5);

    // then the range is what the five cost
    const five = await range();
    expect(five.tasks).toBe(5);
    expect([five.lowUsd, five.highUsd].every((usd) => usd !== null && usd > 0 && usd < 1)).toBe(true);
  } finally {
    await solo.stop();
  }
});
