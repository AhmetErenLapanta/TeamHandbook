import { expect, test } from "@playwright/test";
import { PASSWORD, ROLES, stateFor } from "./roles.js";
import type { Page } from "@playwright/test";
import { choose, optionsOf } from "./task-form.js";

/** A member's own page, opened from the list, where their role, teams and removal are changed. */
async function openMember(page: Page, name: string) {
  await page.goto("/demo/settings/members");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.getByRole("region", { name: `${name}'s account` });
}

test.describe("an owner inviting people", () => {
  test("given two addresses pasted with a space, when the owner invites them as admins, then each gets a link shown once, and the first link opened in a fresh browser joins as an admin", async ({ page, browser }) => {
    // given
    const stamp = Date.now();
    const first = `kim-${stamp}@example.invalid`;
    const second = `lee-${stamp}@example.invalid`;
    await page.goto("/#/settings/members");

    // when
    await page.getByRole("button", { name: "Invite members" }).click();
    await page.getByLabel("Emails").fill(`${first} ${second}`);
    await expect(page.getByRole("list", { name: "Addresses to invite" })).toContainText(first);
    await page.getByRole("radio", { name: "Admin" }).check();
    await page.getByRole("button", { name: "Create invitation links" }).click();

    // then
    const sent = page.getByRole("region", { name: "Links to send" });
    await expect(sent).toContainText(first);
    await expect(sent).toContainText(second);
    const pending = page.getByRole("region", { name: /^Invitations/ });
    await expect(pending.getByRole("row", { name: new RegExp(first) })).toContainText("Admin");
    const link = (await sent.locator("li", { hasText: first }).locator("code").textContent())!;

    // when the link is opened by the invited person
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const invited = await context.newPage();
    await invited.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(invited.getByText(`Ada Admin invited ${first} to`)).toContainText("as Admin.");
    await expect(invited.getByText("You'll manage members, repositories and settings")).toBeVisible();
    await invited.getByLabel("About this invitation").click();
    await expect(invited.getByText(/The link works once, until /)).toBeVisible();
    await invited.getByLabel("Name").fill("Kim Invited");
    await invited.getByLabel("Password").fill(PASSWORD);
    await invited.getByRole("button", { name: "Join and sign in" }).click();

    // then
    await expect(invited.getByRole("button", { name: "Account: Kim Invited" })).toBeVisible();
    await invited.goto(link.replace(/^https?:\/\/[^/]+/, ""));
    await expect(invited.getByRole("alert")).toHaveText("This invitation link is not valid any more; ask for a new one.");
    await context.close();
    await page.reload();
    await expect(page.getByRole("row", { name: /Kim Invited/ })).toContainText("Admin");
    await expect(pending.getByRole("row", { name: new RegExp(first) })).toHaveCount(0);

    // when the second invitation is picked and revoked
    await pending.getByRole("button", { name: second, exact: true }).click();
    await pending.getByRole("button", { name: `Revoke the invitation to ${second}` }).click();
    await expect(pending.getByRole("row", { name: new RegExp(second) })).toBeVisible();
    await pending.getByRole("button", { name: "Revoke invitation" }).click();

    // then
    await expect(pending.getByRole("row", { name: new RegExp(second) })).toHaveCount(0);
  });

  test("given a member's page, when the owner ticks a team, then nothing changes until Save, and Save makes them its owner", async ({ page }) => {
    // given
    const row = await openMember(page, ROLES.member.name);

    // when
    await row.getByRole("button", { name: `Edit the teams ${ROLES.member.email} owns` }).click();
    await row.getByRole("checkbox", { name: "Platform" }).check();
    await page.reload();

    // then
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    await expect(row).not.toContainText("Platform");

    // when saved
    await row.getByRole("button", { name: `Edit the teams ${ROLES.member.email} owns` }).click();
    await row.getByRole("checkbox", { name: "Platform" }).check();
    await row.getByRole("button", { name: `Save the teams ${ROLES.member.email} owns` }).click();

    // then
    await expect(row.getByRole("button", { name: `Edit the teams ${ROLES.member.email} owns` })).toBeVisible();
    await expect(row).toContainText("Platform");
    await row.getByRole("button", { name: `Edit the teams ${ROLES.member.email} owns` }).click();
    await row.getByRole("checkbox", { name: "Platform" }).uncheck();
    await row.getByRole("button", { name: `Save the teams ${ROLES.member.email} owns` }).click();
    await expect(row).not.toContainText("Platform");
  });

  test("given the owner's own page, when it opens, then their role cannot be changed, and Members says how an owner leaves", async ({ page }) => {
    // when
    const own = await openMember(page, ROLES.admin.name);

    // then
    await expect(own.getByLabel(`Role of ${ROLES.admin.email}`)).toBeDisabled();
    await page.goto("/demo/settings/members");
    await expect(page.getByText("Make another member an owner first; then you can leave.")).toBeVisible();
  });
});

test.describe("an admin", () => {
  test.use({ storageState: stateFor("orgAdmin") });

  test("given the admin's session, when Settings opens, then no owner can be given or touched, and the server refuses it when asked anyway", async ({ page }) => {
    // when
    await page.goto("/demo/settings/members");

    // then
    await page.getByRole("button", { name: "Invite members" }).click();
    // An admin invites an admin, a member or a viewer, never an owner.
    await expect(page.getByRole("group", { name: "Role" }).getByRole("radio")).toHaveCount(3);
    await expect(page.getByRole("radio", { name: "Owner" })).toHaveCount(0);
    const owner = await openMember(page, ROLES.admin.name);
    await expect(owner.getByLabel(`Role of ${ROLES.admin.email}`)).toBeDisabled();
    await expect(owner.getByRole("button", { name: `Remove ${ROLES.admin.email}` })).toHaveCount(0);
    const memberPage = await openMember(page, ROLES.member.name);
    expect(await optionsOf(memberPage, `Role of ${ROLES.member.email}`)).toEqual(["Admin", "Member", "Viewer"]);

    // when the server is asked directly
    const { csrf } = await (await page.request.get("/api/me")).json();
    const { users } = await (await page.request.get("/api/users")).json();
    const max = users.find((u: { email: string }) => u.email === ROLES.member.email);
    const res = await page.request.patch(`/api/users/${max.id}`, { data: { role: "owner" }, headers: { "x-csrf-token": csrf } });

    // then
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("nobody grants a role above their own");
  });
});

test.describe("a member", () => {
  test("given a member who joined by invitation, when they open their page and then leave, then the page shows them and leaving signs them out for good", async ({ page, browser }) => {
    // given
    const email = `leaver-${Date.now()}@example.invalid`;
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
    await expect(member.getByRole("button", { name: /^Account: / })).toBeVisible();

    // when
    await member.getByRole("button", { name: /^Account: / }).click();
    await member.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Settings" }).click();
    await expect(member.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
    await member.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Members" }).click();
    await member.getByRole("link", { name: "Open your own member page" }).click();

    // then
    await expect(member.getByRole("heading", { name: email })).toBeVisible();
    await expect(member.getByText("Nobody changes their own role.")).toBeVisible();

    // when they leave
    await member.goto("/#/settings/members");
    await member.getByRole("button", { name: "Leave…" }).click();
    await member.getByRole("button", { name: "Leave the organization" }).click();

    // then
    await expect(member.getByRole("heading", { name: "Sign in" })).toBeVisible();
    const again = await context.request.post("/api/auth/login", { data: { email, password: PASSWORD } });
    expect(again.status()).toBe(403);
    await context.close();
  });
});
