import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The suite's orchestrator runs self-hosted; the welcome only shows to an orchestrator told it runs locally or in the cloud. */
export async function inMode(page: Page, mode: "local" | "cloud"): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode, runners: mode === "cloud" } } });
  });
  if (mode === "cloud") {
    const unset = { connection: null, available: true, missing: [] };
    await page.route("**/api/forge/*/connection", (route) => route.fulfill({ json: unset }));
  }
}

/** The first screen of a local orchestrator with a home folder to pick from; the suite's own server has no home to list. */
export async function folderPicker(page: Page): Promise<void> {
  await inMode(page, "local");
  await page.route(/\/api\/local\/folders/, (route) => route.fulfill({ json: { under: "/home/ada", parent: null, truncated: false, suggestions: [{ name: "payments-api", path: "/home/ada/code/payments-api", git: "origin", markers: [] }], folders: [{ name: "code", path: "/home/ada/code", git: "none", markers: [] }, { name: "on-call-notes", path: "/home/ada/on-call-notes", git: "none", markers: [] }] } }));
  await page.goto("/demo/welcome");
  await expect(page.locator("button.folder-row").filter({ hasText: "on-call-notes" })).toBeVisible();
}

/** A task the stand-in agent has finished, on its own page: the screen a person reviews the agent's change on. */
export async function finishedTask(page: Page): Promise<void> {
  const { csrf } = await (await page.request.get("/api/me")).json();
  const start = () => page.request.post("/api/tasks", { data: { title: "Add a retry to the payments webhook", description: "Design.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });
  // Opened first thing after the server starts, the repository may not have been read yet; a refused start makes nothing, so it is asked again.
  let started = await start();
  for (let tries = 0; started.status() === 409 && tries < 30; tries++) {
    await page.waitForTimeout(1_000);
    started = await start();
  }
  const { task, error } = await started.json();
  // A refused start says why, rather than failing later on a task that is not there.
  if (!task) throw new Error(`the task did not start: ${started.status()} ${error}`);
  await page.goto(`/demo/tasks/${task.id}`);
  // The stand-in agent's run, with its git work on the demo repository, passed a minute at load 10.
  await expect(page.locator("[data-status]").first()).toHaveText(/needs you|failed/, { timeout: 150_000 });
}
