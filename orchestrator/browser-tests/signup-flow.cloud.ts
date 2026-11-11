import { expect, test } from "@playwright/test";
import { browserOf, createOrganization, pick } from "./cloud-browser.js";

// A cloud orchestrator from first visit to two organizations, with the lab's stand-in providers:
// nothing here is stood in for on the page; every answer is the orchestrator's own.

test.skip(!process.env.CLOUD_E2E_ORIGIN, "needs ORCHESTRATOR_TEST_DATABASE_URL for a cloud orchestrator's Postgres");

test("given three people new to a cloud orchestrator, when Ada signs up with Google and invites Ben, Ben signs up with GitHub and follows the invitation, and Cem signs in with Microsoft uninvited, then Ada and Ben each own an organization, Ben also belongs to Ada's and picks between them, and Cem belongs to none", async ({ browser }) => {
  // given
  const ada = await browserOf(browser);
  const ben = await browserOf(browser);
  const cem = await browserOf(browser);

  // when Ada signs up from the landing page
  await ada.page.goto("/signup?from=landing");
  await pick(ada.page, "Google", "Ada Okafor");
  await expect(ada.page).toHaveURL(/\/signup\/organization$/);
  await createOrganization(ada.page, "Okafor Labs");

  // then she owns it
  await expect(ada.page).toHaveURL(/\/okafor-labs\/welcome$/);

  // when she invites Ben
  await ada.page.goto("/okafor-labs/settings/members");
  await ada.page.getByRole("button", { name: "Invite members" }).click();
  await ada.page.getByLabel("Emails").fill("ben@ortiz-builds.example.invalid");
  await ada.page.getByRole("button", { name: "Create invitation links" }).click();
  const link = (await ada.page.getByRole("region", { name: "Links to send" }).locator("code").textContent())!;

  // and Ben signs up with GitHub, creates his own, then follows the link
  await ben.page.goto("/signup");
  await pick(ben.page, "GitHub", "Ben Ortiz");
  await createOrganization(ben.page, "Ortiz Builds");
  await expect(ben.page).toHaveURL(/\/ortiz-builds\/welcome$/);
  await ben.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(ben.page.getByText("Ada Okafor invited ben@ortiz-builds.example.invalid to Okafor Labs")).toBeVisible();
  // He is signed in as the invited address already, so joining takes no second sign-in.
  await ben.page.getByRole("button", { name: "Join Okafor Labs" }).click();

  // then he is in Ada's organization and picks between the two
  await expect(ben.page).toHaveURL(/\/okafor-labs\//);
  await ben.page.getByRole("button", { name: "Organization: Okafor Labs" }).click();
  await expect(ben.page.getByRole("link", { name: /^Ortiz Builds/ })).toBeVisible();
  await expect(ben.page.getByRole("link", { name: /^Okafor Labs/ })).toHaveAttribute("aria-current", "true");
  await expect(ben.page.getByRole("link", { name: "New organization" })).toHaveAttribute("href", "/signup/organization");

  // when Cem signs in with Microsoft with no invitation
  await cem.page.goto("/signup");
  await pick(cem.page, "Microsoft", "Cem Aydin");

  // then he has no organization, and Ada's is not his to open
  await expect(cem.page).toHaveURL(/\/signup\/organization$/);
  await cem.page.goto("/okafor-labs/activity");
  await expect(cem.page.getByText("You are not a member of okafor-labs.")).toBeVisible();
  const reached = await cem.page.evaluate(() => fetch("/api/orgs/okafor-labs/me").then((r) => r.status));
  expect(reached).toBe(401);
});

test("given an address Google has not verified, when Gus signs up with it, then the orchestrator takes him nowhere and says why", async ({ browser }) => {
  // given
  const gus = await browserOf(browser);

  // when
  await gus.page.goto("/signup?from=landing");
  await pick(gus.page, "Google", "Gus Unverified");

  // then
  await expect(gus.page).toHaveURL(/\/signup\?problem=/);
  await expect(gus.page.getByRole("alert")).toHaveText("Your provider has not verified this account's email address. Verify it there, or sign in another way.");
});
