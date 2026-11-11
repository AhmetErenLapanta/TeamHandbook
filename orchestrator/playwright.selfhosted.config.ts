import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// A self-hosted orchestrator as one person runs it on their own machine with no mode set: dev-admin
// sign-in, a public address on this machine, a secret key and server tasks, as a user's own setup
// had it when the forge cards asked for an OAuth application. Its specs end in .selfhosted.ts so no
// other suite runs them. The person's gh and glab are stand-ins first on PATH: nothing reaches a forge.
const scratch = (process.env.ORCHESTRATOR_E2E_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-selfhosted-")));
const port = Number(process.env.ORCHESTRATOR_E2E_PORT ?? 18196);
// The person's home, where the stand-in gh and glab keep whether they are signed in.
mkdirSync(join(scratch, "home"), { recursive: true });

export default defineConfig({
  testDir: "browser-tests",
  testMatch: "**/*.selfhosted.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `npm run build && node dist/seed.js ${scratch}/demo && node dist/server.js`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      ORCHESTRATOR_AUTH: "dev-admin",
      ORCHESTRATOR_PUBLIC_URL: `http://127.0.0.1:${port}`,
      ORCHESTRATOR_PORT: String(port),
      ORCHESTRATOR_SECRET_KEY: "0".repeat(64),
      ORCHESTRATOR_SERVER_TASKS: "1",
      ORCHESTRATOR_CONFIG: `${scratch}/demo/orchestrator.json`,
      ORCHESTRATOR_DATA_DIR: `${scratch}/data`,
      // The stand-in agent alone: no real agent CLI is started, not even to ask its version.
      ORCHESTRATOR_AGENTS: "fake",
      HOME: `${scratch}/home`,
      PATH: `${fileURLToPath(new URL("./browser-tests/stand-in-cli", import.meta.url))}:${process.env.PATH ?? ""}`,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    },
  },
});
