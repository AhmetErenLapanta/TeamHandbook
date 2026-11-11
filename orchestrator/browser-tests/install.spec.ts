import { expect, test } from "@playwright/test";

// The installed app: its manifest names the shortcuts and the share target, and each lands on its
// page in the person's own organization.

test("given the page, when its manifest is read, then it names the app, its two shortcuts and a share target that opens the task form", async ({ page, request }) => {
  // when
  await page.goto("/demo/activity");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const manifest = await (await request.get(href!)).json();

  // then
  expect(manifest).toMatchObject({ name: "TeamHandbook Orchestrator", start_url: "/", display: "standalone" });
  expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual(["New task", "My work"]);
  expect(manifest.share_target).toMatchObject({ action: "/", method: "GET" });
});

test("given a link shared to the app, when it opens, then the task form holds it as the work and nothing starts", async ({ page }) => {
  // when
  await page.goto(`/?title=Bug&url=${encodeURIComponent("https://tracker.example.invalid/browse/PAY-142")}`);

  // then
  await expect(page).toHaveURL(/\/demo\/work\/new\?issue=/);
  await expect(page.getByLabel("What needs doing?")).toHaveValue("https://tracker.example.invalid/browse/PAY-142");
});

test("given the New task shortcut, when it opens, then it lands on Tasks", async ({ page }) => {
  // when
  await page.goto("/?go=tasks");

  // then
  await expect(page).toHaveURL(/\/demo\/tasks$/);
});
