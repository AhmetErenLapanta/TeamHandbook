import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * One person's orchestrator over a single working folder that holds several repositories, with the
 * demo agent and nothing else: a task there runs in the folder and its review shows each repository
 * the agent changed. A server of its own, since it opens its folder as the first and only project.
 * Run: npx playwright test -c playwright.folder.config.ts
 */
const scratch = (process.env.ORCHESTRATOR_E2E_FOLDER_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-e2e-folder-")));
const port = Number(process.env.ORCHESTRATOR_E2E_FOLDER_PORT ?? 18282);
export const HOME = join(scratch, "home");
export const OPENED = join(scratch, "opened");
const browser = join(scratch, "browser.sh");
mkdirSync(HOME, { recursive: true });
writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > '${OPENED}'\n`);
chmodSync(browser, 0o755);

export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.folder.ts",
  workers: 1,
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: "npm run build && node dist/server.js",
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      HOME,
      // The suite's gh and glab stand-ins come first, so a request never reaches a real forge.
      PATH: `${fileURLToPath(new URL("./browser-tests/stand-in-cli", import.meta.url))}:${process.env.PATH ?? ""}`,
      ORCHESTRATOR_MODE: "local",
      ORCHESTRATOR_PORT: String(port),
      BROWSER: browser,
      ORCHESTRATOR_AGENTS: "fake",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
  },
});
