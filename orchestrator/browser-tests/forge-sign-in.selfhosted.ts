import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// A self-hosted orchestrator one person runs on their own machine (playwright.selfhosted.config.ts):
// each forge card is one action, the person's own gh or glab signing in through the browser, as Jira's
// card is one sign-in; the OAuth application form and tokens wait under "Other ways to connect". The
// gh and glab are stand-ins: the spec approves their sign-in by writing a file in the person's home.
const home = join(process.env.ORCHESTRATOR_E2E_SCRATCH!, "home");

for (const forge of [
  { kind: "github", name: "GitHub", tool: "gh", page: "https://github.com/login/device", host: "github.com" },
  { kind: "gitlab", name: "GitLab", tool: "glab", page: "https://gitlab.com/oauth/device", host: "gitlab.com" },
] as const) {
  test(`given a self-hosted orchestrator only this machine reaches, when the person presses Sign in with ${forge.name} and approves in the browser, then the card shows the code and the page, and says connected as them, with no application form in sight`, async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.locator(`#card-${forge.kind}`);
    // The card reads the person's CLI before it draws, several starts of it, which a loaded machine slows.
    await expect(card.getByRole("button", { name: `Sign in with ${forge.name}` })).toBeVisible({ timeout: 15_000 });
    await expect(card.getByLabel("Application ID")).toBeHidden();

    // when
    await card.getByRole("button", { name: `Sign in with ${forge.name}` }).click();

    // then
    await expect(card.getByRole("status")).toContainText(`Enter this code on ${forge.name}:`, { timeout: 15_000 });
    await expect(card.locator(".sign-in-code").getByText("ABCD-1234", { exact: true })).toBeVisible();
    await expect(card.getByRole("status")).toContainText(`Open ${forge.name}. Waiting for ${forge.name}.`);
    await expect(card.getByRole("button", { name: "Copy the code" })).toBeVisible();
    await expect(card.getByRole("button", { name: `Sign in with ${forge.name}` })).toHaveCount(0);
    await expect(card.getByRole("link", { name: `Open ${forge.name}` })).toHaveAttribute("href", forge.page);
    writeFileSync(join(home, `.stand-in-${forge.tool}-approved`), "");
    await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`Connected as ada on ${forge.host}.`);
  });
}

test("given a self-hosted orchestrator only this machine reaches, when the person opens Other ways to connect on GitLab, then the organization's own application is offered there, not as the card's action", async ({ page }) => {
  // given
  await page.goto("/demo/integrations");
  const card = page.locator("#card-gitlab");

  // when
  await card.getByText("Other ways to connect", { exact: true }).click();

  // then
  await expect(card.getByRole("form", { name: "Your GitLab application" })).toBeVisible();
  await expect(card.getByLabel("Application ID")).toBeVisible();
});

test("given a self-hosted orchestrator a second person also reaches and no GitLab application registered, when a manager opens Integrations, then the GitLab card names the one-person rule as why it has no sign-in, not the missing application", async ({ page }) => {
  // given
  await page.route("**/api/forge/gitlab/sign-in", async (route) => {
    const read = await (await route.fetch()).json();
    await route.fulfill({ json: { ...read, offered: false, why: "signing in with your own glab is for an orchestrator only one person reaches, on this machine", cli: null, installLine: null, signIn: { state: "idle" } } });
  });

  // when
  await page.goto("/demo/integrations");

  // then
  const card = page.locator("#card-gitlab");
  await expect(card).toContainText("Signing in with your own glab is for an orchestrator only one person reaches, on this machine; connect with a token under Other ways to connect.");
  await expect(card.getByRole("button", { name: "Sign in with GitLab" })).toHaveCount(0);
  await expect(card).not.toContainText("has not registered");
});
