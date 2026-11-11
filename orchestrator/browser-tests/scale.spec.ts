import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { manyPeople, manyRequests, manySkills, manyTasks } from "./large-lists.js";
import { choose } from "./task-form.js";

// A company's orchestrator: thousands of requests, hundreds of people, a repository with
// thousands of skills. The lists are answered in the browser at that size, so each screen is
// held to drawing one page of them, and the page and filter it asks for are the ones shown.

const MAX_ROWS = 50;

const rows = (page: Page) => page.locator("main tbody tr");

test("given 5000 requests, when a repository's Requests opens and is paged and filtered, then it draws one page at a time and asks the orchestrator for just that page", async ({ page }) => {
  // given
  const asked = await manyRequests(page);

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  await expect(page.getByRole("heading", { name: /Requests from the orchestrator/ })).toContainText("5000");
  await expect(rows(page)).toHaveCount(MAX_ROWS);
  await expect(page.getByRole("navigation", { name: "Pages of requests" })).toContainText("Page 1 of 100");
  await expect(rows(page).first()).toContainText("change 5000");

  // when the next page is asked for
  await page.getByRole("button", { name: "Next" }).click();

  // then
  await expect(rows(page).first()).toContainText("change 4950");
  await expect(page.getByRole("navigation", { name: "Pages of requests" })).toContainText("Page 2 of 100");
  expect(asked.at(-1)!.searchParams.get("after")).toBe("4951");

  // when the page before is asked for again
  await page.getByRole("button", { name: "Previous" }).click();

  // then
  await expect(rows(page).first()).toContainText("change 5000");
  expect(asked.at(-1)!.searchParams.has("after")).toBe(false);

  // when only those awaiting review are shown
  await choose(page.locator("main"), "Show", "Awaiting review");

  // then
  await expect(page.getByRole("navigation", { name: "Pages of requests" })).toContainText("Page 1 of 10");
  await expect(rows(page)).toHaveCount(MAX_ROWS);
  await expect(rows(page).locator(".badge").filter({ hasNotText: "awaiting review" })).toHaveCount(0);
  expect(asked.at(-1)!.searchParams.get("status")).toBe("open");
  expect(asked.at(-1)!.searchParams.has("after")).toBe(false);
});

test("given the last page of those awaiting review holds one request, when it is merged, then the list steps back to the page that is now last", async ({ page }) => {
  // given
  await manyRequests(page, 51, () => "open");
  await page.goto("/demo/repositories/payments-skills/requests");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(rows(page)).toHaveCount(1);
  await choose(page.locator("main"), "Show", "Awaiting review");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(rows(page)).toHaveCount(1);

  // when
  await rows(page).getByRole("button", { name: "Merge" }).click();

  // then
  await expect(rows(page)).toHaveCount(MAX_ROWS);
  await expect(page.getByText("No request is awaiting review.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Requests from the orchestrator/ })).toContainText("51");
});

test("given a repository with 5000 requests, when it is opened, then its requests section draws one page and counts them all", async ({ page }) => {
  // given
  const asked = await manyRequests(page);

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  const section = page.getByRole("region", { name: /Requests from the orchestrator/ });
  await expect(section.getByRole("heading")).toContainText("5000");
  await expect(section.locator("tbody tr")).toHaveCount(MAX_ROWS);
  expect(asked.at(-1)!.searchParams.get("repo")).toBe("payments-skills");
});

test("given 300 people, when Members opens, then it draws one page, and finding a member narrows it to them", async ({ page }) => {
  // given
  const { users } = await (await page.request.get("/api/users")).json();
  await manyPeople(page);

  // when
  await page.goto("/demo/settings/members");

  // then
  // A page of people is cut by role into sections, so its rows are counted across them.
  const people = page.getByRole("region", { name: /^(Owners|Admins|Members|Viewers)/ }).locator("tbody tr");
  await expect(page.locator(".page-summary")).toContainText(`${users.length + 300} people in this organization`);
  await expect(people).toHaveCount(MAX_ROWS);
  await expect(page.getByRole("navigation", { name: "Pages of members" })).toContainText("Page 1 of 7");

  // when a member is looked for
  await page.getByLabel("Find a member").fill("person123@");

  // then
  await expect(people).toHaveCount(1);
  await expect(people).toContainText("Person 123");
  await expect(page.getByRole("navigation", { name: "Pages of members" })).toHaveCount(0);
});

test("given a repository with 2000 skills, when it is opened, then the skills table draws one page, and finding a skill narrows it", async ({ page }) => {
  // given
  await manySkills(page);

  // when
  await page.goto("/demo/repositories/payments-skills/skills");

  // then
  const skills = page.getByRole("region", { name: /^Skills/ });
  await expect(skills.getByRole("heading")).toContainText("2000");
  await expect(skills.locator("tbody tr")).toHaveCount(MAX_ROWS);
  await expect(page.getByRole("navigation", { name: "Pages of skills" })).toContainText("Page 1 of 40");

  // when a skill is looked for
  await page.getByLabel("Find a skill").fill("skill-1999");

  // then
  await expect(skills.locator("tbody tr")).toHaveCount(1);
  await expect(skills.getByRole("button", { name: "skill-1999" })).toBeVisible();
});

test("given a repository the orchestrator has not read yet, when it is opened, then it says so and fills in once the read lands, with no button pressed", async ({ page }) => {
  // given
  let reads = 0;
  await page.route("**/api/repos", async (route) => {
    const body = await (await route.fetch()).json();
    if (reads < 2) body.repos = body.repos.map((r: { id: string }) => (r.id === "payments-skills" ? { ...r, head: null, error: null } : r));
    await route.fulfill({ json: body });
  });
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    if (reads++ < 2) return route.fulfill({ status: 409, json: { error: "not synced yet" } });
    return route.fulfill({ response: await route.fetch() });
  });

  // when
  await page.goto("/demo/repositories/payments-skills/skills");

  // then
  await expect(page.getByRole("status")).toHaveText("The orchestrator is reading payments-skills for the first time; this page fills in once it has.");
  await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("not synced yet")).toHaveCount(0);
});

test("given 120 tasks, when Tasks opens and older tasks are asked for, then it draws one page at first and adds a page each time until none are left", async ({ page }) => {
  // given
  const asked = await manyTasks(page);
  // Every task the person reads is in the All tasks fold at the page's foot, read only once it is opened.
  const all = page.locator("details.log-fold").filter({ has: page.locator("summary", { hasText: /^All tasks/ }) });
  const taskRows = all.locator("tbody tr");

  // when
  await page.goto("/demo/tasks");
  await all.locator("summary").click();

  // then
  await expect(taskRows).toHaveCount(MAX_ROWS);
  await expect(all.locator("summary")).toContainText("50+");
  await expect(taskRows.first()).toContainText("Task 120");

  // when older tasks are asked for twice
  await page.getByRole("button", { name: "Show older tasks" }).click();
  await expect(taskRows).toHaveCount(2 * MAX_ROWS);
  await page.getByRole("button", { name: "Show older tasks" }).click();

  // then
  await expect(taskRows).toHaveCount(120);
  await expect(taskRows.last()).toContainText("Task 1");
  await expect(all.locator("summary")).toContainText("120");
  await expect(page.getByRole("button", { name: "Show older tasks" })).toHaveCount(0);
  expect(asked.map((u) => u.searchParams.get("after"))).toEqual([null, "00000071", "00000021"]);
});
