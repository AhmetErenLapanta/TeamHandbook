import { expect, test } from "@playwright/test";
import { choose } from "./task-form.js";

// The orchestrator's four sections, Tasks narrowed to one repository by its one filter, and the old
// pages' addresses landing on their new places.

test("given the top bar, when the orchestrator opens, then it lands on Tasks and offers the four sections with Settings in the account menu", async ({ page }) => {
  // when
  await page.goto("/");

  // then
  await expect(page).toHaveURL(/\/demo\/tasks$/);
  const sections = page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link");
  await expect(sections).not.toContainText(["Activity"]);
  expect(await sections.allInnerTexts()).toEqual(expect.arrayContaining(["Tasks", "Team", "Integrations"]));
  for (const gone of ["Activity", "Projects", "Controls", "Settings"]) await expect(page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: gone, exact: true })).toHaveCount(0);

  // when
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "What's new" }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/activity\/news$/);
  await expect(page.getByRole("heading", { name: "Work, Tasks, Team and Integrations" })).toBeVisible();
});

test("given the addresses of the pages that left the top bar, when each is opened, then it lands where that page lives now", async ({ page }) => {
  // then
  for (const [from, to] of [["/demo/activity", /\/demo\/tasks$/], ["/demo/repositories", /\/demo\/tasks$/], ["/demo/repositories/requests", /\/demo\/tasks$/], ["/demo/controls", /\/demo\/team$/], ["/demo/controls/new", /\/demo\/team\/policies\/new$/]] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
  }
});

test("given tasks in several repositories, when one is picked in the list's filter, then the list asks for its part of the board and the head says which", async ({ page }) => {
  // given
  const asked: (string | null)[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/tasks/board") asked.push(url.searchParams.get("repo"));
  });
  await page.route((url) => url.pathname === "/api/tasks/board", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, byRepo: { "payments-skills": { yours: 2, agents: 1 }, "platform-skills": { yours: 0, agents: 1 } } } });
  });
  await page.goto("/demo/tasks");

  // when
  await choose(page.locator("main"), "Show tasks in", "payments-skills");

  // then
  await expect(page).toHaveURL(/\/demo\/tasks\?repo=payments-skills$/);
  await expect(page.getByRole("link", { name: "Repository settings" })).toHaveCount(0);
  await expect(page.locator(".day-sentence")).toHaveText(/^In payments-skills, /);
  await expect.poll(() => asked.at(-1)).toBe("payments-skills");

  // when
  await choose(page.locator("main"), "Show tasks in", "All repositories");

  // then
  await expect(page).toHaveURL(/\/demo\/tasks$/);
  // Tasks keeps asking for the board; one still being passed on when the test ends would fail in the next test of this worker.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
