import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * The browser suite for an orchestrator in local mode, one person on their own machine: started with
 * nothing configured, in a home of its own with no git identity, so it makes its own owner and opens a
 * one-time link instead of a sign-in screen. The browser it would open is a script that writes down the
 * page it was handed; a spec reads the link from that page. Run: npx playwright test -c playwright.local.config.ts
 */
const scratch = (process.env.ORCHESTRATOR_E2E_LOCAL_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-e2e-local-")));
const port = Number(process.env.ORCHESTRATOR_E2E_LOCAL_PORT ?? 18281);
// The README picture is taken in a stand-in home, since the scratch home sits under the temp folder and its path would show.
export const HOME = process.env.ORCHESTRATOR_E2E_LOCAL_HOME ?? join(scratch, "home");
export const OPENED = join(scratch, "opened");
const browser = join(scratch, "browser.sh");
mkdirSync(HOME, { recursive: true });
writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > '${OPENED}'\n`);
chmodSync(browser, 0o755);
if (process.env.ORCHESTRATOR_E2E_SCREENSHOTS) writeFileSync(join(HOME, ".stand-in-signed-in"), "");

export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.local.ts",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "npm run build && node dist/server.js",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: {
      HOME,
      PATH: process.env.PATH ?? "",
      ORCHESTRATOR_MODE: "local",
      ORCHESTRATOR_PORT: String(port),
      BROWSER: browser,
      // The suite's readiness stand-in, and no other agent: no real agent CLI is started, not even to ask its version.
      ORCHESTRATOR_AGENTS: "claude-code",
      ORCHESTRATOR_CLAUDE_BIN: fileURLToPath(new URL("./browser-tests/stand-in-claude.sh", import.meta.url)),
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
  },
});
