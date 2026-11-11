import { expect, test } from "@playwright/test";
import { stateFor } from "./roles.js";
import { taskLog } from "./task-page.js";

/** A task the admin starts on Payments with the stand-in agent, and its id. */
async function paymentsTask(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const { csrf } = await (await request.get("/api/me")).json();
  const res = await request.post("/api/tasks", { data: { title: "Payments only", description: "Kept to the Payments team.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });
  expect(res.ok()).toBe(true);
  return (await res.json()).task.id;
}

test("given a Payments task, when the Platform owner opens Tasks and the task's address, then it is not listed and the page says no such task, while the Payments owner reads its log", async ({ browser, page }) => {
  // given
  const id = await paymentsTask(page.request);
  const platform = await browser.newContext({ storageState: stateFor("platformOwner") });
  const payments = await browser.newContext({ storageState: stateFor("paymentsOwner") });

  try {
    // when
    const theirs = await platform.newPage();
    await theirs.goto("/demo/tasks");

    // then
    await expect(theirs.getByRole("region", { name: /^All tasks/ }).getByRole("link", { name: "Payments only" })).toHaveCount(0);
    expect((await theirs.request.get(`/api/tasks/${id}?after=0`)).status()).toBe(404);

    // when
    await theirs.goto(`/demo/tasks/${id}`);

    // then
    await expect(theirs.getByRole("alert")).toContainText("Unknown task.");
    await expect(theirs.getByRole("heading", { name: "Payments only" })).toHaveCount(0);

    // when
    const ours = await payments.newPage();
    await ours.goto(`/demo/tasks/${id}`);

    // then
    await expect(ours.getByRole("heading", { level: 1 })).toHaveText("Payments only");
    await expect(await taskLog(ours)).not.toBeEmpty({ timeout: 30_000 });
  } finally {
    await platform.close();
    await payments.close();
  }
});

test.describe("as a member who started no task", () => {
  test.use({ storageState: stateFor("member") });

  test("given tasks other people started, when the member opens Activity and Logs, then neither shows those tasks", async ({ page, browser }) => {
    // given
    const admin = await browser.newContext({ storageState: stateFor("admin") });
    await paymentsTask(admin.request);
    await admin.close();

    // when
    await page.goto("/demo/activity/logs");

    // then
    await expect(page.getByRole("heading", { name: /^Tasks, last/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /Payments only/ }).filter({ has: page.getByRole("cell", { name: "task", exact: true }) })).toHaveCount(0);

    // when
    await page.goto("/demo/activity");

    // then
    await expect(page.getByRole("region", { name: "What changed" }).getByRole("link", { name: "Payments only" })).toHaveCount(0);
  });
});
