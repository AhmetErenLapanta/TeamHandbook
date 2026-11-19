import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * How long each main screen takes on a slow machine: the first thing drawn, and the moment its own heading is there and
 * nothing on it still says it is loading. The machine is slowed the way a slow laptop on a slow line is: the CPU four
 * times slower, 150 ms to the server and 1.6 Mbps down. A screen that passes its budget today and slows past it fails here.
 */
const SCREENS = ["tasks", "work", "team", "integrations", "settings"] as const;
const WIDTHS = [1440, 390] as const;
const FIRST_DRAWN_MS = Number(process.env.ORCHESTRATOR_E2E_FIRST_DRAWN_MS ?? 2500);
const READY_MS = Number(process.env.ORCHESTRATOR_E2E_READY_MS ?? 4500);

async function slowMachine(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
}

for (const width of WIDTHS) {
  for (const screen of SCREENS) {
    test(`given a slow machine at ${width} pixels, when ${screen} opens, then its first draw and its ready moment stay within the budget`, async ({ page }) => {
      // given
      await page.setViewportSize({ width, height: 900 });
      await slowMachine(page);

      // when
      const began = Date.now();
      await page.goto(`/demo/${screen}`, { waitUntil: "commit" });
      await page.waitForFunction(() => performance.getEntriesByName("first-contentful-paint").length > 0, undefined, { timeout: 30_000 });
      const firstDrawn = Date.now() - began;
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^Loading /)).toHaveCount(0, { timeout: 30_000 });
      const ready = Date.now() - began;
      test.info().annotations.push({ type: "timing", description: `${screen} ${width}: first drawn ${firstDrawn} ms, ready ${ready} ms` });

      // then
      expect(firstDrawn, `${screen} at ${width}: first draw`).toBeLessThan(FIRST_DRAWN_MS);
      expect(ready, `${screen} at ${width}: ready`).toBeLessThan(READY_MS);
    });
  }
}

test("given the page's script and styles, when they are asked for, then they come compressed and an API answer is not recompressed", async ({ request, page }) => {
  // given
  await page.goto("/demo/tasks");
  const html = await (await request.get("/demo/tasks")).text();
  const asset = /\/assets\/[^"']+\.js/.exec(html)![0];

  // when
  const script = await request.get(asset, { headers: { "accept-encoding": "gzip" }, failOnStatusCode: true });
  const api = await request.get("/api/health", { headers: { "accept-encoding": "gzip" } });

  // then
  expect(script.headers()["content-encoding"]).toBe("gzip");
  expect(api.headers()["content-encoding"]).toBeUndefined();
});

