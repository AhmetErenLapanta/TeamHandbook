import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { standInChanges } from "./request-changes";
import { stateFor } from "./roles.js";

// A file the agent changed is taken out of the task's open request from its row, asked first: it
// goes back as the task's base had it, and the changes are read again.

const task = (over: Record<string, unknown> = {}) => ({ id: "t1", title: "Retry a failed capture", status: "needs-review", phase: "review", repoId: "payments-skills", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: new Date().toISOString(), baseSha: null, tests: null, cost: { usd: null }, requestNumber: 7, error: null, template: null, queuePosition: null, request: { status: "open", provider: "local", branch: "task/t1", url: "local://requests/payments-skills/7" }, ...over });

async function openRequestTask(page: Page, over: Record<string, unknown> = {}): Promise<{ dropped: string[] }> {
  const dropped: string[] = [];
  await page.addInitScript(() => delete (window as unknown as { EventSource?: unknown }).EventSource);
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task(over), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/request/drop", (route) => {
    dropped.push((route.request().postDataJSON() as { path: string }).path);
    return route.fulfill({ json: { head: "c3" } });
  });
  await standInChanges(page, "payments-skills", 7, [
    { path: "src/capture.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@\n-a\n+b\n+c" },
    { path: "notes/scratch.md", status: "added", additions: 3, deletions: 0, patch: "@@ -0,0 +1,3 @@\n+x\n+y\n+z" },
  ]);
  return { dropped };
}

test("given a finished task with an open request, when its starter takes a file out and confirms, then only that file is sent and nothing is sent when they keep it", async ({ page }) => {
  // given
  const sent = await openRequestTask(page);
  await page.goto("/demo/tasks/t1");
  const take = page.getByRole("button", { name: "Take notes/scratch.md out of the request" });

  // when kept
  await take.click();
  await expect(page.getByText("The file is deleted from the request's branch in one commit, and the request is checked again.")).toBeVisible();
  await page.getByRole("button", { name: "Keep it in" }).click();

  // then
  expect(sent.dropped).toEqual([]);

  // when taken out
  await take.click();
  await page.getByRole("button", { name: "Take it out" }).click();

  // then
  await expect.poll(() => sent.dropped).toEqual(["notes/scratch.md"]);
});

test("given a task whose agent is at work again on its request, when its changes show, then no file is offered to be taken out", async ({ page }) => {
  // given
  await openRequestTask(page, { status: "running", phase: "working", startedAt: new Date().toISOString(), finishedAt: null });

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator(".diff-files > li").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /out of the request/ })).toHaveCount(0);
});

test.describe("as a member who did not start the task", () => {
  test.use({ storageState: stateFor("member") });

  test("given a teammate's finished task with an open request, when the member reads its changes, then no file is offered to be taken out", async ({ page }) => {
    // given
    await openRequestTask(page, { createdBy: "pat@example.invalid" });

    // when
    await page.goto("/demo/tasks/t1");

    // then
    await expect(page.locator(".diff-files > li").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /out of the request/ })).toHaveCount(0);
  });
});

test("given one person's own task, when they discard one file's change, then the file row and its question speak of the task's branch and never of a request, and only that file is sent", async ({ page }) => {
  // given
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  const sent = await openRequestTask(page);
  await page.route("**/api/repos/payments-skills/requests/7/on-forge", (route) => route.fulfill({ json: { forge: null, url: null, number: null } }));
  await page.goto("/demo/tasks/t1");

  // when
  await page.getByRole("button", { name: "Discard the change to notes/scratch.md" }).click();
  const question = page.getByRole("group", { name: "Discard its change" });

  // then
  await expect(question).toContainText("notes/scratch.md is dropped from the task's branch; the other files stay as they are.");
  await expect(page.getByRole("main")).not.toContainText("out of the request");

  // when
  await question.getByRole("button", { name: "Discard its change" }).click();

  // then
  await expect.poll(() => sent.dropped).toEqual(["notes/scratch.md"]);
});
