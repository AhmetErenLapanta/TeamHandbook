import { expect, test } from "@playwright/test";

test.describe("how long skill use is kept", () => {
  test("given an admin on Privacy, when they keep skill use 120 days, then it says older counts go now and the page keeps the value after a reload", async ({ page }) => {
    // given
    await page.goto("/demo/settings/privacy");
    const form = page.getByRole("form", { name: "Skill use retention" });
    await expect(form.getByLabel("Days to keep skill use")).toHaveValue("365");

    try {
      // when
      await form.getByLabel("Days to keep skill use").fill("120");
      await form.getByRole("button", { name: "Save" }).click();

      // then
      await expect(page.getByRole("status")).toHaveText("Skill use is kept 120 days; older counts are deleted now.");
      await page.reload();
      await expect(page.getByRole("form", { name: "Skill use retention" }).getByLabel("Days to keep skill use")).toHaveValue("120");
    } finally {
      const { csrf } = await (await page.request.get("/api/me")).json();
      await page.request.put("/api/privacy", { data: { usageDays: 365 }, headers: { "x-csrf-token": csrf } });
    }
  });

  test("given a retention shorter than the longest range Usage shows, when it is sent, then the orchestrator refuses it and keeps the year", async ({ page }) => {
    // given
    await page.goto("/demo/settings/privacy");
    const { csrf } = await (await page.request.get("/api/me")).json();

    // when
    const res = await page.request.put("/api/privacy", { data: { usageDays: 30 }, headers: { "x-csrf-token": csrf } });

    // then
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("skill use is kept 90 to 3650 days");
    expect((await (await page.request.get("/api/privacy")).json()).privacy.usageDays).toBe(365);
  });
});
