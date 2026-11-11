import { expect, test } from "@playwright/test";
import { ROLES, stateFor } from "./roles.js";

// Settings reads like every other top section: a heading per page, the section's own links
// under it, and addresses under /<org>/settings/... that need no old-address redirect.

test("given Settings, when each section is opened from its links, then the page is titled for it, the link is marked current and the address is a path, not a #/ address", async ({ page }) => {
  // given
  await page.goto("/demo/settings/members");
  const nav = page.getByRole("navigation", { name: "Settings" });

  for (const [label, part] of [["Service accounts", "service-accounts"], ["API keys", "api-keys"], ["Task secrets", "task-secrets"], ["Security", "security"], ["Privacy", "privacy"], ["Your account", "account"], ["Members", "members"]] as const) {
    // when
    await nav.getByRole("link", { name: label, exact: true }).click();

    // then
    await expect(page).toHaveURL(new RegExp(`/demo/settings/${part}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(label);
    await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  for (const href of await nav.getByRole("link").evaluateAll((links) => links.map((a) => a.getAttribute("href")))) expect(href).toMatch(/^\/demo\/settings\/[a-z-]+$/);
});

test("given the member list, when a member is opened, then their page is titled with their name under a Members breadcrumb that leads back", async ({ page }) => {
  // given
  await page.goto("/demo/settings/members");

  // when
  await page.getByRole("link", { name: ROLES.paymentsOwner.name }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/settings\/members\/[\w-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(ROLES.paymentsOwner.name);
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Members", exact: true })).toHaveAttribute("aria-current", "page");

  // when the breadcrumb is followed
  await crumbs.getByRole("link", { name: "Members" }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/settings\/members$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Members");
});

test("given the privacy page, when its repository links are read, then each is a path under the organization", async ({ page }) => {
  // when
  await page.goto("/demo/settings/privacy");

  // then
  const links = page.getByRole("region", { name: "Usage reporting" }).getByRole("link");
  await expect(links.first()).toBeVisible();
  const hrefs = await links.evaluateAll((all) => all.map((a) => a.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs) expect(href).toMatch(/^\/demo\/repositories\/[a-z0-9-]+$/);
});

test.describe("as a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when Settings opens, then it opens on their account, offers only what they use, and Members shows who owns each team without managing anyone", async ({ page }) => {
    // when
    await page.goto("/demo/settings");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your account");
    const nav = page.getByRole("navigation", { name: "Settings" });
    await expect(nav.getByRole("link")).toHaveText(["Your account", "Members", "API keys", "Access", "Your machines"]);

    // when Members is opened
    await nav.getByRole("link", { name: "Members", exact: true }).click();

    // then
    const teams = page.getByRole("region", { name: /^Teams/ });
    await expect(teams.getByRole("row", { name: /Payments/ })).toContainText(ROLES.paymentsOwner.name);
    await expect(page.getByRole("button", { name: "Invite members" })).toHaveCount(0);
    await expect(page.getByText(ROLES.admin.email)).toHaveCount(0);
  });
});
