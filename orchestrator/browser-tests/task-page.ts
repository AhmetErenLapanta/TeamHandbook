import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * A task's log as its person reads it: the fold opened by hand, so the page remembers it open and
 * keeps it open when the task ends and its changes take the page.
 */
export async function taskLog(page: Page): Promise<Locator> {
  // The run's own fold, "How the agent got here", is a log fold too; the log is the one named Log.
  const fold = page.locator("details.log-fold").filter({ has: page.locator("summary", { hasText: /^Log/ }) });
  const summary = fold.locator(":scope > summary");
  await fold.waitFor();
  // Two clicks in a row reach the page as one toggle, which changes nothing it remembers; each waits for its own.
  if (await fold.evaluate((d) => (d as HTMLDetailsElement).open)) {
    await summary.click();
    await expect(fold).not.toHaveAttribute("open");
  }
  await summary.click();
  await expect(fold).toHaveAttribute("open", "");
  return page.getByRole("log", { name: "Task log" });
}
