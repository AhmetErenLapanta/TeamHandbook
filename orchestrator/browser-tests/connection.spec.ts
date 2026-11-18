import { expect, test } from "@playwright/test";

// A page that lost the orchestrator says so under the top bar after five seconds, in the waiting tone and never as a toast,
// reads itself again once the orchestrator is back, and after a minute says what it had and offers to ask again.

test("given a page whose orchestrator stops answering, when five seconds pass, then it says it is reconnecting, and once the orchestrator is back the line goes", async ({ page }) => {
  // given
  await page.clock.install();
  await page.goto("/demo/tasks");
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();
  await page.route("**/api/**", (route) => route.abort());

  // when
  await page.getByRole("link", { name: "Integrations", exact: true }).first().click();
  const band = page.getByRole("status").filter({ hasText: "Reconnecting to the orchestrator…" });
  await expect(async () => {
    await page.clock.fastForward(1_000);
    await expect(band).toBeVisible({ timeout: 200 });
  }).toPass();

  // then
  await expect(band).toBeVisible();

  // when
  await page.unroute("**/api/**");
  await expect(async () => {
    await page.clock.fastForward(1_000);
    await expect(band).toHaveCount(0, { timeout: 200 });
  }).toPass();
});

test("given an orchestrator that stays silent for a minute, when the page waits, then it says what it had and Try again asks once more", async ({ page }) => {
  // given
  await page.clock.install();
  await page.goto("/demo/tasks");
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();
  await page.route("**/api/**", (route) => route.abort());
  await page.getByRole("link", { name: "Integrations", exact: true }).first().click();

  // when
  const silent = page.getByRole("status").filter({ hasText: /^The orchestrator does not answer; this page shows what it had at \d\d:\d\d\./ });
  await expect(async () => {
    await page.clock.fastForward(5_000);
    await expect(silent).toBeVisible({ timeout: 200 });
  }).toPass();

  // when
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Try again" }).click();

  // then
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});
