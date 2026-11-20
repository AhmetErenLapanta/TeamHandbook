import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { newTaskForm } from "./task-form.js";

// The task, end to end with the keyboard alone: open the form, start it, tell the agent something while it works, stop it,
// and keep what it changed. Each control is reached by pressing Tab and used with Enter, never with the pointer, and shows
// a ring as it is reached. The orchestrator's answers are stand-ins: no agent runs.

const MOST_TABS = 150;

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < MOST_TABS; i++) {
    if (await target.first().evaluate((el) => el === document.activeElement, undefined, { timeout: 2000 }).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Pressing Tab never reached the control");
}

async function ringShows(target: Locator): Promise<boolean> {
  return target.first().evaluate((el) => {
    const s = getComputedStyle(el);
    return el.matches(":focus-visible") && ((s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== "none");
  });
}

const task = (over: Record<string, unknown> = {}) => ({ id: "t1", title: "Retry a failed capture", status: "running", phase: "working", repoId: "shop", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null, ...over });

test("given the task form, when it is filled and started with the keyboard alone, then the start carries what was typed and each control showed a ring", async ({ page }) => {
  // given
  let started: Record<string, unknown> | null = null;
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  const field = form.getByLabel("What needs doing?");
  const start = form.getByRole("button", { name: "Start task" });

  // when
  await tabTo(page, field);
  expect(await ringShows(field)).toBe(true);
  await page.keyboard.type("Make the retry notes shorter");
  await tabTo(page, start);
  expect(await ringShows(start)).toBe(true);
  await page.keyboard.press("Enter");

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  expect(JSON.stringify(started)).toContain("Make the retry notes shorter");
});

test("given a running task, when the person tells the agent something and then stops it with the keyboard alone, then the words are sent, Stop asks first with the safe answer focused, and the stop goes out", async ({ page }) => {
  // given
  let said: Record<string, unknown> | null = null;
  let stopped = false;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ repoId: "payments-skills", followUp: "steer", startedAt: new Date().toISOString(), status: stopped ? "cancelled" : "running" }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/messages", (route) => {
    said = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 202, json: { followUp: "steer" } });
  });
  await page.route("**/api/tasks/t1/cancel", (route) => {
    stopped = true;
    return route.fulfill({ json: { task: task({ repoId: "payments-skills", status: "cancelled" }) } });
  });
  await page.goto("/demo/tasks/t1");
  const steer = page.getByRole("form", { name: "Tell the agent while it works" });
  const box = steer.getByRole("textbox", { name: "Tell the agent something while it works" });

  // when
  await tabTo(page, box);
  expect(await ringShows(box)).toBe(true);
  await page.keyboard.type("Use our logger.");
  await page.keyboard.press("Enter");

  // then
  await expect.poll(() => said).toMatchObject({ text: "Use our logger." });

  // when
  const stop = page.getByRole("button", { name: "Stop…", exact: true });
  await tabTo(page, stop);
  expect(await ringShows(stop)).toBe(true);
  await page.keyboard.press("Enter");

  // then
  const question = page.getByRole("group", { name: "Stop task" });
  await expect(question.getByRole("button", { name: /^Keep it/ })).toBeFocused();

  // when
  const confirm = question.getByRole("button", { name: "Stop task", exact: true });
  await tabTo(page, confirm);
  await page.keyboard.press("Enter");

  // then
  await expect.poll(() => stopped).toBe(true);
});

test("given a task ready for review, when its changes are kept with the keyboard alone, then the keep goes out", async ({ page }) => {
  // given
  let kept = false;
  const file = { path: "src/cart.ts", status: "modified", previousPath: null, additions: 3, deletions: 1, binary: false, test: false };
  const changed = () => task({ status: "needs-review", phase: "review", result: "changes", repoId: "shop", changes: { files: [file], undone: null, kept: kept ? "now" : null } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: changed(), log: [], outputCut: false } }));
  await page.route((url) => url.pathname === "/api/tasks/t1/changes", (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [file] } } }));
  await page.route((url) => url.pathname.startsWith("/api/tasks/t1/changes/"), (route) => route.fulfill({ json: { file: { ...file, patch: "@@ -1 +1 @@\n-old\n+new", truncated: false, note: null } } }));
  await page.route("**/api/tasks/t1/keep", (route) => {
    kept = true;
    return route.fulfill({ json: { task: changed() } });
  });
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [{ id: "shop", name: "shop", facts: { git: "none", origin: null, name: "shop", kind: "code" } }], last: "shop" } }));
  await page.goto("/demo/tasks/t1");
  const keep = page.getByRole("button", { name: "Keep these changes" }).first();

  // when
  await tabTo(page, keep);
  expect(await ringShows(keep)).toBe(true);
  await page.keyboard.press("Enter");

  // then
  await expect.poll(() => kept).toBe(true);
});
