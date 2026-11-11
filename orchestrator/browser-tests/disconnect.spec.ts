import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { openTab } from "./repo-tabs.js";
import { stateFor } from "./roles.js";

// Who may disconnect a repository is the orchestrator's own answer here; the page around a
// repository the configuration no longer lists is shown with that answer stood in for, since
// the suite's orchestrator lists every repository it has.

async function disconnect(request: APIRequestContext, id: string) {
  const { csrf } = await (await request.get("/api/me")).json();
  return request.delete(`/api/repos/${id}`, { headers: { "x-csrf-token": csrf } });
}

/** platform-skills as a repository the configuration no longer lists; `gone` after a disconnect the page asked for. */
async function platformOutOfConfiguration(page: Page): Promise<{ asked: () => number }> {
  let gone = false;
  let asked = 0;
  await page.route("**/api/repos", async (route) => {
    const body = await (await route.fetch()).json();
    body.repos = body.repos.flatMap((r: { id: string }) => (r.id !== "platform-skills" ? [r] : gone ? [] : [{ ...r, configured: false }]));
    await route.fulfill({ json: body });
  });
  await page.route("**/api/repos/platform-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, repo: { ...body.repo, configured: false } } });
  });
  await page.route("**/api/repos/platform-skills", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    asked++;
    gone = true;
    return route.fulfill({ json: { disconnected: "platform-skills" } });
  });
  return { asked: () => asked };
}

test.describe("for a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member with a valid CSRF token, when they ask to disconnect a repository, then the orchestrator refuses", async ({ page }) => {
    // when
    const res = await disconnect(page.request, "platform-skills");

    // then
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe("only an owner or an admin disconnects a repository");
  });

  test("given a repository out of the configuration, when a member opens it, then they read why and are offered no disconnect", async ({ page }) => {
    // given
    await platformOutOfConfiguration(page);

    // when
    await page.goto("/demo/repositories/platform-skills");

    // then
    await expect(page.getByRole("region", { name: "Not in the configuration" })).toContainText("so it is not synced or changed");
    await expect(page.getByText("An admin can disconnect it.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Disconnect/ })).toHaveCount(0);
  });
});

test("given a repository the configuration still lists, when an admin asks to disconnect it, then the orchestrator refuses and says why", async ({ page }) => {
  // when
  const res = await disconnect(page.request, "platform-skills");

  // then
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe("remove it from ORCHESTRATOR_CONFIG first; a repository the file lists is connected again at the next start");
});

test("given a repository out of the configuration, when an admin disconnects it after confirming, then it leaves the repository list and no edit was offered meanwhile", async ({ page }) => {
  // given
  const disconnects = await platformOutOfConfiguration(page);
  await page.goto("/demo/repositories/platform-skills");
  await openTab(page, "platform-skills", "Skills");
  await expect(page.getByRole("cell", { name: "rotate-service-certificate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a skill" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);

  // when the first step is taken and taken back
  await page.getByRole("button", { name: "Disconnect project" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();

  // then nothing was asked of the orchestrator
  expect(disconnects.asked()).toBe(0);

  // when it is confirmed
  await page.getByRole("button", { name: "Disconnect project" }).click();
  await expect(page.getByText("The team's repository is not touched")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect platform-skills" }).click();

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");

  expect(disconnects.asked()).toBe(1);
});
