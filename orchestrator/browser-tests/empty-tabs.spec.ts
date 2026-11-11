import { expect, test } from "@playwright/test";
import { openTab } from "./repo-tabs.js";
import { stateFor } from "./roles.js";

// A repository that shares nothing yet, from the orchestrator's own inventory with its skills and
// servers left out: each tab says so in one sentence and offers the one thing to do about it.

async function sharingNothing(page: import("@playwright/test").Page): Promise<void> {
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, inventory: { ...body.inventory, skills: [], mcpServers: [] } } });
  });
}

test("given a repository with no skill and no server, when its owner opens the Skills and MCP servers tabs, then each says so and its one button opens the form", async ({ page }) => {
  // given
  await sharingNothing(page);
  await page.goto("/demo/repositories/payments-skills");

  // when
  await openTab(page, "payments-skills", "Skills");

  // then
  const skills = page.getByRole("region", { name: /^Skills/ });
  await expect(skills).toContainText("No skill is shared here yet; the first one reaches teammates once its request is merged.");
  await expect(skills.getByRole("button", { name: "Add a skill" })).toHaveCount(1);
  await expect(skills.getByRole("table")).toHaveCount(0);
  await skills.getByRole("button", { name: "Add a skill" }).click();
  await expect(skills.locator("form.editor")).toBeVisible();

  // when
  await openTab(page, "payments-skills", "MCP servers");

  // then
  const servers = page.getByRole("region", { name: /^MCP servers/ });
  await expect(servers).toContainText("No MCP server is shared here yet;");
  await expect(servers.getByRole("button", { name: "Add a server" })).toHaveCount(1);
});

test.describe("a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member and a repository with no skill, when the Skills tab opens, then it says who adds the first one and offers no button", async ({ page }) => {
    // given
    await sharingNothing(page);
    await page.goto("/demo/repositories/payments-skills");

    // when
    await openTab(page, "payments-skills", "Skills");

    // then
    const skills = page.getByRole("region", { name: /^Skills/ });
    await expect(skills).toContainText("No skill is shared here yet; an owner of Payments adds the first one.");
    await expect(skills.getByRole("button", { name: "Add a skill" })).toHaveCount(0);
  });
});
