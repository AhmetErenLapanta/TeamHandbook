import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { monthOfUse, oneEvent } from "./activity-data.js";
import { overflows, THEMES, WIDTHS } from "./layout.js";
import { GUESSED_MOVES, sprintItems, standInStart, standInWork } from "./work-fixtures.js";

// Screenshots of every page, when a run is asked for them, for a person to look over.
const SHOTS = process.env.ORCHESTRATOR_LAYOUT_SHOTS;

interface Screen { name: string; open: (page: Page) => Promise<void> }

async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/^Loading|^Working out|^Reading the forge|^Reading what reaches/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
}

/** Each card on the Integrations page opened in turn, the personal servers card with it. */
async function integrationCards(page: Page): Promise<string[]> {
  await page.goto("/demo/integrations");
  const headings = page.getByRole("region", { name: "Integrations" }).getByRole("heading", { level: 2 });
  await expect(headings.first()).toBeVisible();
  return headings.allInnerTexts();
}

const SCREENS: Screen[] = [
  { name: "activity", open: (p) => p.goto("/demo/activity").then(() => undefined) },
  { name: "usage", open: async (p) => { await monthOfUse(p); await p.goto("/demo/activity/usage"); } },
  { name: "leaderboard", open: (p) => p.goto("/demo/activity/leaderboard").then(() => undefined) },
  { name: "ai-requests", open: (p) => p.goto("/demo/activity/ai").then(() => undefined) },
  { name: "logs", open: (p) => p.goto("/demo/activity/logs").then(() => undefined) },
  { name: "audit", open: (p) => p.goto("/demo/activity/audit").then(() => undefined) },
  { name: "audit-entry", open: async (p) => { await oneEvent(p); await p.goto("/demo/activity/audit/e1"); } },
  { name: "tasks of one repository", open: (p) => p.goto("/demo/tasks?repo=payments-skills").then(() => undefined) },
  { name: "requests", open: (p) => p.goto("/demo/repositories/requests").then(() => undefined) },
  { name: "repository", open: (p) => p.goto("/demo/repositories/payments-skills").then(() => undefined) },
  ...(["skills", "mcp", "commands", "requests", "settings"] as const).map((tab) => ({ name: `repository-${tab}`, open: (p: Page) => p.goto(`/demo/repositories/payments-skills/${tab}`).then(() => undefined) })),
  { name: "tasks", open: (p) => p.goto("/demo/tasks").then(() => undefined) },
  { name: "task", open: async (p) => {
    const { csrf } = await (await p.request.get("/api/me")).json();
    const { task } = await (await p.request.post("/api/tasks", { data: { title: "A task with a rather long title that goes on to see how the header wraps on a phone", description: "Layout.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json();
    await p.goto(`/demo/tasks/${task.id}`);
    await expect(p.locator("[data-status]").first()).toHaveText(/needs you|failed/, { timeout: 60_000 });
  } },
  { name: "team", open: (p) => p.goto("/demo/team").then(() => undefined) },
  { name: "policy-editor", open: (p) => p.goto("/demo/team/policies/new").then(() => undefined) },
  { name: "integrations", open: (p) => p.goto("/demo/integrations").then(() => undefined) },
  ...["members", "service-accounts", "api-keys", "task-secrets", "security", "privacy", "organization", "account"].map((s) => ({ name: `settings-${s}`, open: (p: Page) => p.goto(`/demo/settings/${s}`).then(() => undefined) })),
  // Last: the stand-in tracker it needs stays answering for the rest of the page's life.
  { name: "work", open: async (p) => { await standInWork(p, { moves: GUESSED_MOVES, backlog: sprintItems }); await p.goto("/demo/work"); } },
  { name: "work-backlog", open: async (p) => {
    await standInStart(p);
    await p.goto("/demo/work/backlog");
    await p.getByRole("checkbox", { name: "Pick PAY-101" }).check();
    await p.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
  } },
];

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`at ${width} pixels in the ${theme} theme`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 900 } });

      test(`given every page, when it is drawn ${width} pixels wide, then nothing sticks out of its box, scrolls sideways inside a card, or is cut short`, async ({ page }) => {
        test.setTimeout(300_000);
        const found: string[] = [];
        const check = async (screen: string) => {
          await settled(page);
          for (const o of await overflows(page)) found.push(`${screen}: ${o.where} ${o.why}`);
          if (SHOTS && theme === "light") {
            mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: `${SHOTS}/${width}-${screen}.png`, fullPage: true });
          }
        };
        for (const screen of SCREENS) {
          await screen.open(page);
          await check(screen.name);
        }
        // Each Integrations card opened in turn, as a person opens one to set it up.
        const cards = await integrationCards(page);
        for (const card of cards) {
          await page.goto("/demo/integrations");
          await expect(page.getByRole("heading", { name: card, exact: true })).toBeVisible();
          const opener = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: card, exact: true }) }).getByRole("button", { name: /^(Set up|Manage)$/ });
          if (!(await opener.count())) continue;
          await opener.click();
          await check(`integrations-${card.toLowerCase().replaceAll(" ", "-")}`);
        }
        expect(found).toEqual([]);
      });
    });
  }
}

test.describe("the top tabs on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("given every section offered, when the orchestrator is drawn 390 pixels wide and its section menu opened, then each section is in the menu and sits inside the screen", async ({ page }) => {
    // given
    await standInWork(page);
    await page.goto("/demo/tasks");
    await expect(page.getByRole("navigation", { name: "Orchestrator" })).toBeHidden();

    // when
    await page.getByRole("button", { name: "Sections: Tasks" }).click();

    // then
    const sections = page.locator(".section-menu .popover").getByRole("link");
    await expect(sections).toHaveText(["Work", "Tasks", "Team", "Integrations"]);
    for (const box of await sections.evaluateAll((links) => links.map((a) => a.getBoundingClientRect().right))) expect(box).toBeLessThanOrEqual(390);
  });
  test("given the cloud and an organization with a long name, when the top bar is drawn 390 pixels wide, then the picker shows its initial and nothing in the bar sticks out", async ({ page }) => {
    // given
    await page.route("**/api/orgs", (route) => route.fulfill({ json: { default: null, orgs: [{ tenant: "demo", orgName: "Demo Payments and Platform Engineering", name: "Ada Admin", role: "admin" }] } }));
    await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud" } } });
    });

    // when
    await page.goto("/demo/activity");
    await expect(page.getByRole("button", { name: "Organization: Demo Payments and Platform Engineering" })).toBeVisible();

    // then
    expect((await overflows(page)).filter((o) => o.where.startsWith("header") || o.where.includes("topbar"))).toEqual([]);
  });
});
