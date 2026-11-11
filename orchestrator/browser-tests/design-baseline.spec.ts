import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { THEMES } from "./layout.js";
import { finishedTask } from "./screens.js";

// The screens the design critic has passed in the chosen direction, held to a picture of each: a change
// to how one looks shows as a changed picture in the request that makes it, and is accepted there or
// put right. A screen joins once it scores 8 of 8 and draws in one go; a width joins once nothing still
// open would move its pixels. Update after a deliberate change: npx playwright test
// browser-tests/design-baseline.spec.ts --update-snapshots, and review the pictures in the request.

interface Screen { name: string; widths: readonly number[]; open: (page: Page) => Promise<void>; moving: (page: Page) => Locator[] }

const SCREENS: Screen[] = [
  {
    name: "task",
    widths: [1440, 390],
    open: finishedTask,
    // When it started, how long it ran (in the rail and in the sentence under the title), and the request's
    // number, which counts the tasks run before it.
    moving: (p) => [p.getByText(/ by you$/), p.getByText(/^(\d+m )?\d+s$/), p.getByText(/^The agent (finished|stopped|ran) in /), p.getByText(/^(The change|Merge request|Pull request) /)],
  },
];

for (const screen of SCREENS) {
  for (const theme of THEMES) {
    test.describe(`the ${screen.name} screen in the ${theme} theme`, () => {
      test.use({ colorScheme: theme });
      // A finished task's page waits for the stand-in agent's whole run before its picture is taken.
      test.setTimeout(180_000);

      for (const width of screen.widths) {
        test(`given the ${screen.name} screen at ${width} pixels, when it is drawn, then it matches its picture`, async ({ page }) => {
          // given
          await page.setViewportSize({ width, height: 900 });
          await screen.open(page);
          await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });

          // A page that followed a live run ends scrolled to where the run was; the picture is of the page from its top.
          await page.evaluate(() => window.scrollTo(0, 0));

          // then: what moves with the clock or the run is masked; two shots in a row have to agree before one counts
          await expect(page).toHaveScreenshot(`${screen.name}-${theme}-${width}.png`, { fullPage: true, animations: "disabled", caret: "hide", mask: [page.locator("time"), ...screen.moving(page)] });
        });
      }
    });
  }
}
