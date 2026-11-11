import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The orchestrator updating itself on one person's machine, from stand-in answers for each step,
// so the suite never asks for a release or replaces what it runs.

async function asLocal(page: Page): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
}

test("given an orchestrator installed with install.sh, when its person checks, prepares and switches, then each step is the one button, and a service-run orchestrator offers Restart now", async ({ page }) => {
  // given
  await asLocal(page);
  let prepared: string | null = null;
  const asked: string[] = [];
  await page.route("**/api/update", (route) => route.fulfill({ json: { installed: true, running: "0.4.0", prepared, failed: null } }));
  await page.route("**/api/update/check", (route) => {
    asked.push("check");
    return route.fulfill({ json: { running: "0.4.0", newest: "0.5.0", newer: true } });
  });
  await page.route("**/api/update/prepare", (route) => {
    asked.push(`prepare ${(route.request().postDataJSON() as { version: string }).version}`);
    prepared = "0.5.0";
    return route.fulfill({ json: { ok: true, said: ["Downloaded 0.5.0.", "Checked its signature."] } });
  });
  await page.route("**/api/update/apply", (route) => {
    asked.push("apply");
    return route.fulfill({ json: { ok: true, said: ["Switched to 0.5.0."], restart: "service" } });
  });
  await page.route("**/api/update/restart", (route) => {
    asked.push("restart");
    return route.fulfill({ status: 202, json: { restarting: true } });
  });
  await page.goto("/demo/settings/updates");
  const section = page.getByRole("region", { name: "This orchestrator" });

  // then nothing has asked the network yet
  await expect(section.getByRole("status")).toHaveText("Running 0.4.0.");
  expect(asked).toEqual([]);

  // when each step is taken
  await section.getByRole("button", { name: "Check for updates" }).click();
  await expect(section.getByRole("status")).toHaveText("0.5.0 is out. Preparing downloads and checks it; this version keeps running.");
  await section.getByRole("button", { name: "Prepare 0.5.0" }).click();
  await expect(section.getByRole("status")).toHaveText("0.5.0 is prepared and checked.");
  await section.getByRole("button", { name: "Switch to 0.5.0" }).click();
  await expect(section.getByRole("status")).toHaveText("Switched. The new version runs once the orchestrator starts again.");
  await section.getByRole("button", { name: "Restart now" }).click();

  // then
  await expect(section.getByRole("status")).toHaveText("Starting again with the new version; this page answers once it is back.");
  expect(asked).toEqual(["check", "prepare 0.5.0", "apply", "restart"]);
  await expect(section.locator("details")).toContainText("What the update said");
});

test("given an orchestrator not installed with install.sh, when Updates opens, then it says how it is updated and offers no step", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route("**/api/update", (route) => route.fulfill({ json: { installed: false } }));

  // when
  await page.goto("/demo/settings/updates");

  // then
  await expect(page.locator("main")).toContainText("This orchestrator was not installed with install.sh, so it is updated the way it was installed.");
  await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
});

test("given a copy run from a clone and one run through npx, when Updates opens, then each says the command that updates it", async ({ page }) => {
  // given
  await asLocal(page);
  let answer: Record<string, unknown> = { installed: false, from: "clone", folder: "/home/person/teamhandbook" };
  await page.route("**/api/update", (route) => route.fulfill({ json: answer }));

  // when
  await page.goto("/demo/settings/updates");

  // then
  await expect(page.locator("main")).toContainText("This orchestrator runs from a clone. To update it, run git pull in /home/person/teamhandbook, then npm start.");

  // when
  answer = { installed: false, from: "npx" };
  await page.reload();

  // then
  await expect(page.locator("main")).toContainText("This orchestrator runs through npx; npx teamhandbook-orchestrator@latest runs the newest release.");
  await expect(page.getByRole("button", { name: "Check for updates" })).toHaveCount(0);
});

test("given a team's orchestrator, when Settings opens, then it offers no Updates, since it is updated where it is deployed", async ({ page }) => {
  // when
  await page.goto("/demo/settings");

  // then
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Updates" })).toHaveCount(0);
});
