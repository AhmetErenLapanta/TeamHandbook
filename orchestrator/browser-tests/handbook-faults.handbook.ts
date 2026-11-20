import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { server, signIn, startTask } from "./handbook-helpers.js";
import { connectJira, jiraSite } from "./jira-site.js";
import type { Fault } from "./jira-site.js";

const WAITING = new Set<string>([]);
const step = (id: string, title: string, body: (args: { page: Page }) => Promise<void>) => {
  const run = process.env.ORCHESTRATOR_E2E_HANDBOOK_ALL || !WAITING.has(id) ? test : test.fixme;
  run(`${id}: ${title}`, async ({ page }) => {
    test.setTimeout(120_000);
    await body({ page });
  });
};

const RAW = /TypeError|undefined|\[object|Error:|ECONN|<html|\{"|\bat \S+:\d+/;

const sentence = async (page: Page, words: RegExp, where = "[role=alert], [role=status], .error"): Promise<string> => {
  const found = page.locator(where).filter({ hasText: words }).first();
  await expect(found).toBeVisible({ timeout: 20_000 });
  const said = (await found.innerText()).trim();
  expect(said.length).toBeLessThan(240);
  expect(said).not.toMatch(RAW);
  return said;
};

const withJira = async (page: Page, body: (site: Awaited<ReturnType<typeof jiraSite>>) => Promise<void>) => {
  const site = await jiraSite();
  const disconnect = await connectJira(page, site.url);
  try {
    await body(site);
  } finally {
    await disconnect();
    site.server.close();
  }
};

const trackerStaysConnected = async (page: Page) => {
  const sources = await page.request.get("/api/work/sources");
  expect(sources.ok()).toBe(true);
  expect(JSON.stringify(await sources.json())).toMatch(/jira/i);
};

const workWith = (fault: Fault, words: RegExp) => async ({ page }: { page: Page }) => {
  await signIn(page);
  await withJira(page, async (site) => {
    site.fault.now = fault;
    await page.goto("/default/work");
    await sentence(page, words);
    await trackerStaysConnected(page);
  });
};

test.describe("what a person sees when something goes wrong", () => {
  step("R1", "an expired tracker token is one sentence that says to sign in again, and the connection is kept", workWith("expired-token", /token|sign in|reconnect/i));
  step("R2", "a board the person may not read is one sentence about access, and the connection is kept", workWith("no-access", /access|permission|allowed/i));
  step("R3", "a rate limit is one sentence that says to wait and try again, and the connection is kept", workWith("rate-limited", /wait|try again|too many|limit/i));
  step("R4", "a dropped network is one sentence that the tracker cannot be reached, and the connection is kept", workWith("unreachable", /reach|connect|network|offline/i));

  step("R9", "once the tracker is back, Retry the board brings the board back without a restart", async ({ page }) => {
    await signIn(page);
    await withJira(page, async (site) => {
      site.fault.now = "rate-limited";
      await page.goto("/default/work");
      const retry = page.getByRole("button", { name: "Retry the board" });
      await expect(retry).toBeVisible({ timeout: 20_000 });
      site.fault.now = "none";
      await retry.click();
      await expect(page.getByRole("listitem", { name: "PAY-301 Round refunds half to even" })).toBeVisible({ timeout: 30_000 });
    });
  });

  step("R5", "an issue deleted while its question is typed is one sentence, and the question stays in the box", async ({ page }) => {
    await signIn(page);
    await withJira(page, async (site) => {
      await page.goto("/default/work");
      const card = page.getByRole("listitem", { name: "PAY-301 Round refunds half to even" });
      await card.getByRole("button", { name: "Round refunds half to even" }).click();
      const rail = page.getByRole("complementary", { name: "The picked issue" });
      await rail.getByRole("button", { name: "Ask about it…" }).click();
      await rail.getByLabel("Your question").fill("How big is this?");
      site.fault.now = "issue-gone";
      await rail.getByRole("button", { name: "Ask", exact: true }).click();
      await sentence(page, /gone|deleted|no longer|moved|not found/i);
      await expect(rail.getByLabel("Your question")).toHaveValue("How big is this?");
    });
  });

  step("R6", "an agent that crashes after writing says so in one sentence and its change is still there to review", async ({ page }) => {
    await signIn(page);
    const id = await startTask(page, "stand-in: crash after writing");
    await page.goto(`/default/tasks/${id}`);
    // A change kept for review says why beside it, as a note: the task did not fail, its agent did.
    await sentence(page, /stopped|crash|did not finish|ended/i, "[role=note]");
    await expect(page.getByRole("main")).toContainText("half-done.js");
    expect(server().folder).toBeTruthy();
  });

  step("R8", "two tabs on one finished task: the second Keep is told in one sentence that it was already kept", async ({ page }) => {
    await signIn(page);
    const id = await startTask(page, "Add a note to the payments API");
    const other = await page.context().newPage();
    await page.goto(`/default/tasks/${id}`);
    await other.goto(`/default/tasks/${id}`);
    const keep = (p: Page): Locator => p.getByRole("button", { name: "Keep these changes" });
    await expect(keep(other)).toBeVisible();
    await keep(page).click();
    await expect(page.getByText(/kept|saved|merged/i).first()).toBeVisible({ timeout: 20_000 });
    await keep(other).click();
    await sentence(other, /already|kept|merged/i);
    await other.close();
  });
});
