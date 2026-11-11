import { expect, test } from "@playwright/test";

test("given a push delivery whose token is not the repository's webhook secret, when it arrives, then it is not taken", async ({ page }) => {
  // given
  await page.goto("/demo/activity");
  const request = page.request;
  const push = { ref: "refs/heads/main" };

  // when
  const unknown = await request.post("/api/hooks/forge/payments-skills", { data: push, headers: { "x-gitlab-event": "Push Hook", "x-gitlab-token": "not-the-secret-0000000000" } });

  // then
  expect([404, 401]).toContain(unknown.status());
});
