import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { UsageReport } from "../shared/activity.js";
import { stateFor } from "./roles.js";

/** The report the orchestrator answers a team's owner with: the organization's totals, and only their team broken down. */
async function ownTeamUse(page: Page, byTeam: UsageReport["byTeam"]): Promise<void> {
  const series = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.parse("2026-10-23T12:00:00Z") - (29 - i) * 86_400_000).toISOString().slice(0, 10), count: i % 3 }));
  const report: UsageReport = {
    days: 30,
    series,
    total: series.reduce((n, d) => n + d.count, 0),
    byTeam,
    bySkill: byTeam.length ? [{ repoId: "payments-skills", repo: "payments-skills", team: "Payments", skill: "release-checklist", count: byTeam[0]!.count }] : [],
    scope: { teams: ["Payments"] },
  };
  await page.route(/\/api\/activity\/usage(\?|$)/, (route) => route.fulfill({ json: report }));
}

test.describe("a team's owner reading skill use", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given use broken down for their own team, when Usage opens, then it says the breakdown is their team's and offers the export", async ({ page }) => {
    // given
    await ownTeamUse(page, [{ team: "Payments", count: 9 }]);

    // when
    await page.goto("/demo/activity/usage");

    // then
    await expect(page.getByText("By team and by skill for the teams you own: Payments. Owners and admins see every team.")).toBeVisible();
    await expect(page.getByRole("region", { name: "By team" })).toContainText("Payments");
    await expect(page.getByRole("region", { name: "By team" })).not.toContainText("Platform");
    await expect(page.getByRole("link", { name: "Export CSV" })).toBeVisible();
  });

  test("given their team reported nothing, when Usage opens, then it says so instead of pointing them at owners and admins", async ({ page }) => {
    // given
    await ownTeamUse(page, []);

    // when
    await page.goto("/demo/activity/usage");

    // then
    await expect(page.getByText("The teams you own (Payments) reported no skill use in this range.")).toBeVisible();
    await expect(page.getByText("Owners and admins see use by team and by skill")).toHaveCount(0);
  });

  test("given the orchestrator's own leaderboard, when a team's owner opens it, then it answers with their teams rather than refusing", async ({ page }) => {
    // when
    await page.goto("/demo/activity/leaderboard");

    // then
    await expect(page.getByText("Ranked among the teams you own: Payments. Owners and admins see every team.")).toBeVisible();
    await expect(page.getByText(/The leaderboard is shown to owners and admins/)).toHaveCount(0);
  });

  test("given the orchestrator's own export, when a team's owner asks for another team's repository, then no row of it comes back", async ({ page }) => {
    // when
    const res = await page.request.get("/api/activity/usage/export?days=30&format=json&repo=platform-skills");

    // then
    expect(res.status()).toBe(200);
    expect((await res.json()).rows).toEqual([]);
  });
});

test.describe("a member who owns no team", () => {
  test.use({ storageState: stateFor("member") });

  test("given the orchestrator's own export and leaderboard, when a member asks, then both are refused", async ({ page }) => {
    // when
    const exported = await page.request.get("/api/activity/usage/export?days=30&format=csv");
    const board = await page.request.get("/api/activity/leaderboard?days=30");

    // then
    expect(exported.status()).toBe(403);
    expect(board.status()).toBe(403);
  });

  test("given the repository usage list and one repository's daily use, when a member asks, then no count comes back and the daily read is refused", async ({ page }) => {
    // when
    const list = await (await page.request.get("/api/usage?repo=payments-skills")).json();
    const daily = await page.request.get("/api/activity/usage?days=30&repo=payments-skills");

    // then
    expect([list.usage, list.shown]).toEqual([[], false]);
    expect(daily.status()).toBe(403);
  });
});
