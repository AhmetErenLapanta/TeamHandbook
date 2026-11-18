import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { personsRepository, soloSession, until } from "../solo.js";
import { labDir } from "../state.js";

/**
 * A person attaches a file to a new task on their own orchestrator: it is kept for them first, the start
 * names it, and the task's page lists it by name and size while the repository holds no copy of it. The agent's
 * own copy lives in the run's folder, which is removed when the run ends. The agent is the stand-in claude.
 */
const stamp = (what: string) => join(labDir(), "attachments", `${what}-${Date.now().toString(36)}`);
const NOTE = "The delivery window ends at five.\n";

test("given a file attached before the task starts, when the task runs, then the page lists the file, and the file is in no commit of the person's repository", async ({ page }) => {
  test.setTimeout(600_000);
  // given
  const solo = await soloSession(page, stamp("note"));
  try {
    const repo = personsRepository(solo.machine);
    const { project } = await solo.call<{ project: { id: string } }>("POST", "/api/projects", { path: repo });
    const { csrf } = (await (await page.request.get(`${solo.base}/api/me`)).json()) as { csrf: string };
    const sent = await page.request.post(`${solo.base}/api/attachments`, { headers: { "x-csrf-token": csrf, "x-attachment-name": "notes.txt", "content-type": "text/plain" }, data: NOTE });
    expect(sent.status(), "keeping the file for the person").toBe(201);
    const { attachment } = (await sent.json()) as { attachment: { id: string; name: string } };

    // when
    const { task } = await solo.call<{ task: { id: string } }>("POST", "/api/tasks", { title: "Expose the delivery-window endpoint", description: "", repoId: project.id, agent: "claude-code", attachments: [attachment.id] });
    const done = await until(() => solo.call<{ task: { status: string; error: string | null } }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status), 2400);

    // then
    expect([done.status, done.error]).toEqual(["needs-review", null]);
    const listed = await solo.call<{ attachments: { name: string; size: number }[] }>("GET", `/api/tasks/${task.id}/attachments`);
    expect(listed.attachments.map((a) => [a.name, a.size])).toEqual([["notes.txt", NOTE.length]]);
    expect(existsSync(join(repo, "notes.txt"))).toBe(false);
    await page.goto(`${solo.base}/`);
    await page.waitForURL(/\/(activity|tasks)$/);
    const org = new URL(page.url()).pathname.split("/")[1]!;
    await page.goto(`${solo.base}/${org}/tasks/${task.id}`);
    await expect(page.getByRole("heading", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("button", { name: "notes.txt" })).toBeVisible();
  } finally {
    await solo.stop();
  }
});
