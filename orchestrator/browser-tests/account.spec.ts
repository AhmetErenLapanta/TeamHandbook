import { expect, test } from "@playwright/test";
import { PASSWORD, ROLES } from "./roles.js";

test.describe("a person's own account", () => {
  test("given a member who joined by invitation, when they rename themselves, review what deleting removes and delete with their address typed back, then they land on the deleted page and cannot sign in again", async ({ page, browser }) => {
    // given
    const email = `leaving-${Date.now()}@example.invalid`;
    await page.goto("/#/settings/members");
    await page.getByRole("button", { name: "Invite members" }).click();
    await page.getByLabel("Emails").fill(email);
    await page.getByRole("button", { name: "Create invitation links" }).click();
    const link = (await page.getByRole("region", { name: "Links to send" }).locator("code").textContent())!;
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const member = await context.newPage();
    await member.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await member.getByLabel("Password").fill(PASSWORD);
    await member.getByRole("button", { name: "Join and sign in" }).click();
    await expect(member.getByRole("button", { name: /^Account:/ })).toBeVisible();

    // when they rename themselves
    await member.goto("/#/settings/account");
    await member.getByRole("form", { name: "Your name" }).getByLabel("Name").fill("Lee Leaving");
    await member.getByRole("button", { name: "Save name" }).click();

    // then
    await expect(member.getByRole("status")).toHaveText("Your name is Lee Leaving.");

    // when they review and delete
    await member.getByRole("button", { name: "Review what is deleted…" }).click();
    await expect(member.getByRole("region", { name: "Delete your account" })).toContainText("Member; 0 active API keys revoked; 0 open requests stay for review");
    const remove = member.getByRole("button", { name: "Delete my account" });
    await expect(remove).toBeDisabled();
    await member.getByLabel(`Type ${email} to confirm`).fill(email);
    await remove.click();

    // then
    await expect(member.getByRole("heading", { name: "Your account is deleted" })).toBeVisible();
    expect((await context.request.post("/api/auth/login", { data: { email, password: PASSWORD } })).status()).toBe(403);
    await context.close();
  });

  test("given the only owner, when they review what deleting their account removes, then it says why it cannot be deleted and offers no deletion", async ({ page }) => {
    // when
    await page.goto("/#/settings/account");
    await page.getByRole("button", { name: "Review what is deleted…" }).click();

    // then
    await expect(page.getByText(/cannot be deleted while you are the only owner/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete my account" })).toHaveCount(0);
    await expect(page.getByLabel(`Type ${ROLES.admin.email} to confirm`)).toHaveCount(0);
  });
});
