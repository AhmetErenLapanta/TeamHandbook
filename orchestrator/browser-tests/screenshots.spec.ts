import { mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work } from "./task-form.js";
import type { Page } from "@playwright/test";

// The README's pictures, one main screen per layer, taken from the stand-in demo. Opt-in,
// because it changes the orchestrator it runs against (a request merged, counts received, a task
// run): `ORCHESTRATOR_E2E_SCREENSHOTS=1` against a fresh demo container, so every path on screen
// is the container's own.
const OUT = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

test.skip(!process.env.ORCHESTRATOR_E2E_SCREENSHOTS, "set ORCHESTRATOR_E2E_SCREENSHOTS=1 to write docs/screenshots");
test.use({ viewport: { width: 1280, height: 800 } });

/** Nothing of the machine taking the picture reaches it: no home directory, temp directory or account name. */
async function shoot(page: Page, name: string): Promise<void> {
  await expect(page.getByText(/^Loading\b/)).toHaveCount(0, { timeout: 30_000 });
  const text = await page.content();
  const traces = [homedir(), tmpdir(), userInfo().username].filter((t) => t.length >= 4);
  for (const trace of traces) expect(text, `${name} shows ${trace}`).not.toContain(trace);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

test("given the stand-in demo, when each layer's main screen is opened, then its picture is written for the README", async ({ page, browser }) => {
  test.setTimeout(120_000);

  // Signing in, as someone with no session sees the orchestrator first.
  const signedOut = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });
  const gate = await signedOut.newPage();
  await gate.goto("/");
  await expect(gate.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
  await shoot(gate, "0-sign-in");
  await signedOut.close();

  // A task handed to the stand-in agent, waiting for review.
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Add an on-call handover skill\nWrite down what the outgoing engineer hands over at the end of a shift.");
  await choose(form, "Repository", /^payments-skills/);
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();
  await expect(page).toHaveURL(/\/demo\/tasks\/(?:tsk_[0-9a-z]{26}|[a-f0-9]{12})$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add an on-call handover skill");
  await expect(page.getByText(/waits for your review/i).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /^Changes/ }).first()).toBeVisible();
  await shoot(page, "4-task");
  await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
  await shoot(page, "4-tasks");

  await page.goto("/demo/team");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Team");
  await shoot(page, "5-team");
});
