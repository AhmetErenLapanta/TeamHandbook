import { expect, test } from "@playwright/test";

test("given a section whose data breaks its page, when it opens, then only that section shows the fault with the error to copy, and the tabs still lead elsewhere", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ json: { sections: null, counts: null } }));

  // when
  await page.goto("/demo/tasks");

  // then
  const fault = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Something went wrong on this page" }) });
  await expect(fault).toBeVisible();
  await expect(fault.locator("pre")).toContainText("at /demo/tasks");
  await expect(fault.getByRole("button", { name: "Copy error" })).toBeVisible();
  await expect(fault.getByRole("link", { name: "Back to Tasks" })).toHaveAttribute("href", "/demo/tasks");
  await expect(page.getByRole("navigation", { name: "Orchestrator" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();

  // when
  await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Integrations" }).click();

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Integrations");
  await expect(page.getByRole("heading", { name: "Something went wrong on this page" })).toHaveCount(0);
});


for (const path of ["/demo/billing", "/demo/activity/usge", "/#/billing"]) {
  test(`given the address ${path} the orchestrator has no page for, when it opens, then it says the page is not found and leads back to the organization`, async ({ page }) => {
    // when
    await page.goto(path);

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
    await expect(page.getByRole("region", { name: "Page not found" })).toContainText(path.startsWith("/#") ? "/demo/billing" : path);
    await page.getByRole("link", { name: "Back to demo" }).click();
    await expect(page).toHaveURL(/\/demo\/tasks$/);
  });
}

test("given only the organization in the address, when it opens, then it lands on Tasks rather than a missing page", async ({ page }) => {
  // when
  await page.goto("/demo");

  // then
  await expect(page).toHaveURL(/\/demo\/tasks$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
});

test("given skill use fails to load, when Usage opens, then it names what did not load and its Retry reads it again", async ({ page }) => {
  // given
  let fail = true;
  await page.route(/\/api\/activity\/usage\?/, (route) => (fail ? route.fulfill({ status: 500, json: { error: "The store did not answer." } }) : route.continue()));

  // when
  await page.goto("/demo/activity/usage");

  // then
  await expect(page.getByRole("alert")).toHaveText(/^Couldn't load skill use\. The store did not answer\./);

  // when
  fail = false;
  await page.getByRole("button", { name: "Retry skill use" }).click();

  // then
  await expect(page.getByRole("heading", { name: /^Skill use per day/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("given a task list that loaded and a refresh that fails, when the list refreshes, then the last rows stay and it says they are the last loaded, and Retry reads them again", async ({ page }) => {
  // given
  const card = { id: "0123456789ab", title: "Still running", repoId: "payments-skills", status: "running", phase: "working", next: null, createdBy: "ada@example.invalid", createdAt: "2026-10-25T10:00:00.000Z", finishedAt: null, waitingFor: null, changes: null, request: null, cost: { usd: null, inputTokens: null, outputTokens: null }, agent: "fake", startedAt: "2026-10-25T10:00:01.000Z", issueKey: null };
  let answered = 0;
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => {
    answered += 1;
    return answered === 1
      ? route.fulfill({ json: { sections: { yours: [], agents: [card], waiting: [], done: [] }, counts: { yours: 0, agents: 1, waiting: 0, done: 0 } } })
      : route.fulfill({ status: 500, json: { error: "The store did not answer." } });
  });

  // when
  await page.goto("/demo/tasks");

  // then
  await expect(page.getByRole("alert")).toHaveText(/^Refresh failed\. Showing the last loaded tasks\. The store did not answer\./, { timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Still running" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry tasks" })).toBeVisible();
});

test("given the task list never loads, when Tasks opens, then it says the tasks did not load rather than that none has run", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ status: 500, json: { error: "The store did not answer." } }));

  // when
  await page.goto("/demo/tasks");

  // then
  await expect(page.getByRole("alert")).toHaveText(/^Couldn't load tasks\. The store did not answer\./);
  await expect(page.getByText("Nothing waits on you.")).toHaveCount(0);
});

