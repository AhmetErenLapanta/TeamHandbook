import { mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work } from "./task-form.js";
import type { Page } from "@playwright/test";
import { taskLog } from "./task-page.js";

// The README's pictures, one main screen per layer, taken from the stand-in demo. Opt-in,
// because it changes the orchestrator it runs against (a request merged, counts received, a task
// run): `ORCHESTRATOR_E2E_SCREENSHOTS=1` against a fresh demo container, so every path on screen
// is the container's own.
const OUT = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));

test.skip(!process.env.ORCHESTRATOR_E2E_SCREENSHOTS, "set ORCHESTRATOR_E2E_SCREENSHOTS=1 to write docs/screenshots");
test.use({ viewport: { width: 1280, height: 800 } });

/** Nothing of the machine taking the picture reaches it: no home directory, temp directory or account name. */
async function shoot(page: Page, name: string): Promise<void> {
  const text = await page.content();
  const traces = [homedir(), tmpdir(), userInfo().username].filter((t) => t.length >= 4);
  for (const trace of traces) expect(text, `${name} shows ${trace}`).not.toContain(trace);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString().slice(0, 13);
}

test("given the stand-in demo, when each layer's main screen is opened, then its picture is written for the README", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const api = page.request;

  // Signing in, as someone with no session sees the orchestrator first.
  const signedOut = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });
  const gate = await signedOut.newPage();
  await gate.goto("/");
  await expect(gate.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
  await shoot(gate, "0-sign-in");
  await signedOut.close();

  // Layer 1: what a team has.
  await page.goto("/demo/repositories/payments-skills/skills");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("payments-skills");
  await shoot(page, "1-inventory");

  // Layer 2: a change prepared as a request.
  await page.getByRole("row", { name: /^release-checklist/ }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("SKILL.md")).toHaveValue(/name: release-checklist/);
  await page.getByLabel("SKILL.md").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await shoot(page, "2-editing");

  // Layer 3: the team asks for skill-use counts, a person merges that, and teammates' counts arrive.
  const { csrf } = await (await api.get("/api/me")).json();
  const headers = { "x-csrf-token": csrf };
  const { proposal } = await (await api.post("/api/repos/payments-skills/usage/proposal", { headers })).json();
  const { repos } = await (await api.get("/api/repos")).json();
  const baseSha = repos.find((r: { id: string }) => r.id === "payments-skills").head;
  const proposed = await api.post("/api/repos/payments-skills/usage/propose", { headers, data: { baseSha, message: proposal } });
  expect(proposed.ok(), await proposed.text()).toBe(true);
  const { request } = await proposed.json();
  expect((await api.post(`/api/repos/payments-skills/requests/${request.number}/merge`, { headers })).ok()).toBe(true);
  await api.post("/api/repos/payments-skills/sync", { headers });
  const { inventory } = await (await api.get("/api/repos/payments-skills/inventory")).json();
  const endpoint = new URL(inventory.team.usageEndpoint).pathname;
  const events = [
    ...Array.from({ length: 14 }, (_, i) => ({ skill: "release-checklist", hour: hoursAgo(i * 7) })),
    ...Array.from({ length: 5 }, (_, i) => ({ skill: "add-ledger-migration", hour: hoursAgo(i * 30 + 2) })),
  ];
  expect((await api.post(endpoint, { data: { events } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("row", { name: /^release-checklist/ })).toContainText("14");
  await shoot(page, "3-usage");

  // Layer 4: a task handed to the stand-in agent, waiting for review.
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Add an on-call handover skill\nWrite down what the outgoing engineer hands over at the end of a shift.");
  await choose(form, "Repository", /^payments-skills/);
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();
  await expect(page).toHaveURL(/\/demo\/tasks\/(?:tsk_[0-9a-z]{26}|[a-f0-9]{12})$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add an on-call handover skill");
  await expect((await taskLog(page))).toContainText("It waits for a person to review and merge it.", { timeout: 30_000 });
  await shoot(page, "4-task");
  await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
  await shoot(page, "4-tasks");

  // Every request the orchestrator opened, in one list.
  await page.goto("/demo/repositories/payments-skills/requests");
  await expect(page.getByRole("row", { name: /on-call handover/ }).first()).toBeVisible();
  await shoot(page, "2-requests");
});
