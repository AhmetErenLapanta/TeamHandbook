import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { monthOfUse, oneEvent, someEvents } from "./activity-data.js";
import { stateFor } from "./roles.js";
import { choose } from "./task-form.js";

/** How light the page's own ground is, 0 to 1, from its colour as the browser resolved it (OKLCH or sRGB). */
async function pageLightness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    paint.fillStyle = getComputedStyle(document.body).backgroundColor;
    paint.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = paint.getImageData(0, 0, 1, 1).data;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });
}

test.describe("the top sections", () => {
  test("given no path, when the orchestrator opens, then it lands on Tasks in its organization with that tab current", async ({ page }) => {
    // when
    await page.goto("/");

    // then
    await expect(page).toHaveURL(/\/demo\/tasks$/);
    await expect(page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Tasks" })).toHaveAttribute("aria-current", "page");
  });

  test("given an address from before the top sections, when it is opened, then the same page opens at its new address", async ({ page }) => {
    // when
    await page.goto("/#/repo/platform-skills");

    // then
    await expect(page).toHaveURL(/\/demo\/repositories\/platform-skills$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("platform-skills");
  });

  test("given the orchestrator open, when the tabs are followed and the browser goes back, then each page opens without reloading the orchestrator", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await page.evaluate(() => ((window as unknown as { kept: boolean }).kept = true));
    const tabs = page.getByRole("navigation", { name: "Orchestrator" });

    // when
    await tabs.getByRole("link", { name: "Team" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team");
    await tabs.getByRole("link", { name: "Tasks" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
    await page.goBack();

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team");
    await expect(page).toHaveURL(/\/demo\/team$/);
    expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  });

  test("given an organization this person is not in, when its page is opened, then it says so and links to their own", async ({ page }) => {
    // when
    await page.goto("/elsewhere/tasks");

    // then
    await expect(page.getByText("You are not a member of elsewhere.")).toBeVisible();
    await page.getByRole("link", { name: "Go to demo" }).click();
    await expect(page).toHaveURL(/\/demo\/tasks$/);

    // when only the organization is named
    await page.goto("/elsewhere");

    // then
    await expect(page.getByText("You are not a member of elsewhere.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to demo" })).toHaveAttribute("href", "/demo/tasks");
  });

  test("given a repository whose contents answer slowly, when another is opened meanwhile, then the late answer does not replace the one on screen", async ({ page }) => {
    // given
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/repos/payments-skills/inventory", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/demo/repositories/payments-skills");

    // when an old link to the other repository is followed inside the page, which the orchestrator opens without reloading
    await page.evaluate(() => (window.location.hash = "#/repo/platform-skills"));
    await expect(page).toHaveURL(/\/demo\/repositories\/platform-skills$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("platform-skills");
    const late = page.waitForResponse("**/api/repos/payments-skills/inventory");
    release();
    await late;

    // then
    await page.waitForTimeout(300);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("platform-skills");
  });

  test("given the search, when a repository's name is typed in it and Enter pressed, then Tasks opens narrowed to it", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");

    // when
    await page.getByRole("button", { name: /^Search/ }).click();
    await page.getByRole("searchbox", { name: "Search pages, projects and tasks" }).fill("platform");
    await expect(page.getByRole("option", { name: /platform-skills/ })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search pages, projects and tasks" }).press("Enter");

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\?repo=platform-skills$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
  });

  test("given the account menu, when dark is picked and the page reloads, then it stays dark until the system's choice is picked again", async ({ page }) => {
    // given
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/demo/tasks");
    const menu = page.getByRole("button", { name: "Account: Ada Admin" });

    // when
    await menu.click();
    await page.getByRole("radio", { name: "Dark" }).check();
    await page.reload();

    // then
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await pageLightness(page)).toBeLessThan(0.4);

    // when
    await menu.click();
    await page.getByRole("radio", { name: "Match the system" }).check();

    // then
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
    expect(await pageLightness(page)).toBeGreaterThan(0.9);
  });
});

// Activity's overview left the top bar: its getting-started guide became Team's Getting set up and
// What's new a page of its own (sections.spec). The rule behind the guide's steps still holds for the
// organization's welcome, which marks and skips them.
test.describe("the organization's setup steps", () => {
  test("given an admin and a member, when each changes the setup steps, then the member is refused, the admin's change is the organization's and in its audit log, and the account menu shows a hidden list again", async ({ page, browser }) => {
    // given
    await page.goto("/demo/tasks");
    const { csrf } = await (await page.request.get("/api/me")).json();
    await page.request.put("/api/activity/onboarding", { data: { marked: [] }, headers: { "x-csrf-token": csrf } });
    const member = await browser.newContext({ storageState: stateFor("member") });

    try {
      // when
      const { csrf: memberCsrf } = await (await member.request.get("/api/me")).json();
      const refused = await member.request.put("/api/activity/onboarding", { data: { dismissed: true }, headers: { "x-csrf-token": memberCsrf } });

      // then
      expect(refused.status()).toBe(403);
      expect((await refused.json()).error).toBe("only an owner or an admin signed in to the orchestrator changes the getting-started guide");

      // when
      const marked = await page.request.put("/api/activity/onboarding", { data: { marked: ["join"] }, headers: { "x-csrf-token": csrf } });

      // then
      expect(marked.ok()).toBe(true);
      expect((await (await member.request.get("/api/activity/onboarding")).json()).marked).toEqual(["join"]);
      const { events } = await (await page.request.get("/api/events?kind=onboarding")).json();
      expect(events[0].detail).toBe("marked join done");

      // when the guide was hidden and the account menu brings it back
      await page.request.put("/api/activity/onboarding", { data: { dismissed: true }, headers: { "x-csrf-token": csrf } });
      await page.reload();
      await page.getByRole("button", { name: "Account: Ada Admin" }).click();
      await page.getByRole("button", { name: "Show the getting started guide" }).click();

      // then the steps are shown again for the whole organization, Team's Getting set up among them
      await expect.poll(async () => (await (await member.request.get("/api/activity/onboarding")).json()).dismissed).toBe(false);
    } finally {
      await page.request.put("/api/activity/onboarding", { data: { dismissed: false, marked: [] }, headers: { "x-csrf-token": csrf } });
      await member.close();
    }
  });
});

test.describe("usage", () => {
  test("given a month of use, when the usage page opens and the range changes, then the chart, both breakdowns and the exports follow the range", async ({ page }) => {
    // given
    const report = await monthOfUse(page);
    const asked: string[] = [];
    page.on("request", (r) => r.url().includes("/api/activity/usage?") && asked.push(new URL(r.url()).searchParams.get("days")!));

    // when
    await page.goto("/demo/activity/usage");

    // then
    await expect(page.getByRole("img", { name: /Skill use per day, 30 days/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Skill use per day/ })).toContainText(`${report.total} in 30 days`);
    await expect(page.getByRole("region", { name: "By team" }).getByRole("row", { name: /Platform/ })).toContainText("40");
    await expect(page.getByRole("region", { name: /^By skill/ })).toContainText("rotate-service-certificate");
    await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/activity/usage/export?days=30&format=csv");

    // when
    await page.getByRole("button", { name: "90 days" }).click();

    // then
    await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/activity/usage/export?days=90&format=csv");
    expect(asked).toEqual(["30", "90"]);
  });

  test("given the orchestrator's own counts, when the export is fetched, then it is a CSV with a header and a range outside the offered ones is refused", async ({ page }) => {
    // when
    const csv = await page.request.get("/api/activity/usage/export?days=30&format=csv");
    const odd = await page.request.get("/api/activity/usage?days=12");

    // then
    expect(csv.headers()["content-type"]).toContain("text/csv");
    expect(csv.headers()["content-disposition"]).toMatch(/^attachment; filename="skill-use-30d-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect((await csv.text()).split("\r\n")[0]).toBe("day,team,repository,skill,count");
    expect(odd.status()).toBe(400);
  });
});

test.describe("logs and audit", () => {
  test("given a task that opened its request, when Logs opens, then the task is one row in its state, with no row for its request, and a state filter narrows the list", async ({ page }) => {
    // given
    const { csrf } = await (await page.request.get("/api/me")).json();
    const started = await page.request.post("/api/tasks", { data: { title: "Log this task", description: "For the log.", repoId: "platform-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });
    expect(started.ok()).toBe(true);
    const { task } = await started.json();
    await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}?after=0`)).json()).task.status, { timeout: 30_000 }).toBe("needs-review");
    await page.goto("/demo/activity/logs");
    const log = page.getByRole("region", { name: /^Tasks, last/ });
    const mine = log.getByRole("row").filter({ hasText: "Log this task" });

    // then it is one row a task, in the state's word, with no row for its request
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText("needs you");
    await expect(log.getByRole("columnheader", { name: "Kind" })).toHaveCount(0);

    // when the list is narrowed by state
    await choose(page.locator("main"), "State", "failed");

    // then
    await expect(mine).toHaveCount(0);
  });

  test("given an orchestrator that does not record events yet, when Audit opens, then it says recording has not started", async ({ page }) => {
    // given
    await page.route(/\/api\/events(\?|$)/, (route) => route.fulfill({ status: 404, json: { error: "not found" } }));

    // when
    await page.goto("/demo/activity/audit");

    // then
    await expect(page.getByText("Audit recording has not started.")).toBeVisible();
  });

  test("given recorded events, when Audit opens and is filtered, then the orchestrator's own change reads as System with the rest counted, and the filter reaches the read and the export", async ({ page }) => {
    // given
    await someEvents(page);
    const asked: string[] = [];
    page.on("request", (r) => r.url().includes("/api/events?") && asked.push(new URL(r.url()).search));

    // when
    await page.goto("/demo/activity/audit");

    // then
    const row = page.getByRole("row", { name: /repo\.synced/ });
    await expect(row).toContainText("head: 1111111 → 2222222 +1");
    await expect(row).toContainText("System");
    await expect(page.getByRole("heading", { name: /^Changes/ })).toContainText("kept 365 days");

    // when
    await page.getByLabel("Action").fill("request");
    await page.getByRole("button", { name: "Filter" }).click();

    // then
    await expect.poll(() => asked.at(-1)).toBe("?kind=request");
    await expect(page.getByRole("link", { name: "Export CSV" })).toHaveAttribute("href", "/api/events/export?kind=request&format=csv");
  });
});

test.describe("one audit entry", () => {
  test("given recorded events, when a change is opened from the audit list, then its page shows every field changed, who changed it, and a link to share it", async ({ page }) => {
    // given
    const record = await oneEvent(page);
    await page.goto("/demo/activity/audit");

    // when
    await page.getByRole("row", { name: /repo\.synced/ }).getByRole("link").click();

    // then
    await expect(page).toHaveURL(/\/demo\/activity\/audit\/e1$/);
    await expect(page.getByRole("heading", { name: "repo.synced" })).toBeVisible();
    await expect(page.getByText("The orchestrator itself")).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: "System" })).toBeVisible();
    const fields = page.getByRole("region", { name: /^Fields changed/ });
    await expect(fields.getByRole("row", { name: /head/ })).toContainText("1111111");
    await expect(fields.getByRole("row", { name: /head/ })).toContainText("2222222");
    await expect(fields.getByRole("row")).toHaveCount(3);
    await expect(page.getByRole("region", { name: "Link to this change" })).toContainText(record.link);

    // when
    await page.getByRole("link", { name: "All changes" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/activity\/audit$/);
  });

  test("given an id the organization's log does not hold, when its page opens, then it says so and leads back to the list", async ({ page }) => {
    // given
    await oneEvent(page);

    // when
    await page.goto("/demo/activity/audit/e999");

    // then
    await expect(page.getByRole("alert")).toContainText("This organization's audit log has no such change");
    await expect(page.getByRole("link", { name: "All changes" })).toHaveAttribute("href", "/demo/activity/audit");
  });
});

test.describe("as a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when Leaderboard, Audit and Usage open, then the ranking, the log and the export stay with admins and owners", async ({ page }) => {
    // when
    await page.goto("/demo/activity/leaderboard");

    // then
    await expect(page.getByText(/^The leaderboard is shown to owners and admins/)).toBeVisible();
    expect((await page.request.get("/api/activity/leaderboard?days=30")).status()).toBe(403);

    // when
    await page.goto("/demo/activity/audit");

    // then
    await expect(page.getByText("Owners and admins read the audit log.")).toBeVisible();
    await page.goto("/demo/activity/audit/e1");
    await expect(page.getByText("Owners and admins read the audit log.")).toBeVisible();

    // when
    await page.goto("/demo/activity/usage");

    // then
    await expect(page.getByRole("heading", { name: /^Skill use per day/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Export CSV" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "By team" })).toHaveCount(0);
    expect((await page.request.get("/api/activity/usage/export?days=30&format=csv")).status()).toBe(403);
    expect((await page.request.get("/api/activity/usage?days=30")).ok()).toBe(true);
  });

  test("given a member, when the account menu's pages and the search are used, then neither offers the pages that only refuse them", async ({ page }) => {
    // when
    await page.goto("/demo/activity/usage");

    // then
    const nav = page.getByRole("navigation", { name: "Activity" });
    await expect(nav.getByRole("link")).toHaveText(["Usage", "AI requests", "Logs", "What's new"]);

    // when
    await page.getByRole("button", { name: /^Search/ }).click();
    const search = page.getByRole("searchbox", { name: "Search pages, projects and tasks" });
    await search.fill("audit");

    // then
    await expect(page.getByRole("status").filter({ hasText: "Nothing found" })).toBeAttached();

    // when
    await search.fill("organization");

    // then
    await expect(page.getByRole("status").filter({ hasText: "Nothing found" })).toBeAttached();
  });
});

test.describe("as a team's owner", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a member who owns a team, when the account menu's pages open, then the leaderboard of their team is offered and the audit log is not", async ({ page }) => {
    // when
    await page.goto("/demo/activity/usage");

    // then
    const nav = page.getByRole("navigation", { name: "Activity" });
    await expect(nav.getByRole("link")).toHaveText(["Usage", "Leaderboard", "AI requests", "Logs", "What's new"]);
  });
});
