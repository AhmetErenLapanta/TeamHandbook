import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { CATALOG_SIZE } from "./handbook-scale-home.js";
import { spawnSync } from "node:child_process";
import { standInCalls } from "./handbook-home.js";
import { handbooksOf, server, signIn, startTask } from "./handbook-helpers.js";
import { connectJira, jiraSite } from "./jira-site.js";

const WAITING = new Set<string>([]);
const step = (id: string, title: string, body: (args: { page: Page }) => Promise<void>) => {
  const run = process.env.ORCHESTRATOR_E2E_HANDBOOK_ALL || !WAITING.has(id) ? test : test.fixme;
  run(`${id}: ${title}`, async ({ page }) => {
    test.setTimeout(90_000);
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
    const off = handbooksOf(page).locator("li.handbook-off");
    await off.locator(":scope > .handbook-line .handbook-name").click();
    const inner = await box(off.locator("li.handbook").first());
    expect(inner.x).toBeGreaterThan((await box(off.locator(":scope > .handbook-line .handbook-name"))).x);
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
      await page.waitForLoadState("networkidle");
      await expect(page.getByText("before the team works here"), path).toHaveCount(0);
      if (path !== "/default/tasks") await expect(page.getByText("Give a team of agents any folder"), path).toHaveCount(0);
    }
  });

  step("G7", "the new task form and its list use the page width, rows full width with the switch at the right edge", async ({ page }) => {
    await signIn(page);
    const viewport = page.viewportSize()!.width;
    const form = page.getByRole("form", { name: "New task" });
    await expect(form).toBeVisible();
    const setup = page.locator("section.task-setup");
    await expect(setup).toBeVisible();
    if (viewport >= 1100) expect((await box(form)).width).toBeGreaterThanOrEqual(viewport * 0.45);
    else await setup.locator("details > summary").click();
    await setup.locator(".handbook-line .handbook-name").first().click();
    const row = setup.locator("li.handbook-row").first();
    const rowBox = await box(row);
    expect(rowBox.width).toBeGreaterThanOrEqual((await box(setup)).width * 0.85);
    const toggle = await box(row.getByRole("switch").first());
    expect(rowBox.x + rowBox.width - (toggle.x + toggle.width)).toBeLessThan(40);
  });

  step("G8", "Integrations cards stand in a grid on a wide screen and one column on a phone", async ({ page }) => {
    await signIn(page);
    await page.goto("/default/integrations");
    await page.waitForLoadState("networkidle");
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
    await expect(page.getByRole("button", { name: /^Sign in to/ }).first()).toBeHidden();
    await fold.locator("summary").click();
    const buttons = fold.getByRole("button", { name: /^Sign in to \S/ });
    expect(await buttons.count()).toBeGreaterThanOrEqual(4);
    const text = await fold.innerText();
    expect(text).not.toMatch(/plugin[:_]/);
    await expect(fold.getByRole("button", { name: "Sign in to Notion", exact: true })).toHaveCount(1);
    await expect(fold.getByRole("button", { name: "Sign in to Atlassian" })).toHaveCount(1);
    if (page.viewportSize()!.width > 600) expect(Math.abs((await box(buttons.nth(0))).y - (await box(buttons.nth(1))).y)).toBeLessThan(4);
    const sentence = fold.getByText(/then \/mcp, in your terminal/);
    expect((await box(sentence)).y).toBeGreaterThan((await box(buttons.last())).y);
  });

  step("G10", "an asked question's answer shows on the Work rail with a Read it link, one filled button", async ({ page }) => {
    await signIn(page);
    const { server, url } = await jiraSite();
    const disconnect = await connectJira(page, url);
    try {
      await page.goto("/default/work");
      const card = page.getByRole("listitem", { name: "PAY-301 Round refunds half to even" });
      await card.getByRole("button", { name: "Round refunds half to even" }).click();
      const rail = page.getByRole("complementary", { name: "The picked issue" });
      await rail.getByRole("button", { name: "Ask about it…" }).click();
      await rail.getByLabel("Your question").fill("stand-in: answer only");
      await rail.getByRole("button", { name: "Ask", exact: true }).click();
      await expect(rail.getByRole("link", { name: "See the answer" })).toBeVisible();
      await expect.poll(() => page.request.get("/api/tasks").then((r) => r.json() as Promise<{ tasks: { status: string; error?: string | null }[] }>).then((j) => j.tasks[0]).then((t) => `${t?.status} ${t?.error ?? ""}`), { timeout: 60_000 }).toMatch(/^(nothing-changed|needs-review|completed)/);
      await page.reload();
      await card.getByRole("button", { name: "Round refunds half to even" }).click();
      await expect(rail.getByRole("heading", { name: /^The agent's answer, \d\d:\d\d$/ })).toBeVisible();
      await expect(rail.getByText("Done.")).toBeVisible();
      await expect(rail.getByRole("link", { name: "Read it" })).toHaveAttribute("href", /\/tasks\/tsk_[0-9a-z]+$/);
      await expect(rail.getByRole("link", { name: "Open the issue" })).not.toHaveClass(/button/);
    } finally {
      await disconnect();
      server.close();
    }
  });

  step("G11", "the summary says how many handbooks and how much is on, and an off plugin says off once", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    await expect(handbooks).toContainText(/\d+ handbooks, \d+ of \d+ on/);
    await expect(handbooks).not.toContainText("not measured yet");
    await handbooks.locator("li.handbook-off .handbook-name").click();
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
    await off.locator(":scope > .handbook-line .handbook-name").click();
    await expect(handbookNamed(page, "api-style")).toBeVisible();
  });

  const askOnWork = async (page: Page, question: string): Promise<Locator> => {
    await page.goto("/default/work");
    const card = page.getByRole("listitem", { name: "PAY-301 Round refunds half to even" });
    await card.getByRole("button", { name: "Round refunds half to even" }).click();
    const rail = page.getByRole("complementary", { name: "The picked issue" });
    await rail.getByRole("button", { name: "Ask about it…" }).click();
    await rail.getByLabel("Your question").fill(question);
    await rail.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(rail.getByRole("link", { name: "See the answer" })).toBeVisible();
    await expect.poll(() => page.request.get("/api/tasks").then((r) => r.json() as Promise<{ tasks: { status: string }[] }>).then((j) => j.tasks[0]?.status), { timeout: 60_000 }).toMatch(/nothing-changed|needs-review|completed/);
    await page.reload();
    await card.getByRole("button", { name: "Round refunds half to even" }).click();
    return rail;
  };
  const withJira = async (page: Page, secondBoard: boolean, body: () => Promise<void>) => {
    const { server: site, url } = await jiraSite({ secondBoard });
    const disconnect = await connectJira(page, url);
    try {
      await body();
    } finally {
      await disconnect();
      site.close();
    }
  };
  const QUESTION = "stand-in: answer only\nstand-in: answer markdown";

  step("H1", "the question stands above the answer on the Work rail and on the task page", async ({ page }) => {
    await signIn(page);
    await withJira(page, false, async () => {
      const rail = await askOnWork(page, QUESTION);
      const asked = rail.getByText(/^You asked:/);
      await expect(asked).toBeVisible();
      expect((await box(asked)).y).toBeLessThan((await box(rail.getByRole("heading", { name: /^The agent's answer/ }))).y);
      await rail.getByRole("link", { name: "Read it" }).click();
      const main = page.getByRole("main");
      const answer = main.getByRole("heading", { name: "The agent's answer" });
      await expect(main.getByText(/^You asked:/)).toBeVisible();
      expect((await box(main.getByText(/^You asked:/))).y).toBeLessThan((await box(answer)).y);
    });
  });

  step("H2", "the answer's summary on the rail is plain text, two lines, then Read it", async ({ page }) => {
    await signIn(page);
    await withJira(page, false, async () => {
      const rail = await askOnWork(page, QUESTION);
      const answer = rail.locator("section[aria-labelledby='asked-answer-h']");
      await expect(answer).toContainText("Short answer: it touches three files.");
      const said = await answer.innerText();
      expect(said).not.toContain("**");
      expect(said).not.toContain("`");
      expect(said).not.toContain("|---");
      await expect(answer.getByRole("link", { name: "Read it" })).toBeVisible();
    });
  });

  step("H3", "a table in the agent's answer is drawn as a table, scrolling sideways on a narrow screen", async ({ page }) => {
    await signIn(page);
    await withJira(page, false, async () => {
      const rail = await askOnWork(page, QUESTION);
      await rail.getByRole("link", { name: "Read it" }).click();
      const table = page.getByRole("main").getByRole("table");
      await expect(table).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "File" })).toBeVisible();
      await expect(table.getByRole("cell", { name: "src/refund.js" })).toBeVisible();
      await expect(table).not.toContainText("|---");
      await expect(page.getByRole("main").getByRole("heading", { name: "The agent's answer" }).locator("xpath=following::*[1]")).not.toContainText("|---");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  });

  step("H4", "the account menu stacks Settings and What's new one under the other without overflow", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /^Account/ }).click();
    const settings = page.getByRole("menuitem", { name: "Settings" }).or(page.getByRole("link", { name: "Settings", exact: true })).first();
    const news = page.getByRole("menuitem", { name: /^What's new/ }).or(page.getByRole("link", { name: /^What's new/ })).first();
    await expect(settings).toBeVisible();
    await expect(news).toBeVisible();
    const a = await box(settings);
    const b = await box(news);
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.height - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });

  step("H5", "the task panel starts with This task will use, a plain summary and, on a wide screen, the sources open", async ({ page }) => {
    await signIn(page);
    const setup = page.locator("section.task-setup");
    await expect(setup.getByRole("heading", { name: "This task will use" })).toBeVisible();
    await expect(setup).toContainText(/Your default setup: \d+ of \d+ on/);
    await expect(setup).toContainText("Turn anything off for this task only");
    const heading = await box(setup.getByRole("heading", { name: "This task will use" }));
    const where = page.getByRole("heading", { name: /^Where it works/ });
    if (await where.count()) expect(heading.y).toBeLessThan((await box(where)).y);
    if (page.viewportSize()!.width >= 1100) {
      await expect(setup.getByRole("button", { name: /^docs-kit/ }).first()).toBeVisible();
      await setup.getByRole("switch", { name: /^Use docs-kit/ }).first().click();
      await expect(setup).toContainText(/1 change from your default/);
      await setup.getByRole("button", { name: "Reset" }).click();
      await expect(setup).toContainText(/Your default setup: \d+ of \d+ on/);
    }
  });

  step("H6", "the task page says Off (N) for what the default left off, and Off for this task only for what was closed for it", async ({ page }) => {
    await signIn(page);
    const plain = await startTask(page, "A first note for the payments API");
    await page.goto(`/default/tasks/${plain}`);
    const started = page.getByRole("region", { name: "Started with" });
    await expect(started.getByText(/^Off \(\d+\)$/)).toBeVisible();
    await expect(started.getByText(/^Off for this task/)).toHaveCount(0);
    await page.goto("/");
    const setup = page.locator("section.task-setup");
    if (page.viewportSize()!.width < 1100) await setup.getByText("What it loads").click();
    await setup.getByRole("button", { name: /^Yours/ }).first().click();
    const shown = setup.locator("li.handbook-row").first().getByRole("switch");
    await shown.click();
    const closed = await startTask(page, "A second note for the payments API");
    await page.goto(`/default/tasks/${closed}`);
    await expect(page.getByRole("region", { name: "Started with" }).getByText(/^Off for this task \(1\)$/)).toBeVisible();
  });

  step("J1", "the task panel says its summary once and its one sentence once, and no handbook count", async ({ page }) => {
    await signIn(page);
    const setup = page.locator("section.task-setup");
    const said = await setup.innerText();
    expect((said.match(/Your default setup:/g) ?? []).length).toBe(1);
    expect((said.match(/Turn anything off for this task only/g) ?? []).length).toBe(1);
    expect(said).not.toContain("Only for this task");
    expect(said).not.toMatch(/\d+ handbooks, /);
  });

  step("J2", "each row of the task panel is one line with its switch at the right edge and no per-row usage note", async ({ page }) => {
    await signIn(page);
    const setup = page.locator("section.task-setup");
    if (page.viewportSize()!.width < 1100) await setup.getByText("What it loads").click();
    await setup.getByRole("button", { name: /^Yours/ }).first().click();
    const rows = setup.locator("li.handbook-row");
    await expect(rows.first()).toBeVisible();
    const all = setup.getByRole("button", { name: /^Show all/ });
    if (await all.count()) await all.click();
    expect(await rows.count()).toBeGreaterThan(10);
    await expect(setup).not.toContainText("Not used in 30 days");
    const first = await box(rows.first());
    const edge = first.x + first.width;
    for (const i of [0, 5, 10]) {
      const row = rows.nth(i);
      expect((await box(row)).height).toBeLessThan(first.height * 1.5);
      const toggle = await box(row.getByRole("switch"));
      expect(Math.abs(toggle.x + toggle.width - edge)).toBeLessThan(40);
    }
  });

  step("J3", "the task panel's left edge is a handle: arrows widen it within 320 px and half the window, and a double click restores it", async ({ page }) => {
    test.skip(page.viewportSize()!.width < 1100, "no handle once the panel sits below");
    await signIn(page);
    const setup = page.locator("section.task-setup");
    const handle = page.getByRole("separator", { name: /panel/i }).first();
    await expect(handle).toBeVisible();
    const before = (await box(setup)).width;
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    expect((await box(setup)).width).toBeGreaterThan(before);
    await handle.dblclick();
    expect(Math.abs((await box(setup)).width - before)).toBeLessThan(4);
  });

  step("J4", "TeamHandbook's own plugin is on no list and in no count", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    await expect(handbooks.getByRole("button", { name: /^handbook\b/ }).filter({ hasNotText: /-/ })).toHaveCount(0);
    await expect(handbooks).toContainText(/\d+ handbooks, /);
    const total = Number((await handbooks.innerText()).match(/(\d+) handbooks/)![1]);
    const sources = (await (await page.request.get("/api/handbook/sources")).json()) as { sources: { id: string }[] };
    expect(sources.sources.map((x) => x.id)).not.toContain("plugin:handbook@teamhandbook");
    expect(total).toBe(sources.sources.length);
  });

  step("K1", "the Off row has the height, divider and chevron of a source row and no switch", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const off = handbooksOf(page).locator("li.handbook-off");
    const source = handbooksOf(page).locator("li.handbook:not(.handbook-off)").first();
    const offLine = off.locator(":scope > .handbook-line");
    const sourceLine = source.locator(":scope > .handbook-line");
    if (page.viewportSize()!.width > 600) expect(Math.abs((await box(offLine)).height - (await box(sourceLine)).height)).toBeLessThan(6);
    await expect(offLine.getByRole("switch")).toHaveCount(0);
    await expect(offLine).toContainText(/^Off\s*\d+ handbooks$/);
    const border = await off.evaluate((el) => getComputedStyle(el).borderTopWidth);
    expect(parseFloat(border)).toBeGreaterThan(0);
  });

  step("K2", "Add is the last row of the list, a quiet full-width row, and nothing sits above the list", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    const add = handbooks.getByRole("button", { name: "+ Add a skill, a command, an MCP server or a plugin" });
    await expect(add).toBeVisible();
    expect((await box(add)).y).toBeGreaterThan((await box(handbooks.locator("li.handbook-off"))).y);
    await expect(handbooks.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    const list = await box(handbooks.locator("ul.handbooks").first());
    expect((await box(add)).width).toBeGreaterThanOrEqual(list.width * 0.9);
  });

  step("L1", "Work comes back on the board the person last picked", async ({ page }) => {
    await signIn(page);
    await withJira(page, true, async () => {
      await page.goto("/default/work");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Payments");
      await page.getByRole("combobox", { name: "Board" }).click();
      await page.getByRole("option", { name: /^Platform board/ }).click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Platform");
      await page.goto("/default/work");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Platform");
    });
  });

  step("L2", "the Add row is body-sized and as tall as a source row, and its options sit in a row of normal buttons with Cancel last", async ({ page }) => {
    await signIn(page);
    await openTeam(page);
    const handbooks = handbooksOf(page);
    const add = handbooks.getByRole("button", { name: /^\+ Add a skill/ });
    const source = handbooks.locator("li.handbook:not(.handbook-off) > .handbook-line").first();
    expect((await box(add)).height).toBeGreaterThanOrEqual((await box(source)).height - 6);
    const fontSize = await add.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(14);
    await add.click();
    const names = ["New skill", "New command", "Add a plugin"];
    const boxes = [] as { x: number; y: number }[];
    for (const name of names) boxes.push(await box(handbooks.getByRole("button", { name })));
    if (page.viewportSize()!.width > 600) expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
    else expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
    const cancel = await box(handbooks.getByRole("button", { name: "Cancel" }));
    expect(cancel.y >= boxes[0]!.y).toBe(true);
    expect(cancel.x > boxes[2]!.x || cancel.y > boxes[2]!.y).toBe(true);
  });
});
