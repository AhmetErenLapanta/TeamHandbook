import { expect, test } from "@playwright/test";

test("given a task started with a team skill, when it ends, then the task page's rail closes with Learned saying the skill it started with, not one it used", async ({ page, request }) => {
  // given
  const { csrf } = await (await request.get("/api/me")).json();
  const started = await request.post("/api/tasks", { data: { title: "Add a ledger column", description: "", repoId: "payments-skills", agent: "fake", skills: ["add-ledger-migration"] }, headers: { "x-csrf-token": csrf } });
  const { task } = await started.json();

  // when
  await page.goto(`/demo/tasks/${task.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });

  // then
  const rail = page.getByRole("complementary", { name: "About this task" });
  const learned = rail.getByRole("region", { name: "Learned" });
  await expect(learned).toContainText("Started with 1 team skill.");
  await expect(rail.locator("section").last()).toHaveAttribute("aria-labelledby", "task-learned-h");
  await expect(learned).not.toContainText("Used");
});
