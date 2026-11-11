import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// The suite's orchestrator is a self-hosted one, which answers no identity path; these screens are
// driven with a cloud orchestrator's answers stood in for. The server side of signup is checked in
// server/signup.test.ts against the lab's stand-in providers.

const CONFIG = { providers: ["google", "github", "microsoft"], privacyUrl: "http://127.0.0.1:3050/en/teamhandbook/orchestrator/privacy", termsUrl: "http://127.0.0.1:3050/en/teamhandbook/orchestrator/terms", signupOpen: true };
const VIEW = { identity: { email: "ada@okafor-labs.example.invalid", name: "Ada Okafor", signedInWith: "google" }, logins: [], memberships: [], csrf: "stand-in-csrf" };

async function cloudOrchestrator(page: Page, identity: object | null, created: { body?: unknown } = {}) {
  await page.route("**/api/identity/config", (route) => route.fulfill({ json: CONFIG }));
  await page.route("**/api/identity", (route) => (identity ? route.fulfill({ json: identity }) : route.fulfill({ status: 401, json: { error: "sign in first" } })));
  await page.route("**/api/signup/organization", async (route) => {
    created.body = route.request().postDataJSON();
    expect(route.request().headers()["x-csrf-token"]).toBe("stand-in-csrf");
    await route.fulfill({ json: { tenant: "demo", name: "Okafor Labs", next: "/demo/activity" } });
  });
}

test.describe("signing up on a cloud orchestrator", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("given a person from the landing page, when /signup opens, then it offers each provider's sign-in, says nobody joins without an invitation, and links the terms and the privacy policy", async ({ page }) => {
    // given
    await cloudOrchestrator(page, null);

    // when
    await page.goto("/signup?from=landing");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start with TeamHandbook Orchestrator");
    for (const [name, provider] of [["Google", "google"], ["GitHub", "github"], ["Microsoft", "microsoft"]]) {
      await expect(page.getByRole("link", { name: `Sign in with ${name}` })).toHaveAttribute("href", `/api/auth/${provider}/start`);
    }
    await expect(page.getByText("nobody joins without an invitation")).toBeVisible();
    await expect(page.getByRole("link", { name: "Terms of use" })).toHaveAttribute("href", CONFIG.termsUrl);
    await expect(page.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", CONFIG.privacyUrl);
  });

  test("given a sign-in the orchestrator refused, when it sends the person back with a code, then /signup says why in its own words, and a link carrying text of its own shows only the general sentence", async ({ page }) => {
    // given
    await cloudOrchestrator(page, null);

    // when
    await page.goto("/signup?problem=unverified-email");

    // then
    await expect(page.getByRole("alert")).toHaveText("Your provider has not verified this account's email address. Verify it there, or sign in another way.");

    // when a link brings text of its own
    await page.goto(`/signup?problem=${encodeURIComponent("Your account is locked; call this number to unlock it")}`);

    // then
    await expect(page.getByRole("alert")).toHaveText("That sign-in did not finish. Try again.");
    await page.goto("/signup?problem=toString");
    await expect(page.getByRole("alert")).toHaveText("That sign-in did not finish. Try again.");
  });

  test("given a signed-in person with no organization, when they name one and accept the terms, then the address follows the name, the orchestrator is asked to create it with the session's token, and they land in it", async ({ page }) => {
    // given
    const created: { body?: unknown } = {};
    await cloudOrchestrator(page, VIEW, created);
    await page.goto("/signup/organization");
    const form = page.getByRole("form", { name: "Create your organization" });

    // when
    await form.getByLabel("Organization name").fill("Okafor Labs");
    await expect(form.getByLabel("Web address", { exact: true })).toHaveValue("okafor-labs");
    await form.getByRole("button", { name: "Create organization" }).click();

    // then the terms are asked for first
    expect(created.body).toBeUndefined();

    // when accepted
    await form.getByLabel(/I accept the terms of use/).check();
    await form.getByRole("button", { name: "Create organization" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/activity$/);
    expect(created.body).toEqual({ name: "Okafor Labs", slug: "okafor-labs", acceptTerms: true });
  });

  test("given an orchestrator with a help address and a person signed in as someone else, when /signup opens with a refusal, then it says why, offers help, and Use another account signs out and shows the providers", async ({ page }) => {
    // given
    let signedIn = true;
    let signedOut = false;
    await page.route("**/api/identity/config", (route) => route.fulfill({ json: { ...CONFIG, helpUrl: "http://127.0.0.1:3050/en/teamhandbook/orchestrator/help" } }));
    await page.route("**/api/identity", (route) => (signedIn ? route.fulfill({ json: VIEW }) : route.fulfill({ status: 401, json: { error: "sign in first" } })));
    await page.route("**/api/identity/logout", async (route) => {
      expect(route.request().headers()["x-csrf-token"]).toBe("stand-in-csrf");
      signedIn = false;
      signedOut = true;
      await route.fulfill({ json: { ok: true } });
    });

    // when
    await page.goto("/signup?problem=invite-email");

    // then
    await expect(page.getByRole("alert")).toHaveText("This invitation is for another email address. Sign in with the account that has that address.");
    await expect(page.getByRole("link", { name: "Stuck? Get help" })).toHaveAttribute("href", "http://127.0.0.1:3050/en/teamhandbook/orchestrator/help");

    // when they use another account
    await page.getByRole("button", { name: "Use another account" }).click();

    // then
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
    expect(signedOut).toBe(true);
  });

  test("given a person who is not signed in, when they open the create page, then they are sent to sign in first", async ({ page }) => {
    // given
    await cloudOrchestrator(page, null);

    // when
    await page.goto("/signup/organization");

    // then
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  });
});
