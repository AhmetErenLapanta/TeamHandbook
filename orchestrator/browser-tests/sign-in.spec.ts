import { expect, test } from "@playwright/test";
import { PASSWORD, ROLES } from "./roles.js";

test.describe("signing in", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("given no session, when the orchestrator opens, then it asks to sign in, refuses a wrong password, and lets the right one in", async ({ page }) => {
    // when
    await page.goto("/");

    // then
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // when a wrong password is tried
    await page.getByLabel("Email").fill(ROLES.member.email);
    await page.getByLabel("Password").fill("not the password at all");
    await page.getByRole("button", { name: "Sign in" }).click();

    // then
    await expect(page.getByRole("alert")).toHaveText("Wrong email or password.");

    // when the right one is
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // then
    await page.getByRole("button", { name: `Account: ${ROLES.member.name}` }).click();
    await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  });

  test("given the orchestrator is already set up, when the setup call is made again with the code, then it is refused", async ({ request }) => {
    // when
    const res = await request.post("/api/auth/setup", {
      data: { code: process.env.ORCHESTRATOR_E2E_SETUP_TOKEN, email: "eve@example.invalid", password: PASSWORD },
    });

    // then
    expect(res.status()).toBe(409);
  });

  test("given a session cookie, when it is read in the browser, then it is HttpOnly and SameSite=Strict", async ({ browser }) => {
    // given
    const context = await browser.newContext();
    await context.request.post("/api/auth/login", { data: { email: ROLES.member.email, password: PASSWORD } });

    // when
    const cookie = (await context.cookies()).find((c) => c.name.startsWith("th_session_"));

    // then
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict" });
    await context.close();
  });

  test("given a session that ended while a task was being typed, when the orchestrator is opened again, then the sign-in screen says the session ended and what to do, and after signing in the typed words are back", async ({ browser }) => {
    // given
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.request.post("/api/auth/login", { data: { email: ROLES.admin.email, password: PASSWORD } });
    const typing = await context.newPage();
    await typing.goto("/demo/tasks");
    await typing.getByLabel("What needs doing?").fill("Add a retry to the payments webhook.");
    const session = (await context.cookies()).find((c) => c.name.startsWith("th_session_"))!;
    await context.addCookies([{ ...session, value: "ended" }]);

    // when
    const page = await context.newPage();
    await page.goto("/demo/tasks");

    // then
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Your session here ended: it ran out, or your access to this organization changed; sign in again, and ask an owner or an admin if that does not let you in.")).toBeVisible();
    await expect(page.getByLabel("Email")).not.toHaveAttribute("aria-invalid", "true");

    // when they sign in
    await page.getByLabel("Email").fill(ROLES.admin.email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // then
    await expect(page.getByLabel("What needs doing?")).toHaveValue("Add a retry to the payments webhook.");
    await context.close();
  });
});

test.describe("an owner", () => {
  test("given the owner's session, when the old people address is opened, then Settings lists every member with their role and the teams they own", async ({ page }) => {
    // when
    await page.goto("/demo/settings/members");

    // then
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    const pat = page.getByRole("row", { name: /Pat Payments/ });
    await expect(pat).toContainText("Member");
    await expect(pat.getByText("Payments", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: /Gus Admin/ })).toContainText("Admin");
  });
});
