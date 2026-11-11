import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

/**
 * Personal and Team side by side, for the test that holds the main screens to one layout in both: one
 * person's own orchestrator (local, signed in by its one-time link) and a team's (self-hosted, the demo
 * organization, its dev admin). The stand-in agent alone and the suite's gh and glab stand-ins first on
 * PATH on both, so no agent CLI starts and nothing reaches a forge. One build serves both servers: the
 * team's command builds and marks it, the person's waits for the mark, since two builds in one folder
 * would write over each other's bundle.
 * Run: npx playwright test -c playwright.experiences.config.ts
 */
const scratch = (process.env.ORCHESTRATOR_E2E_EXPERIENCES_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-e2e-experiences-")));
const teamPort = Number(process.env.ORCHESTRATOR_E2E_EXPERIENCES_TEAM_PORT ?? 18184);
const personalPort = Number(process.env.ORCHESTRATOR_E2E_EXPERIENCES_PERSONAL_PORT ?? 18185);
export const TEAM_URL = `http://127.0.0.1:${teamPort}`;
export const PERSONAL_URL = `http://127.0.0.1:${personalPort}`;
export const PERSONAL_HOME = join(scratch, "personal-home");
export const OPENED = join(scratch, "opened");
const built = join(scratch, "built");
const browser = join(scratch, "browser.sh");
mkdirSync(PERSONAL_HOME, { recursive: true });
mkdirSync(join(scratch, "team-home"), { recursive: true });
writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > '${OPENED}'\n`);
chmodSync(browser, 0o755);
const standInPath = `${fileURLToPath(new URL("./browser-tests/stand-in-cli", import.meta.url))}:${process.env.PATH ?? ""}`;

export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.experiences.ts",
  workers: 1,
  timeout: 300_000,
  webServer: [
    {
      command: `npm run build && touch ${built} && node dist/seed.js ${scratch}/demo && node dist/server.js`,
      url: `${TEAM_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        ORCHESTRATOR_AUTH: "dev-admin",
        ORCHESTRATOR_PUBLIC_URL: TEAM_URL,
        ORCHESTRATOR_PORT: String(teamPort),
        ORCHESTRATOR_SECRET_KEY: "0".repeat(64),
        ORCHESTRATOR_SERVER_TASKS: "1",
        ORCHESTRATOR_CONFIG: `${scratch}/demo/orchestrator.json`,
        ORCHESTRATOR_DATA_DIR: `${scratch}/team-data`,
        ORCHESTRATOR_AGENTS: "fake",
        HOME: join(scratch, "team-home"),
        PATH: standInPath,
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      },
    },
    {
      command: `sh -c 'until [ -f ${built} ]; do sleep 1; done; exec node dist/server.js'`,
      url: `${PERSONAL_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        HOME: PERSONAL_HOME,
        PATH: standInPath,
        ORCHESTRATOR_MODE: "local",
        ORCHESTRATOR_PORT: String(personalPort),
        BROWSER: browser,
        ORCHESTRATOR_AGENTS: "fake",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      },
    },
  ],
});
