import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { CATALOG_SIZE } from "./handbook-scale-home.js";
import { handbooksOf, signIn, startTask } from "./handbook-helpers.js";

const WAITING = new Set<string>(["G4", "G6", "G7", "G8", "G9", "G10"]);
const step = (id: string, title: string, body: (args: { page: Page }) => Promise<void>) => {
  const run = process.env.ORCHESTRATOR_E2E_HANDBOOK_ALL || !WAITING.has(id) ? test : test.fixme;
  run(`${id}: ${title}`, async ({ page }) => {
    test.setTimeout(45_000);
    await body({ page });
  });
};

const box = async (locator: Locator) => (await locator.boundingBox())!;
const pageHeight = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);
const openTeam = async (page: Page) => {
  await page.goto("/default/team");
  await expect(handbooksOf(page).getByRole("heading", { name: /^Your handbooks/ })).toBeVisible();
};
const openAddPlugin = async (page: Page): Promise<Locator> => {
  await openTeam(page);
  await handbooksOf(page).getByRole("button", { name: /Add a skill, a command/ }).click();
  await handbooksOf(page).getByRole("button", { name: "Add a plugin" }).click();
  const group = page.getByRole("group", { name: "Add a plugin" });
  await expect(group).toBeVisible();
  return group;
};
const handbookNamed = (page: Page, name: string): Locator => handbooksOf(page).locator("li.handbook").filter({ has: page.locator(".handbook-line .handbook-name").filter({ hasText: name }) });
const open = async (page: Page, name: string): Promise<Locator> => {
  const list = handbookNamed(page, name);
  const head = list.locator(".handbook-line .handbook-name").first();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  const all = list.getByRole("button", { name: /^Show all \(\d+\)$/ });
  if (await all.count()) await all.click();
  return list;
};

