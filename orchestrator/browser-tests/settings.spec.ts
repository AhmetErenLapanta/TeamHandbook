import { expect, test } from "@playwright/test";
import { stateFor } from "./roles.js";

test.describe("security and privacy, as the owner", () => {
  test("given no member has signed in through SSO, when Security opens, then it says SSO is off, why SAML is not offered, and that groups appear after SSO sign-ins", async ({ page }) => {
    // when
    await page.goto("/#/settings/security");

    // then
    await expect(page.getByText("Single sign-on is off.")).toBeVisible();
    await page.getByText("Why not SAML?").click();
    await expect(page.getByText(/SAML is not offered/)).toBeVisible();
    await expect(page.getByText(/No group yet/)).toBeVisible();
  });

  test("given groups members signed in with, when a tag is typed, previewed and applied, then the preview lists who gains it and Apply tag changes sends that preview's fingerprint", async ({ page }) => {
    // given: the groups SSO sign-ins recorded; this suite's orchestrator has no identity provider
    await page.route("**/api/directory", async (route) => {
      if (route.request().method() === "PUT") return route.fulfill({ json: { changes: [], fingerprint: "f1" } });
      return route.fulfill({ json: { sso: { issuer: "https://idp.example.invalid", groupsClaim: "groups" }, groups: [{ group: "eng-backend", members: 2, tag: null }] } });
    });
    await page.route("**/api/directory/preview", (route) =>
      route.fulfill({ json: { changes: [{ member: { id: "u1", name: "Kim", email: "kim@example.invalid" }, gains: ["backend"], loses: [] }], fingerprint: "f1" } }),
    );
    const applied = page.waitForRequest((r) => r.url().endsWith("/api/directory") && r.method() === "PUT");
    await page.goto("/#/settings/security");

    // when
    await expect(page.getByRole("button", { name: "Apply tag changes" })).toBeDisabled();
    await page.getByLabel("Tag for eng-backend").fill("backend");
    await page.getByRole("button", { name: "Preview" }).click();

    // then
    await expect(page.getByRole("row", { name: /Kim.*backend/ })).toBeVisible();
    await page.getByRole("button", { name: "Apply tag changes" }).click();
    expect((await applied).postDataJSON()).toEqual({ mapping: [{ group: "eng-backend", tag: "backend" }], fingerprint: "f1" });
    await expect(page.getByRole("status")).toContainText("Applied.");
  });

  test("given an SSO domain waiting for its TXT record, when the owner verifies it, then the record to publish is shown first and the domain then reads verified", async ({ page }) => {
    // given: this suite's orchestrator has no identity provider, so the domains it would list are given here
    const pending = { domain: "acme.example", verified: false, verifiedAt: null, addedBy: "ada@example.invalid", addedAt: "2026-10-25T00:00:00.000Z", record: { name: "_teamhandbook-orchestrator.acme.example", value: "teamhandbook-orchestrator-verification=0123456789abcdef0123456789abcdef" } };
    let verified = false;
    await page.route("**/api/sso/domains", (route) => route.fulfill({ json: { sso: true, domains: [verified ? { ...pending, verified: true, verifiedAt: "2026-10-25T01:00:00.000Z" } : pending] } }));
    await page.route("**/api/sso/domains/acme.example/verify", (route) => {
      verified = true;
      return route.fulfill({ json: { domain: { ...pending, verified: true } } });
    });
    await page.goto("/#/settings/security");
    const row = page.getByRole("row", { name: /acme\.example/ });

    // then
    await expect(row).toContainText("_teamhandbook-orchestrator.acme.example");
    await expect(row).toContainText("teamhandbook-orchestrator-verification=0123456789abcdef0123456789abcdef");

    // when
    await row.getByRole("button", { name: "Verify acme.example" }).click();

    // then
    await expect(row).toContainText("Verified; signs in with SSO");
    await expect(row.getByRole("button", { name: "Verify acme.example" })).toHaveCount(0);
    await expect(page.getByLabel("Domain", { exact: true })).toBeVisible();
  });

  test("given directory provisioning off, when the owner makes a SCIM token, then it is shown once with a Copy button and the directory reaches the orchestrator with it, and turning it off asks first", async ({ page, playwright, baseURL }) => {
    // given
    await page.goto("/#/settings/security");
    const section = page.getByRole("region", { name: "Directory provisioning (SCIM)" });

    // when
    await section.getByRole("button", { name: "Make a SCIM token" }).click();

    // then
    const shown = section.getByRole("region", { name: "New SCIM token" });
    const token = (await shown.locator("code").textContent())!;
    expect(token).toMatch(/^th_scim_[0-9a-f]{12}_/);
    await expect(shown.getByRole("button", { name: "Copy the SCIM token" })).toBeVisible();
    const idp = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } });
    expect((await idp.get("/api/scim/v2/Users")).status()).toBe(200);

    // when turned off, with a second answer
    await section.getByRole("button", { name: "Turn off" }).click();
    await section.getByRole("button", { name: "Turn off provisioning" }).click();

    // then
    await expect(section).toContainText("none; provisioning is off");
    expect((await idp.get("/api/scim/v2/Users")).status()).toBe(401);
    await idp.dispose();
  });

  test("given Privacy, when the leaderboard is shown to members and the task log retention set to seven days, then both hold after a reload and each repository's reporting is listed", async ({ page }) => {
    // given
    await page.goto("/#/settings/privacy");

    // when
    await page.getByLabel("Leaderboard visible to members").click();
    await expect(page.getByRole("status")).toHaveText("The leaderboard is visible to members.");
    await page.getByLabel("Days to keep task logs").fill("7");
    await page.getByRole("form", { name: "Task log retention" }).getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toContainText("kept 7 days");
    await page.reload();

    // then
    await expect(page.getByLabel("Leaderboard visible to members")).toBeChecked();
    await expect(page.getByLabel("Days to keep task logs")).toHaveValue("7");
    await expect(page.getByRole("region", { name: "Usage reporting" }).getByRole("row", { name: /payments-skills/ })).toBeVisible();

    // and back, for the specs after this one
    await page.getByLabel("Owners and admins only").click();
    await expect(page.getByRole("status")).toHaveText("The leaderboard is visible to owners and admins.");
  });
});

test.describe("security and privacy, as a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when Security and Privacy open, then each says only owners and admins see it", async ({ page }) => {
    await page.goto("/#/settings/security");
    await expect(page.getByText("Only owners and admins see security settings.")).toBeVisible();
    await page.goto("/#/settings/privacy");
    await expect(page.getByText("Only owners and admins see privacy settings.")).toBeVisible();
  });
});
