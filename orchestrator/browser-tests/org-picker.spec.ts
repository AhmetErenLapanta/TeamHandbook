import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const DEMO = { tenant: "demo", name: "Ada Admin", role: "admin" };
const GLOBEX = { tenant: "globex", orgName: "Globex Corporation", name: "Gil Globex", role: "member" };

/**
 * A second organization this browser holds a session in, answered in place of the orchestrator:
 * its own person, no repositories, and a record of every call that reached it.
 */
async function globex(page: Page, signedIn: { yes: boolean }): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/orgs", (route) => route.fulfill({ json: { default: "demo", orgs: [DEMO, ...(signedIn.yes ? [GLOBEX] : [])] } }));
  await page.route("**/api/orgs/globex/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/orgs/globex", "");
    asked.push(`${route.request().method()} ${path}`);
    if (path === "/me") return signedIn.yes ? route.fulfill({ json: { user: { id: "g1", name: GLOBEX.name, email: "gil@example.invalid", role: "member", ownedTeams: [] }, csrf: "c" } }) : route.fulfill({ status: 401, json: { error: "sign in first" } });
    if (path === "/auth/config") return route.fulfill({ json: { setupNeeded: false, sso: false } });
    if (path === "/auth/login") {
      signedIn.yes = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/repos") return route.fulfill({ json: { repos: [] } });
    if (path === "/activity/summary") return route.fulfill({ json: { repos: 0, requests: { open: 0, merged: 0, closed: 0 }, members: 1, usage: { days: 30, total: 0, top: [] }, tasks: { total: 0, recent: [] }, forges: { hosted: 0, connected: 0 } } });
    if (path === "/tasks") return route.fulfill({ json: { tasks: [] } });
    if (path === "/tasks/options") return route.fulfill({ json: { agents: [], repos: [], readinessReport: false } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  return asked;
}

test("given one organization, when the orchestrator opens, then no organization picker is shown", async ({ page }) => {
  // when
  await page.goto("/demo/activity");

  // then
  await expect(page.getByRole("button", { name: /^Account:/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Organization:/ })).toHaveCount(0);
});

test("given sessions in two organizations, when the other one is picked, then the same page opens in it and its calls go under its prefix", async ({ page }) => {
  // given
  const asked = await globex(page, { yes: true });
  await page.goto("/demo/tasks");
  const picker = page.getByRole("button", { name: "Organization: demo" });

  // when
  await picker.click();

  // then
  await expect(picker).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: /^demo/ })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("link", { name: /^Globex Corporation/ })).toContainText("Globex Corporation · member");

  // when
  await page.getByRole("link", { name: /^Globex Corporation/ }).click();

  // then
  await expect(page).toHaveURL(/\/globex\/tasks$/);
  await expect(page.getByRole("button", { name: "Organization: Globex Corporation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Account: Gil Globex" })).toBeVisible();
  expect(asked).toEqual(expect.arrayContaining(["GET /me", "GET /repos"]));
});

test("given the picker open, when Escape is pressed, then it closes and focus returns to it", async ({ page }) => {
  // given
  await globex(page, { yes: true });
  await page.goto("/demo/activity");
  const picker = page.getByRole("button", { name: "Organization: demo" });
  await picker.click();

  // when
  await page.keyboard.press("Escape");

  // then
  await expect(picker).toHaveAttribute("aria-expanded", "false");
  await expect(picker).toBeFocused();
});

test("given an organization with no session yet, when it is named in the picker, then it asks to sign in there and every call after goes under its prefix", async ({ page }) => {
  // given
  const signedIn = { yes: false };
  const asked = await globex(page, signedIn);
  await page.route("**/api/orgs", (route) => route.fulfill({ json: { default: "demo", orgs: [DEMO, { tenant: "initech", name: "Ada Admin", role: "member" }, ...(signedIn.yes ? [GLOBEX] : [])] } }));
  await page.goto("/demo/activity");

  // when
  await page.getByRole("button", { name: "Organization: demo" }).click();
  await page.getByLabel("Sign in to another organization").fill("globex");
  await page.getByLabel("Sign in to another organization").press("Enter");

  // then
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("to globex")).toBeVisible();

  // when
  await page.getByLabel("Email").fill("gil@example.invalid");
  await page.getByLabel("Password").fill("a password long enough");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // then
  await expect(page).toHaveURL(/\/globex\/tasks$/);
  await expect(page.getByRole("button", { name: "Account: Gil Globex" })).toBeVisible();
  expect(asked).toEqual(expect.arrayContaining(["GET /me", "GET /auth/config", "POST /auth/login", "GET /repos", "GET /tasks"]));
});

test("given a task open in one organization, when another is picked, then its same section opens rather than a task it does not have", async ({ page, request }) => {
  // given
  await globex(page, { yes: true });
  const { csrf } = await (await request.get("/api/me")).json();
  const { task } = await (await request.post("/api/tasks", { data: { title: "Stay in demo", description: "", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json();
  await page.goto(`/demo/tasks/${task.id}`);

  // when
  await page.getByRole("button", { name: "Organization: demo" }).click();
  await page.getByRole("link", { name: /^Globex Corporation/ }).click();

  // then
  await expect(page).toHaveURL(/\/globex\/tasks$/);
});

test("given the cloud and one organization, when the picker opens, then it names the organization and offers a new one", async ({ page }) => {
  // given
  await page.route("**/api/orgs", (route) => route.fulfill({ json: { default: null, orgs: [{ ...DEMO, orgName: "Demo Payments" }] } }));
  // With no default organization every call goes under the organization's own prefix.
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud" } } });
  });
  await page.goto("/demo/activity");

  // when
  await page.getByRole("button", { name: "Organization: Demo Payments" }).click();

  // then
  await expect(page.getByRole("link", { name: "New organization" })).toHaveAttribute("href", "/signup/organization");
  await expect(page.getByLabel("Sign in to another organization")).toHaveCount(0);
});

test("given the cloud and an invitation waiting for the person, when it is accepted from the picker, then the organization it joins opens", async ({ page }) => {
  // given
  let accepted = "";
  await page.route("**/api/orgs", (route) => route.fulfill({ json: { default: null, orgs: [{ ...DEMO, orgName: "Demo Payments" }] } }));
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud" } } });
  });
  await page.route("**/api/me/orgs", (route) => route.fulfill({ json: { orgs: [{ tenant: "demo", orgName: "Demo Payments", role: "admin" }], invitations: [{ id: "globex:inv1", orgName: "Globex Corporation", invitedBy: "Gil Globex", role: "member", teams: [], expiresAt: "2026-11-09T00:00:00Z" }] } }));
  await page.route("**/api/identity", (route) => route.fulfill({ json: { identity: { email: "ada@example.invalid", name: "Ada Admin", signedInWith: "google" }, logins: [], memberships: [], csrf: "identity-csrf" } }));
  await page.route("**/api/me/invitations/*/accept", (route) => {
    accepted = `${decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!)} ${route.request().headers()["x-csrf-token"]}`;
    return route.fulfill({ json: { tenant: "globex", orgName: "Globex Corporation", next: "/globex/tasks" } });
  });
  await page.goto("/demo/activity");

  // when
  await page.getByRole("button", { name: "Organization: Demo Payments" }).click();
  await expect(page.getByText("Globex Corporation · member, from Gil Globex")).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();

  // then: the accept goes out after the identity is read, so the check waits for it rather than reading it at the click
  await expect.poll(() => accepted).toBe("globex:inv1 identity-csrf");
  await expect(page).toHaveURL(/\/globex\/tasks$/);
});