test.describe("handbook at a real size", () => {
  step("G1", "three plugins that run hooks or servers are said in one line with one Got it, no cross", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    await expect(handbooks.getByRole("button", { name: /^Put away the notice/ })).toHaveCount(0);
    const line = handbooks.locator("p").filter({ hasText: /^\d+ plugins run hooks or servers: / });
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("docs-kit");
    await line.getByRole("button", { name: "Got it" }).click();
    await expect(handbooks.getByText("Put away; nothing changed.")).toBeVisible();
    await page.reload();
    await expect(handbooks.locator("p").filter({ hasText: /plugins run hooks or servers/ })).toHaveCount(0);
    await expect(handbooks.getByText("Put away; nothing changed.")).toHaveCount(0);
  });

  step("G2", "Add a plugin never pours the catalog on the page: search first, own marketplaces, at most 8 rows, a box that scrolls", async ({ page }) => {
    await signIn(page);
    const before = (await (async () => { await openTeam(page); return pageHeight(page); })());
    const group = await openAddPlugin(page);
    await expect(group.getByRole("searchbox")).toBeVisible();
    await expect(group.getByText("fetched from elsewhere")).toHaveCount(0);
    const rows = group.locator("li");
    expect(await rows.count()).toBeLessThanOrEqual(8);
    await expect(group.getByRole("button", { name: "Show more" })).toBeVisible();
    await expect(group).not.toContainText("retro-kit");
    expect(await pageHeight(page)).toBeLessThan(before + 700);
    await group.getByRole("searchbox").fill("retro-kit");
    await expect(group.locator("li").filter({ hasText: "retro-kit" }).first().getByRole("button", { name: /^Install/ })).toBeVisible();
    const description = group.locator("li").filter({ hasText: "retro-kit" }).first();
    expect((await box(description)).height).toBeLessThan(80);
    expect(CATALOG_SIZE).toBeGreaterThan(100);
  });

  step("G3", "a hook row and the CLAUDE.md row open and show their content, the hook without any environment value", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const yours = await open(page, "Yours");
    const hook = yours.locator("li.handbook-row").filter({ has: page.locator(".handbook-meta", { hasText: "Hook" }) }).first();
    await hook.locator(".handbook-name").click();
    await expect(hook.locator(".handbook-open")).toContainText(/echo (guard-bash|format-after-edit|session-banner)/);
    await expect(hook.locator(".handbook-open")).not.toContainText("PAYMENTS_DEBUG_TOKEN");
    const rules = yours.locator("li.handbook-row").filter({ has: page.locator(".handbook-name", { hasText: "CLAUDE.md" }) }).first();
    await rules.locator(".handbook-name").click();
    await expect(rules.locator(".handbook-open")).toContainText("Small changes, tests first.");
  });

  step("G4", "what a row opens starts under the row's name, not at the left edge", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const yours = await open(page, "Yours");
    const row = yours.locator("li.handbook-row").filter({ has: page.locator(".handbook-name", { hasText: /^my-review$/ }) }).first();
    await row.locator(".handbook-name").click();
    const name = await box(row.locator(".handbook-name"));
    const content = await box(row.locator(".handbook-open p").first());
    expect(content.x).toBeGreaterThanOrEqual(name.x - 1);
    const off = handbooksOf(page).locator("details").filter({ has: page.locator("summary", { hasText: /^Off \(/ }) });
    await off.locator(".handbook-name").first().click();
    const inner = await box(off.locator("li.handbook").first());
    expect(inner.x).toBeGreaterThan((await box(off.locator("summary"))).x);
  });

  step("G5", "a folded description reads as a sentence, first in the opened row, and the body follows", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const yours = await open(page, "Yours");
    await expect(handbooksOf(page)).not.toContainText(">-");
    const row = yours.locator("li.handbook-row").filter({ has: page.locator(".handbook-name", { hasText: /^my-review$/ }) }).first();
    await row.locator(".handbook-name").click();
    const opened = row.locator(".handbook-open");
    await expect(opened.locator("p").first()).toContainText("Use when a change to my-review is about to be reviewed, and the notes of the last review are still open.");
    await expect(opened).toContainText("Read the open notes first, then the diff.");
    await expect(opened).not.toContainText("description:");
  });

  step("G6", "a personal person's Team has no setup list and no sentence about the team working here", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    await expect(page.getByText("Getting set up")).toHaveCount(0);
    for (const path of ["/default/team", "/default/tasks", "/default/work", "/default/integrations", "/default/settings"]) {
      await page.goto(path);
      await expect(page.getByText("before the team works here")).toHaveCount(0);
      await expect(page.getByText("Give a team of agents any folder")).toHaveCount(0);
    }
  });

  step("G7", "the new task form and its list use the page width, rows full width with the switch at the right edge", async ({ page }) => {
    await signIn(page);
    const viewport = page.viewportSize()!.width;
    const form = page.getByRole("form", { name: "New task" });
    await expect(form).toBeVisible();
    expect((await box(form)).width).toBeGreaterThanOrEqual(viewport * (viewport > 600 ? 0.6 : 0.88));
    const setup = form.locator("div.task-setup > details");
    await setup.locator(":scope > summary").click();
    await setup.locator(".handbook-line .handbook-name").first().click();
    const row = setup.locator("li.handbook-row").first();
    const rowBox = await box(row);
    expect(rowBox.width).toBeGreaterThanOrEqual((await box(form)).width * 0.85);
    const toggle = await box(row.getByRole("switch").first());
    expect(rowBox.x + rowBox.width - (toggle.x + toggle.width)).toBeLessThan(40);
  });

  step("G8", "Integrations cards stand in a grid on a wide screen and one column on a phone", async ({ page }) => {
    await signIn(page);
    await page.goto("/default/integrations");
    const cards = page.locator("ul.cards").first().locator("li.panel.card");
    await expect(cards.nth(1)).toBeVisible();
    const first = await box(cards.nth(0));
    const second = await box(cards.nth(1));
    if (page.viewportSize()!.width > 600) {
      expect(Math.abs(first.y - second.y)).toBeLessThan(4);
      expect(second.x).toBeGreaterThan(first.x + first.width - 2);
    } else {
      expect(Math.abs(first.x - second.x)).toBeLessThan(2);
      expect(second.y).toBeGreaterThan(first.y);
    }
  });

  step("G9", "servers waiting for a sign-in: buttons inside the fold, side by side, readable names, one each", async ({ page }) => {
    await signIn(page);
    await startTask(page, "Add a note to the payments API");
    await page.goto("/default/tasks");
    const fold = page.locator("details").filter({ has: page.locator("summary", { hasText: /MCP servers? need sign-in/ }) }).first();
    await expect(fold.locator("summary")).toContainText(/\d+ MCP servers need sign-in/);
    await expect(page.getByRole("button", { name: /^Sign in with/ }).first()).toBeHidden();
    await fold.locator("summary").click();
    const buttons = fold.getByRole("button", { name: /^Sign in with \S/ });
    expect(await buttons.count()).toBeGreaterThanOrEqual(4);
    const text = await fold.innerText();
    expect(text).not.toMatch(/plugin[:_]/);
    await expect(fold.getByRole("button", { name: "Sign in with Notion" })).toHaveCount(1);
    await expect(fold).toContainText("Atlassian (from incident-kit)");
    if (page.viewportSize()!.width > 600) expect(Math.abs((await box(buttons.nth(0))).y - (await box(buttons.nth(1))).y)).toBeLessThan(4);
    const sentence = fold.getByText(/run claude, then \/mcp/);
    expect((await box(sentence)).y).toBeGreaterThan((await box(buttons.last())).y);
  });

  step("G10", "an asked question's answer shows on the Work rail with a Read it link, one filled button", async () => {
    test.fixme(true, "needs a forge stand-in beside the home; the rail is covered by work.spec until the fixture grows one");
  });

  step("G11", "the summary says how many handbooks and how much is on, and an off plugin says off once", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    await expect(handbooks).toContainText(/\d+ handbooks, \d+ of \d+ on/);
    await expect(handbooks).not.toContainText("not measured yet");
    await handbooks.locator("details").filter({ has: page.locator("summary", { hasText: /^Off \(\d+\)$/ }) }).locator("summary").click();
    const off = handbookNamed(page, "api-style");
    const line = off.locator(".handbook-line").first();
    await expect(line).toBeVisible();
    const said = await line.innerText();
    expect(said).not.toMatch(/0 of \d+ on/);
    expect(said).not.toContain("Also off in your terminal");
    expect(said).toMatch(/\boff\b/i);
    expect((said.match(/\boff\b/gi) ?? []).length).toBeLessThanOrEqual(1);
  });

  step("G12", "what is off sits under the Off row below the list, closed", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    const off = handbooks.locator("li.handbook-off").filter({ hasText: /9 handbooks/ });
    await expect(off).toHaveCount(1);
    await expect(handbookNamed(page, "api-style")).toBeHidden();
    const lastOn = await box(handbookNamed(page, "release-train"));
    expect((await box(off)).y).toBeGreaterThan(lastOn.y);
    await off.locator("summary").click();
    await expect(handbookNamed(page, "api-style")).toBeVisible();
  });
});
