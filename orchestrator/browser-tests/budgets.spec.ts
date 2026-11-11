import { expect, test } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work } from "./task-form.js";
import type { Page } from "@playwright/test";
import type { CurrentBudgets } from "../shared/activity.js";

async function budgets(page: Page, answer: CurrentBudgets): Promise<void> {
  await page.route("**/api/policies/current-budgets", (route) => route.fulfill({ json: answer }));
}

test("given a member budget with money left and a shared one, when the task form opens, then each says what is left and the form starts tasks", async ({ page }) => {
  // given
  await budgets(page, {
    month: "2026-10",
    budgets: [
      { policyId: "pol_1", policy: "Task allowance per member", per: "member", monthlyUsd: 20, spentUsd: 7.5, leftUsd: 12.5, reached: false, unknownCost: 2 },
      { policyId: "pol_2", policy: "Monthly task budget", per: "audience", monthlyUsd: 100, spentUsd: 40, leftUsd: 60, reached: false, unknownCost: 0 },
    ],
  });

  // when
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  const listed = page.getByRole("list", { name: "Task budgets" });
  // one sentence a budget; the policy and the costs it cannot count wait behind its hint
  await expect(listed.getByRole("listitem").nth(0)).toContainText("Monthly budget left $12.50 of $20.00 for you.");
  await expect(listed.getByRole("listitem").nth(0).locator("details.hint")).toContainText("Under Task allowance per member. 2 tasks this month reported no cost and are not counted.");
  await expect(listed.getByRole("listitem").nth(1)).toContainText("Monthly budget left $60.00 of $100.00, shared.");
  await expect(listed.getByRole("listitem").nth(1).locator("details.hint")).toContainText("Under Monthly task budget.");
  await work(form, "Within budget");
  await expect(page.getByRole("button", { name: "Start task" })).toBeEnabled();
});

test("given a budget reached this month, when the task form opens, then it says when tasks start again and Start task stays off", async ({ page }) => {
  // given
  await budgets(page, {
    month: "2026-10",
    budgets: [{ policyId: "pol_1", policy: "Task allowance per member", per: "member", monthlyUsd: 20, spentUsd: 21.4, leftUsd: 0, reached: true, unknownCost: 0 }],
  });

  // when
  await page.goto("/demo/tasks");
  await work(await newTaskForm(page), "Over budget");

  // then
  const reached = page.getByRole("list", { name: "Task budgets" });
  await expect(reached).toContainText("Budget reached Tasks start again on November 1.");
  await expect(reached.locator("details.hint")).toContainText("$21.40 of $20.00 spent this month by you under Task allowance per member.");
  await expect(page.getByRole("button", { name: "Start task" })).toBeDisabled();
});

test("given no budget applies, when the task form opens, then it shows no budget line", async ({ page }) => {
  // given
  await budgets(page, { month: "2026-10", budgets: [] });

  // when
  await page.goto("/demo/tasks");

  // then
  await expect(await newTaskForm(page)).toBeVisible();
  await expect(page.getByRole("list", { name: "Task budgets" })).toHaveCount(0);
});
