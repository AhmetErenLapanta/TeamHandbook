import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { buildHandbookHome, handbookPaths } from "./browser-tests/handbook-home.js";
import { buildScaleHome } from "./browser-tests/handbook-scale-home.js";
import type { HandbookHome } from "./browser-tests/handbook-home.js";

/**
 * The browser suite for the handbook visibility feature (Ek 26), an orchestrator in local mode on a stand-in person's
 * Claude Code home (browser-tests/handbook-home.ts) and a stand-in `claude` (stand-in-handbook-claude.mjs): two plugins,
 * one with a newer version in its marketplace, personal and folder skills, servers of three scopes, a hook and two skills
 * of one name. One server and one home for each width, since the scenarios change the person's setup and the 1440 run
 * must not meet what the 390 one left. The real ~/.claude is never touched: each home is built under a scratch directory
 * and the builder refuses any other. Run: npx playwright test -c playwright.handbook.config.ts
 * The steps of browser-tests/handbook-visibility.handbook.ts go green as the features land; until then each says what it waits for.
 */
const scale = Boolean(process.env.ORCHESTRATOR_E2E_HANDBOOK_SCALE);
const scratch = (process.env.ORCHESTRATOR_E2E_HANDBOOK_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-e2e-handbook-")));
const WIDTHS = [
  { name: "desktop", width: 1440, height: 900, port: Number(process.env.ORCHESTRATOR_E2E_HANDBOOK_PORT ?? 18191) },
  { name: "phone", width: 390, height: 844, port: Number(process.env.ORCHESTRATOR_E2E_HANDBOOK_PORT ?? 18191) + 1 },
] as const;

export interface HandbookServer extends HandbookHome {
  name: string;
  port: number;
  /** The file the orchestrator wrote the page of its one-time link to. */
  opened: string;
}

// A real agent CLI is never started: the two names refuse first on the PATH, whatever a code path asks for by name.
const trap = join(scratch, "trap");
mkdirSync(trap, { recursive: true });
for (const name of ["claude", "opencode"]) {
  writeFileSync(join(trap, name), `#!/bin/sh\necho "refused: a real ${name} must not start in the handbook suite" >&2\nexit 97\n`);
  chmodSync(join(trap, name), 0o755);
}

export const SERVERS: Record<string, HandbookServer> = {};
for (const w of WIDTHS) {
  const root = join(scratch, w.name);
  mkdirSync(root, { recursive: true });
  const opened = join(root, "opened");
  const browser = join(root, "browser.sh");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s' "$1" > '${opened}'\n`);
  chmodSync(browser, 0o755);
  // The workers load this file again: the homes are built, and the bundles made, by the first load alone.
  SERVERS[w.name] = { ...(process.env.ORCHESTRATOR_E2E_HANDBOOK_BUILT ? handbookPaths(root) : (scale ? buildScaleHome : buildHandbookHome)(root)), name: w.name, port: w.port, opened };
}

// The bundles are built from the sources under test first, once: a dist/ left from an earlier checkout serves an older page.
if (!process.env.ORCHESTRATOR_E2E_HANDBOOK_BUILT && !process.env.ORCHESTRATOR_E2E_HANDBOOK_NO_BUILD) execFileSync("npm", ["run", "build"], { stdio: "ignore" });
process.env.ORCHESTRATOR_E2E_HANDBOOK_BUILT = "1";

export default defineConfig({
  testDir: "browser-tests",
  testMatch: scale ? "**/*.scale.handbook.ts" : "**/*.handbook.ts",
  testIgnore: scale ? [] : "**/*.scale.handbook.ts",
  workers: 1,
  timeout: 120_000,
  projects: WIDTHS.map((w) => ({ name: w.name, use: { baseURL: `http://127.0.0.1:${w.port}`, viewport: { width: w.width, height: w.height } } })),
  webServer: WIDTHS.map((w) => {
    const server = SERVERS[w.name]!;
    return {
      command: "node dist/server.js",
      url: `http://127.0.0.1:${w.port}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        HOME: server.home,
        PATH: `${trap}:${process.env.PATH ?? ""}`,
        ORCHESTRATOR_MODE: "local",
        ORCHESTRATOR_PORT: String(w.port),
        BROWSER: join(server.root, "browser.sh"),
        ORCHESTRATOR_AGENTS: "claude-code",
        ORCHESTRATOR_CLAUDE_BIN: server.claude,
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      },
    };
  }),
});
