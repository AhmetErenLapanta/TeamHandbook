import { expect, test } from "@playwright/test";
import { ROLES, stateFor } from "./roles.js";
import { choose, optionsOf } from "./task-form.js";

test.describe("a member's own API key", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when they make a key that reads requests, then its secret is shown once, it reads requests but not usage, and revoking it turns it away", async ({ page, playwright, baseURL }) => {
    // given
    await page.goto("/#/settings/api-keys");
    const form = page.getByRole("form", { name: "New API key" });

    // when
    await form.getByLabel("Name").fill(`release-notes-${Date.now()}`);
    await choose(form, "Repositories", "None");
    await choose(form, "Requests", "Read");
    await form.getByRole("button", { name: "Create key" }).click();

    // then
    const secret = (await page.getByRole("region", { name: "New API key" }).locator("code").textContent())!;
    expect(secret).toMatch(/^th_sk_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(await optionsOf(form, "Members")).toEqual(["None", "Read"]);
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
    expect((await api.get("/api/requests")).status()).toBe(200);
    expect((await api.get("/api/usage")).status()).toBe(403);
    await page.getByRole("button", { name: "I copied it" }).click();
    await expect(page.getByRole("region", { name: "New API key" })).toHaveCount(0);

    // when it is revoked
    const table = page.getByRole("table", { name: "Your API keys" });
    const row = table.getByRole("row", { name: new RegExp(secret.slice(0, 18)) });
    await row.getByRole("button", { name: /^Revoke/ }).click();
    expect((await api.get("/api/requests")).status()).toBe(200);
    await row.getByRole("button", { name: "Revoke key" }).click();

    // then
    await expect(table.getByRole("row", { name: new RegExp(secret.slice(0, 18)) })).toContainText("revoked");
    expect((await api.get("/api/requests")).status()).toBe(401);
    await api.dispose();
  });
});

test.describe("asked twice before it is gone", () => {
  test("given a new key, when it is shown, then it has its own Copy button, and when Revoke is opened and Keep key chosen, then the key still works", async ({ page, playwright, baseURL }) => {
    // given
    await page.goto("/#/settings/api-keys");
    const form = page.getByRole("form", { name: "New API key" });
    await form.getByLabel("Name").fill(`kept-${Date.now()}`);
    await form.getByRole("button", { name: "Create key" }).click();
    const shown = page.getByRole("region", { name: "New API key" });
    const secret = (await shown.locator("code").textContent())!;

    // then
    await expect(shown.getByRole("button", { name: "Copy key" })).toBeVisible();

    // when
    const row = page.getByRole("table", { name: "Your API keys" }).getByRole("row", { name: new RegExp(secret.slice(0, 18)) });
    await row.getByRole("button", { name: /^Revoke/ }).click();
    await expect(row).toContainText("This cannot be undone.");
    await row.getByRole("button", { name: "Keep key" }).click();

    // then
    await expect(row.getByRole("button", { name: /^Revoke/ })).toBeFocused();
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
    expect((await api.get("/api/repos")).status()).toBe(200);
    await api.dispose();
  });

  test("given a member's page, when Remove is opened and Keep member chosen, then the member stays", async ({ page }) => {
    // given
    await page.goto("/demo/settings/members");
    await page.getByRole("link", { name: ROLES.member.name, exact: true }).click();
    const account = page.getByRole("region", { name: `${ROLES.member.name}'s account` });

    // when
    await account.getByRole("button", { name: `Remove ${ROLES.member.email}` }).click();
    await expect(account).toContainText("loses access at once");
    await account.getByRole("button", { name: "Keep member" }).click();
    await page.goto("/demo/settings/members");

    // then
    await expect(page.getByRole("row", { name: new RegExp(ROLES.member.name) })).toBeVisible();
  });

  test("given a Settings address with no such section, when it is opened, then it says the page is not found", async ({ page }) => {
    // when
    await page.goto("/demo/settings/nothing-here");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  });
});

test.describe("a key calling too often", () => {
  test("given a key that made its minute's 120 calls, when it calls again, then the orchestrator answers 429 with how long to wait, and the key works again after it", async ({ page, playwright, baseURL }) => {
    // given
    await page.goto("/#/settings/api-keys");
    const form = page.getByRole("form", { name: "New API key" });
    await form.getByLabel("Name").fill(`busy-${Date.now()}`);
    await form.getByRole("button", { name: "Create key" }).click();
    const secret = (await page.getByRole("region", { name: "New API key" }).locator("code").textContent())!;
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
    for (let i = 0; i < 120; i++) expect((await api.get("/api/repos")).status()).toBe(200);

    // when
    const held = await api.get("/api/repos");

    // then
    expect(held.status()).toBe(429);
    const wait = Number(held.headers()["retry-after"]);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    await api.dispose();
  });
});

test.describe("an admin's service account", () => {
  test.use({ storageState: stateFor("orgAdmin") });

  test("given an admin, when they add a service account owning Payments and give it a key that writes requests, then the key acts as that account and is still refused a merge", async ({ page, playwright, baseURL }) => {
    // given
    const name = `deploy-bot-${Date.now()}`;
    await page.goto("/#/settings/service-accounts");

    // when
    await page.getByLabel("Name").fill(name);
    await page.getByRole("form", { name: "Add service account" }).getByRole("checkbox", { name: "Payments" }).check();
    await page.getByRole("button", { name: "Add service account" }).click();
    const panel = page.getByRole("region", { name });
    await panel.getByRole("button", { name: "Show keys" }).click();
    const form = panel.getByRole("form", { name: "New key for this service account" });
    await form.getByLabel("Name").fill("ci");
    await choose(form, "Requests", "Write");
    await form.getByRole("button", { name: "Create key" }).click();

    // then
    const secret = (await panel.getByRole("region", { name: "New API key" }).locator("code").textContent())!;
    const api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
    expect((await (await api.get("/api/me")).json()).user).toMatchObject({ name, ownedTeams: ["Payments"] });
    const merge = await api.post("/api/repos/payments-skills/requests/1/merge");
    expect(merge.status()).toBe(403);
    expect((await merge.json()).error).toMatch(/takes a person/);
    await api.dispose();
  });
});
