import { expect, test } from "@playwright/test";
import { stateFor } from "./roles.js";

test.describe("as a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when Tasks opens, then no way to add or remove a repository is offered", async ({ page }) => {
    // when
    await page.goto("/demo/tasks");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
    await expect(page.getByRole("button", { name: "Add a repository" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  });
});
