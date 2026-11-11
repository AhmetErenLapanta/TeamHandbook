import { defineConfig } from "@playwright/test";

/**
 * The browser suite for an orchestrator in cloud mode: Postgres, the lab's stand-in Google, GitHub and
 * Microsoft, and the orchestrator at an https address the browser reaches through a route to its
 * port, so its secure cookies behave as they do in production. It needs ORCHESTRATOR_TEST_DATABASE_URL
 * and skips without it. Run: npx playwright test -c playwright.cloud.config.ts
 */
export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.cloud.ts",
  workers: 1,
  // Three browsers sign in through a provider each, and a loaded machine takes its time.
  timeout: 180_000,
  globalSetup: "./browser-tests/cloud-setup.ts",
  use: { baseURL: "https://orchestrator.example.invalid" },
});
