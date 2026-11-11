import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// Each run seeds its own demo repositories and data directory, so a run never reads a
// previous run's state or a developer's own orchestrator data.
// Workers evaluate this file again; they inherit the main process's environment, so the
// directory is chosen once and handed down rather than drawn anew in each worker.
const scratch = (process.env.ORCHESTRATOR_E2E_SCRATCH ??= mkdtempSync(join(tmpdir(), "orchestrator-e2e-")));
const port = Number(process.env.ORCHESTRATOR_E2E_PORT ?? 18181);

// ORCHESTRATOR_E2E_BASE_URL points the suite at an orchestrator already running - the docker compose
// stack, for one - instead of starting its own.
const external = process.env.ORCHESTRATOR_E2E_BASE_URL;

// The suite signs in for real: global-setup.ts creates the first admin with this code, then
// one account per role, and leaves a signed-in browser state for each under this directory.
// An orchestrator run elsewhere has to have started on an empty tenant with the same code.
export const SETUP_CODE = process.env.ORCHESTRATOR_E2E_SETUP_TOKEN ?? "e2e-setup-code-0001";
process.env.ORCHESTRATOR_E2E_STATE_DIR = join(scratch, "state");
process.env.ORCHESTRATOR_E2E_SETUP_TOKEN = SETUP_CODE;

export default defineConfig({
  testDir: "browser-tests",
  timeout: 60_000,
  // One orchestrator and its demo repositories serve the whole suite, and a test that merges a
  // request moves a repository another test has open; the specs run one after another.
  workers: 1,
  globalSetup: "./browser-tests/global-setup.ts",
  use: { baseURL: external ?? `http://127.0.0.1:${port}`, storageState: join(scratch, "state", "admin.json") },
  // The bundles are built from the sources under test first: a dist/ left from an earlier
  // checkout serves an older page against newer tests and server, and fails as if the code did.
  webServer: external ? undefined : {
    command: `npm run build && node dist/seed.js ${scratch}/demo && node dist/server.js`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    // The build and the demo seed take about half a minute each on a busy machine (28 s and 29 s at load 11),
    // past the 60 s Playwright waits by default before the server has even started.
    timeout: 180_000,
    env: {
      ORCHESTRATOR_CONFIG: `${scratch}/demo/orchestrator.json`,
      ORCHESTRATOR_DATA_DIR: `${scratch}/data`,
      ORCHESTRATOR_PORT: String(port),
      HOME: `${scratch}/home`,
      ORCHESTRATOR_SETUP_TOKEN: SETUP_CODE,
      // The stand-in, and Claude Code as a script of this suite's that only answers the
      // readiness questions, as an old CLI with no sign-in: the readiness screen has an agent
      // that is not ready, and no real agent CLI is ever started, not even to ask its version.
      // The model credentials are emptied so a developer's own never reach the script.
      ORCHESTRATOR_AGENTS: "fake,claude-code",
      // A team's orchestrator hands tasks to its people's machines; this suite connects none, so the server runs them itself.
      ORCHESTRATOR_SERVER_TASKS: "1",
      ORCHESTRATOR_CLAUDE_BIN: fileURLToPath(new URL("./browser-tests/stand-in-claude.sh", import.meta.url)),
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ORCHESTRATOR_PUBLIC_URL: `http://127.0.0.1:${port}`,
      // This orchestrator is reached from this machine alone, so it signs in with a person's own gh and glab: stand-ins
      // come first on its PATH, acting out a browser sign-in from files under the suite's home, so no real CLI is ever run.
      PATH: `${fileURLToPath(new URL("./browser-tests/stand-in-cli", import.meta.url))}:${process.env.PATH ?? ""}`,
      // A fixed key for this throwaway data directory, so the Integrations specs can seal a webhook address.
      ORCHESTRATOR_SECRET_KEY: "0".repeat(64),
      // The Integrations specs stand in for a person's own MCP server and its sign-in on this machine.
      ORCHESTRATOR_MCP_LOCAL: "1",
      // The folder the connect spec makes a repository in and connects by path.
      ORCHESTRATOR_LOCAL_REPOS_ROOT: `${scratch}/local-repos`,
    },
  },
});
