import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { stateFor } from "./roles.js";
import { newTaskForm, work } from "./task-form.js";

// The task form says a code project's checks only while its Start would approve them, and Start
// approves exactly the list it shows before the task starts.

const check = { kind: "test", command: "npm test", runs: "node --test", source: "package.json", network: false, long: false, digest: "d-npm test" };
const setup = { command: "npm ci", runs: "npm ci (install scripts)", source: "package-lock.json", network: true, long: false, digest: "d-npm ci" };

async function oneCodeProject(page: Page, verification: Record<string, unknown>, repo: Record<string, unknown> = {}): Promise<{ steps: string[]; approved: () => unknown }> {
  const steps: string[] = [];
  let approved: unknown = null;
  await page.route("**/api/tasks/options", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, multiRepo: null, repos: [{ id: "shop", name: "shop", team: "Payments", kind: "code", ticketExample: null, ...repo }] } });
  });
  await page.route("**/api/projects/shop/verification", (route) => {
    const method = route.request().method();
    if (method === "PUT") approved = route.request().postDataJSON();
    if (method !== "GET") steps.push(method);
    return route.fulfill({ json: { configured: null, approved: null, detected: { setup, checks: [check] }, unread: null, changed: [], ...verification } });
  });
  await page.route("**/api/tasks", (route) => (route.request().method() === "POST" ? (steps.push("start"), route.fulfill({ status: 400, json: { error: "stopped by the test" } })) : route.fallback()));
  return { steps, approved: () => approved };
}

test("given a code project whose checks nobody approved, when a task is started from the form, then the install and check show with what they run and Start approves them before the task", async ({ page }) => {
  // given
  const sent = await oneCodeProject(page, {});
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  await expect(form.getByRole("list", { name: "Checks Start approves" }).getByRole("listitem")).toHaveText(["npm ci runs npm ci (install scripts) reaches the network", "npm test runs node --test"]);

  // when
  await work(form, "Round the cart total");
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  expect(sent.steps).toEqual(["PUT", "start"]);
  expect(sent.approved()).toEqual({ checks: [{ source: "package.json", command: "npm test", digest: "d-npm test" }], setup: { source: "package-lock.json", command: "npm ci", digest: "d-npm ci" } });
});

test("given a code project whose approved checks read unchanged files, when the form opens and starts, then it says nothing of checks and approves nothing again", async ({ page }) => {
  // given
  const sent = await oneCodeProject(page, { approved: { checks: [check], setup, by: "Ada", at: "2026-11-04T10:00:00Z" } });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Round the cart total");

  // when
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  await expect(form.getByRole("list", { name: "Checks Start approves" })).toHaveCount(0);
  expect(sent.steps).toEqual(["start"]);
});

test("given approved checks whose files changed since, when the form opens, then it says so and Start approves the list it shows again", async ({ page }) => {
  // given
  const sent = await oneCodeProject(page, { approved: { checks: [check], setup: null, by: "Ada", at: "2026-11-04T10:00:00Z" }, changed: ["package.json"] });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  await expect(form).toContainText("Its files changed since its checks were approved; Start approves these again:");

  // when
  await work(form, "Round the cart total");
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  expect(sent.steps).toEqual(["PUT", "start"]);
});

test.describe("as a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a code project with no approved checks, when a member opens the form and starts, then it says who approves them and sends no approval", async ({ page }) => {
    // given
    const sent = await oneCodeProject(page, {});
    await page.goto("/demo/tasks");
    const form = await newTaskForm(page);

    // then
    await expect(form).toContainText("An owner or an admin approves the checks this project's tasks run; until then a task here runs none.");
    await expect(form.getByRole("list", { name: "Checks Start approves" })).toHaveCount(0);

    // when
    await work(form, "Round the cart total");
    await form.getByRole("button", { name: "Start task" }).click();

    // then
    await expect(form.getByRole("alert")).toContainText("Stopped by the test");
    expect(sent.steps).toEqual(["start"]);
  });

  test("given a folder on the member's own machine with no approved checks, when they start a task there, then they approve its checks themselves", async ({ page }) => {
    // given
    const sent = await oneCodeProject(page, {}, { machine: "Max's laptop" });
    await page.goto("/demo/tasks");
    const form = await newTaskForm(page);

    // then
    await expect(form.getByRole("list", { name: "Checks Start approves" }).getByRole("listitem")).toHaveCount(2);

    // when
    await work(form, "Round the cart total");
    await form.getByRole("button", { name: "Start task" }).click();

    // then
    await expect(form.getByRole("alert")).toContainText("Stopped by the test");
    expect(sent.steps).toEqual(["PUT", "start"]);
  });
});
