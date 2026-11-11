import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { stateFor } from "./roles.js";

const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

async function openRemoval(page: Page, row: string): Promise<void> {
  // A skill is listed under Skills and a server under MCP servers.
  await page.goto(`/demo/repositories/payments-skills/${row === "postgres" || row === "docs" ? "mcp" : "skills"}`);
  await page.getByRole("row", { name: new RegExp(`^${row}`) }).getByRole("button", { name: "Remove" }).click();
}

/** Keeps a save off the shared demo repositories; the proposal before it is the orchestrator's own. */
async function captureSave(page: Page): Promise<() => Record<string, unknown> | null> {
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/policies", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { saved: "request", id: "pol_x", requests: [{ repoId: "payments-skills", number: 51, url: "https://forge.example.invalid/payments/51", branch: "b", title: "PAY chore: add the team policy Disable postgres", status: "open", provider: "gitlab", createdAt: "2026-10-25T00:00:00.000Z", createdBy: "ada@example.invalid" }], failed: [] } });
  });
  return () => sent;
}

const region = (page: Page) => page.getByRole("region", { name: "What this removal takes away" });

test.describe("what removing a skill or a server takes away", () => {
  test("given a skill from a team that does not report use, when its removal opens, then it says who loses it and that use is not counted", async ({ page }) => {
    // when
    await openRemoval(page, "release-checklist");

    // then
    await expect(region(page)).toContainText("Teammates on Payments lose release-checklist once the request is merged.");
    await expect(region(page)).toContainText("This team does not report skill use, so recent use is not counted.");
    await expect(region(page)).not.toContainText("No reported use");
  });

  test("given a skill a reporting team used, when its removal opens, then it gives the count and the last day", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/removal?*", async (route) => {
      const real = await (await route.fetch()).json();
      return route.fulfill({ json: { ...real, usage: { counted: true, days: 30, count: 12, lastHour: "2026-10-23T09", daily: [] } } });
    });

    // when
    await openRemoval(page, "release-checklist");

    // then
    await expect(region(page)).toContainText("Used 12 times in the last 30 days, last on 2026-10-23.");
  });

  test("given a server, when Disable instead is chosen and confirmed, then the orchestrator's own draft is saved as it stands and the request it opened is linked", async ({ page }) => {
    // given
    const sent = await captureSave(page);
    await openRemoval(page, "postgres");
    await expect(region(page)).toContainText("Teammates on Payments lose postgres once the request is merged.");
    const draft = (await (await page.request.get("/api/repos/payments-skills/removal?mcp=postgres")).json()).disable;

    // when
    await region(page).getByRole("button", { name: "Disable instead" }).click();
    const confirm = page.getByRole("region", { name: /^Disable postgres as/ });
    await expect(confirm.getByLabel("Commit message")).not.toHaveValue("");
    await confirm.getByLabel("Commit message").press("Enter");
    await expect(page.getByRole("button", { name: "Review removing postgres" })).toBeVisible();
    await confirm.getByRole("button", { name: /^Open (the request|\d+ requests)$/ }).click();

    // then
    await expect(page.getByRole("link", { name: "payments-skills #51" })).toBeVisible();
    expect(sent()!.policy).toEqual(draft);
    expect(sent()!.message).toBeTruthy();
  });

  test("given a server a policy already blocks, when its removal opens, then it names that policy and offers no second block", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/removal?*", async (route) => {
      const real = await (await route.fetch()).json();
      return route.fulfill({ json: { ...real, blockedBy: [{ id: "pol_000000002bbbbbbbb", name: "Retire postgres" }], disable: null } });
    });

    // when
    await openRemoval(page, "postgres");

    // then
    await expect(region(page).getByRole("link", { name: "Retire postgres" })).toHaveAttribute("href", "/demo/team/policies/pol_000000002bbbbbbbb");
    await expect(region(page).getByRole("button", { name: "Disable instead" })).toHaveCount(0);
  });
});

test.describe("a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when the impact is read, then the orchestrator refuses it", async ({ page }) => {
    // when
    const res = await page.request.get("/api/repos/payments-skills/removal?mcp=postgres");

    // then
    expect(res.status()).toBe(403);
  });
});

for (const theme of ["light", "dark"] as const) {
  test.describe(`the removal impact in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });
    test("given a server's removal and its disable confirmation, when each is checked, then axe finds no violation", async ({ page }) => {
      // given
      await openRemoval(page, "postgres");
      await expect(region(page).getByRole("button", { name: "Disable instead" })).toBeVisible();
      const before = await new AxeBuilder({ page }).withTags(RULES).analyze();

      // when
      await region(page).getByRole("button", { name: "Disable instead" }).click();
      await expect(page.getByRole("region", { name: /^Disable postgres as/ })).toBeVisible();
      const after = await new AxeBuilder({ page }).withTags(RULES).analyze();

      // then
      const found = [...before.violations, ...after.violations].flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
      expect(found).toEqual([]);
    });
  });
}

test.describe("the removal impact at 390 pixels wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("given a server's disable confirmation, when it is read on a phone, then the page does not scroll sideways", async ({ page }) => {
    // given
    await openRemoval(page, "postgres");
    await region(page).getByRole("button", { name: "Disable instead" }).click();
    await expect(page.getByRole("region", { name: /^Disable postgres as/ })).toBeVisible();

    // when
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));

    // then
    expect(widths.page).toBeLessThanOrEqual(widths.view);
  });
});
