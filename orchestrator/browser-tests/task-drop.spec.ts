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

test("given a task whose change was kept a turn at a time, when its starter picks a turn and confirms, then the question names the turns that go and the undo is sent once with the line why", async ({ page }) => {
  // given
  const sent: { n: string; body: { commandId?: string; reason?: string } }[] = [];
  const turns = [
    { n: 1, said: "Retry a failed capture", at: "2026-11-12T10:40:00Z", files: 2, undone: false },
    { n: 2, said: "Also return the window", at: "2026-11-12T10:44:00Z", files: 1, undone: false },
    { n: 3, said: "Rename the helper", at: "2026-11-12T10:50:00Z", files: 1, undone: false },
  ];
  await openRequestTask(page);
  await page.route("**/api/tasks/t1/turns", (route) => route.fulfill({ json: { turns } }));
  await page.route("**/api/tasks/t1/turns/2/changes", (route) => route.fulfill({ json: { changes: { files: [{ path: "src/window.ts", status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], omitted: 0 } } }));
  await page.route("**/api/tasks/t1/turns/2/undo", (route) => {
    sent.push({ n: "2", body: route.request().postDataJSON() as { commandId?: string; reason?: string } });
    return route.fulfill({ json: { turns: turns.map((t) => ({ ...t, undone: t.n >= 2 })) } });
  });
  await page.goto("/demo/tasks/t1");

  // when
  await page.getByRole("combobox", { name: "Show" }).click();
  await page.getByRole("option", { name: /Also return the window/ }).click();
  await expect(page.getByText("src/window.ts")).toBeVisible();
  await page.getByRole("button", { name: "Undo from this turn…" }).click();

  // then
  await expect(page.getByText("The files go back to how they were before “Also return the window”; the turn after it goes too, and the conversation stays.")).toBeVisible();

  // when
  await page.getByLabel("Why").fill("the helper was right as it was");
  await page.getByRole("button", { name: "Undo these turns" }).click();

  // then
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.body.reason).toBe("the helper was right as it was");
  expect(sent[0]?.body.commandId).toBeTruthy();
  await expect(page.getByRole("combobox", { name: "Show" })).toContainText("All changes");
});

test("given a task kept a turn at a time, when its starter starts a new task from a turn with a word on what to do differently, then the word is sent once and the page goes to the new task", async ({ page }) => {
  // given
  const sent: { text?: string; commandId?: string }[] = [];
  const turns = [
    { n: 1, said: "Retry a failed capture", at: "2026-11-12T10:40:00Z", files: 2, undone: false },
    { n: 2, said: "Also return the window", at: "2026-11-12T10:44:00Z", files: 1, undone: false, newTaskId: "t9" },
  ];
  await openRequestTask(page);
  await page.route("**/api/tasks/t1/turns", (route) => route.fulfill({ json: { turns } }));
  await page.route("**/api/tasks/t1/turns/2/changes", (route) => route.fulfill({ json: { changes: { files: [{ path: "src/window.ts", status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], omitted: 0 } } }));
  await page.route("**/api/tasks/t1/turns/2/new-task", (route) => {
    sent.push(route.request().postDataJSON() as { text?: string; commandId?: string });
    return route.fulfill({ status: 201, json: { task: { id: "t9", title: "Retry a failed capture", status: "queued" } } });
  });
  await page.goto("/demo/tasks/t1");
  await page.getByRole("combobox", { name: "Show" }).click();
  await page.getByRole("option", { name: /Also return the window/ }).click();

  // then
  await expect(page.getByRole("link", { name: "open it" })).toHaveAttribute("href", /\/tasks\/t9$/);

  // when
  await page.getByRole("button", { name: "Start a new task from here…" }).click();
  await expect(page.getByText("A new task starts from the files as this turn left them; this task and its branch stay as they are.")).toBeVisible();
  await page.getByLabel("What should it do differently?").fill("keep the old helper name");
  await page.getByRole("button", { name: "Start new task" }).click();

  // then
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.text).toBe("keep the old helper name");
  expect(sent[0]?.commandId).toBeTruthy();
  await expect(page).toHaveURL(/\/tasks\/t9$/);
});
