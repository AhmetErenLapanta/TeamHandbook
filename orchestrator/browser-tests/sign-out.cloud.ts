import { expect, test } from "@playwright/test";
import { browserOf, createOrganization, pick } from "./cloud-browser.js";

// Signing out of a cloud orchestrator from the account menu ends the one sign-in behind every
// organization, not only the session of the organization on screen.

test.skip(!process.env.CLOUD_E2E_ORIGIN, "needs ORCHESTRATOR_TEST_DATABASE_URL for a cloud orchestrator's Postgres");

test("given a new owner signed in to a cloud organization, when they sign out from the account menu, then the one sign-in behind every organization ends", async ({ browser }) => {
  // given
  const mia = await browserOf(browser);
  await mia.page.goto("/signup");
  await pick(mia.page, "Google", "Mia Kaya");
  await createOrganization(mia.page, "Kaya Keys");
  await expect(mia.page).toHaveURL(/\/kaya-keys\//);

  // when
  await mia.page.getByRole("button", { name: "Account: Mia Kaya" }).click();
  await mia.page.getByRole("button", { name: "Sign out" }).click();

  // then
  await expect(mia.page).toHaveURL(/\/signup/);
  expect(await mia.page.evaluate(() => fetch("/api/identity").then((r) => r.status))).toBe(401);
  await mia.page.goto("/kaya-keys/activity");
  await expect(mia.page).toHaveURL(/\/signup/);
  await mia.context.close();
});
