import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { choose } from "./task-form.js";

// The suite's orchestrator is self-hosted and answers no identity path; the operator's page is driven
// with a cloud orchestrator's answers stood in for. Who is an operator is checked in server/operator.test.ts.

const CONFIG = { providers: ["google", "github"], privacyUrl: "http://127.0.0.1:3050/en/privacy", termsUrl: "http://127.0.0.1:3050/en/terms", signupOpen: true, helpUrl: null };
const FUNNEL = {
  days: 30,
  keptDays: 90,
  counts: { "signed up": 3, "created an organization": 2, "connected a forge": 1, "started a first task": 1, "merged a first request": 0 },
  people: [
    { identityId: "idn_1", provider: "google", emailDomain: "okafor-labs.example.invalid", signedUpAt: "2026-11-01T09:00:00.000Z", orgCreated: { tenant: "okafor-labs", at: "2026-11-01T09:05:00.000Z" }, viaInvite: false, lastStep: "started a first task" },
    { identityId: "idn_2", provider: "github", emailDomain: "ortiz-builds.example.invalid", signedUpAt: "2026-11-02T10:00:00.000Z", orgCreated: null, viaInvite: false, lastStep: "signed up" },
    { identityId: "idn_3", provider: "github", emailDomain: "okafor-labs.example.invalid", signedUpAt: "2026-11-02T11:00:00.000Z", orgCreated: null, viaInvite: true, lastStep: "signed up" },
  ],
};

async function cloud(page: Page, answer: { status: number; json: unknown }): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/identity/config", (route) => route.fulfill({ json: CONFIG }));
  await page.route("**/api/operator/funnel?*", (route) => {
    asked.push(new URL(route.request().url()).search);
    return route.fulfill(answer);
  });
  return asked;
}

test("given an operator, when the page opens, then it counts each step and lists every signup by its domain, and a shorter window asks again", async ({ page }) => {
  // given
  const asked = await cloud(page, { status: 200, json: FUNNEL });

  // when
  await page.goto("/operator");

  // then
  await expect(page.getByRole("heading", { level: 1, name: "Signups" })).toBeVisible();
  await expect(page.getByRole("region", { name: "How far they got" })).toContainText("created an organization2");
  const rows = page.getByRole("region", { name: /^Signups/ }).getByRole("row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("okafor-labs.example.invalid/okafor-labs, created 2026-11-01started a first task");
  await expect(rows.nth(3)).toContainText("joined by invitation");
  await expect(page.getByText(/@/)).toHaveCount(0);

  // when
  await choose(page.getByRole("main"), "Signed up in the last", "7 days");

  // then
  await expect.poll(() => asked).toEqual(["?days=30", "?days=7"]);
});

test("given someone who is not an operator, when they open the page, then it reads as an address with no page and names nothing about signups", async ({ page }) => {
  // given
  await cloud(page, { status: 404, json: { error: "not found" } });

  // when
  await page.goto("/operator");

  // then
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByText("Signups")).toHaveCount(0);
});
