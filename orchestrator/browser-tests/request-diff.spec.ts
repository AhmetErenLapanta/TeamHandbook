import { expect, test } from "@playwright/test";
import { standInChanges } from "./request-changes";

// A request's changes as the Requests page folds them, from a stand-in list and patches: a skill changed, its
// test added, an image, and a patch cut short.

test("given a request's diff, when Changes opens, then each file shows what it gains and loses, test files hide on request, and a cut or binary file says so", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [{ repoId: "payments-skills", number: 7, url: "https://gitlab.example/acme/payments-skills/-/merge_requests/7", branch: "handbook/orchestrator-7", title: "Tidy refunds", status: "merged", provider: "gitlab", createdAt: "2026-11-02T10:00:00Z", createdBy: "ada@example.invalid" }], total: 1, counts: { open: 0, merged: 1, closed: 0 }, pageSize: 50, next: null } }),
  );
  await standInChanges(page, "payments-skills", 7, [
    { path: "skills/refunds/SKILL.md", status: "modified", additions: 3, deletions: 1, patch: "@@ -1,2 +1,4 @@\n-old line\n+new line", truncated: true, note: "the patch passes 512 KB and is cut there" },
    { path: "skills/refunds/test/refunds.test.ts", status: "added", additions: 12, deletions: 0, test: true, patch: "+test" },
    { path: "skills/refunds/flow.png", status: "added", additions: null, deletions: null, binary: true, patch: null, note: "a binary file; its contents are not shown" },
  ], 2);
  await page.goto("/demo/repositories/payments-skills/requests");
  const row = page.getByRole("row", { name: /Tidy refunds/ });

  // when
  await row.getByText("Changes", { exact: true }).click();

  // then
  await expect(row).toContainText("3 files, +15 −1; 2 more not shown");
  await row.getByText("skills/refunds/SKILL.md").click();
  await expect(row.locator("pre.diff-patch").first()).toContainText("+new line");
  // each line carries its numbers before and after the change, and the patch's text carries the code alone
  const lines = row.locator("pre.diff-patch").first().locator(".diff-line");
  await expect(lines.nth(1).locator(".diff-num")).toHaveAttribute("data-old", "1");
  await expect(lines.nth(1).locator(".diff-num")).toHaveAttribute("data-new", "");
  await expect(lines.nth(2).locator(".diff-num")).toHaveAttribute("data-new", "1");
  await expect(row.locator("pre.diff-patch").first()).toHaveText("@@ -1,2 +1,4 @@-old line+new line");
  await expect(row).toContainText("The patch passes 512 KB and is cut there.");
  await row.getByText("skills/refunds/flow.png").click();
  await expect(row).toContainText("A binary file; its contents are not shown.");

  // when
  await row.getByLabel("Hide test files (1)").check();

  // then
  await expect(row.getByText("skills/refunds/test/refunds.test.ts")).toHaveCount(0);
});

test("given a request on a forge whose description holds Markdown and two images, when Description opens, then its parts render, an attached image comes through the orchestrator and one it does not read stays words", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [{ repoId: "payments-skills", number: 8, url: "https://gitlab.example/acme/payments-skills/-/merge_requests/8", branch: "handbook/orchestrator-8", title: "Show the flow", status: "open", provider: "gitlab", createdAt: "2026-11-02T10:00:00Z", createdBy: "ada@example.invalid" }], total: 1, counts: { open: 1, merged: 0, closed: 0 }, pageSize: 50, next: null } }),
  );
  await page.route("**/api/repos/payments-skills/requests/8/description", (route) =>
    route.fulfill({ json: { url: "https://gitlab.example/acme/payments-skills/-/merge_requests/8", description: "## What changed\n**Rounding** now goes half to even. <b>not bold</b>\n\n![flow](/uploads/ab12/flow.png) ![elsewhere](https://images.example/x.png)" } }),
  );
  const asked: string[] = [];
  await page.route("**/api/repos/payments-skills/media?*", (route) => {
    const src = new URL(route.request().url()).searchParams.get("src")!;
    asked.push(src);
    return src.startsWith("/uploads/")
      ? route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") })
      : route.fulfill({ status: 422, json: { error: "that is not an image attached on GitLab to payments-skills" } });
  });
  await page.goto("/demo/repositories/payments-skills/requests");
  const row = page.getByRole("row", { name: /Show the flow/ });

  // when
  await row.getByText("Description", { exact: true }).click();

  // then
  const text = row.locator(".markdown");
  await expect(text.getByRole("heading", { name: "What changed" })).toBeVisible();
  await expect(text.locator("strong")).toHaveText("Rounding");
  await expect(text).toContainText("<b>not bold</b>");
  await expect(text.getByRole("img", { name: "flow" })).toHaveAttribute("src", /\/media\?request=8&src=%2Fuploads%2Fab12%2Fflow\.png$/);
  await expect(text.getByRole("link", { name: "image: elsewhere" })).toHaveAttribute("href", "https://images.example/x.png");
  expect(asked.sort()).toEqual(["/uploads/ab12/flow.png", "https://images.example/x.png"]);
});

test("given a patch with a line longer than a phone is wide, when it is shown at 390, then its right edge says it goes on until it is scrolled to its end", async ({ page }) => {
  // given
  await page.setViewportSize({ width: 390, height: 800 });
  await page.route((url) => url.pathname === "/api/requests", (route) =>
    route.fulfill({ json: { requests: [{ repoId: "payments-skills", number: 8, url: "https://gitlab.example/acme/payments-skills/-/merge_requests/8", branch: "handbook/orchestrator-8", title: "Long lines", status: "merged", provider: "gitlab", createdAt: "2026-11-02T10:00:00Z", createdBy: "ada@example.invalid" }], total: 1, counts: { open: 0, merged: 1, closed: 0 }, pageSize: 50, next: null } }),
  );
  await standInChanges(page, "payments-skills", 8, [
    { path: "src/refund.ts", status: "modified", additions: 1, deletions: 1, patch: `@@ -1 +1 @@\n-const total = 1;\n+const total = sum(lines.map((line) => line.amount * line.quantity), order.currency, ${"x".repeat(80)});` },
  ], 1);
  await page.goto("/demo/repositories/payments-skills/requests");
  const row = page.getByRole("row", { name: /Long lines/ });

  // when
  await row.getByText("Changes", { exact: true }).click();
  await row.getByText("src/refund.ts").click();

  // then
  const box = row.locator(".patch-scroll").first();
  await expect(box).toHaveAttribute("data-more-right", "true");
  await box.locator("pre").evaluate((pre) => (pre.scrollLeft = pre.scrollWidth));
  await expect(box).not.toHaveAttribute("data-more-right", "true");
});
