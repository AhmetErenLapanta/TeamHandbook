import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work } from "./task-form.js";
import { taskLog } from "./task-page.js";

// The orchestrator the suite started itself: the demo's bare repositories can be changed directly.
const external = !!process.env.ORCHESTRATOR_E2E_BASE_URL;
const scratch = process.env.ORCHESTRATOR_E2E_SCRATCH!;
const ENVIRONMENT_FILE = ".teamhandbook/environment.json";

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  return { "x-csrf-token": (await (await request.get("/api/me")).json()).csrf };
}

/** A clone of platform-skills that commits to the demo's bare repository and has the orchestrator read it again. */
function platform(request: APIRequestContext) {
  const bare = join(scratch, "demo", "repos", "platform-skills.git");
  const work = mkdtempSync(join(scratch, "environment-"));
  execFileSync("git", ["clone", "--quiet", bare, work]);
  const publish = async (message: string) => {
    execFileSync("git", ["add", "-A"], { cwd: work });
    execFileSync("git", ["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", message], { cwd: work });
    execFileSync("git", ["fetch", "--quiet", work, "main:main"], { cwd: bare });
    expect((await request.post("/api/repos/platform-skills/sync", { headers: await csrf(request) })).status()).toBe(200);
  };
  return {
    async write(environment: unknown, message: string) {
      mkdirSync(join(work, ".teamhandbook"), { recursive: true });
      writeFileSync(join(work, ENVIRONMENT_FILE), JSON.stringify(environment, null, 2) + "\n");
      await publish(message);
    },
    async remove() {
      execFileSync("git", ["rm", "--quiet", "-r", ".teamhandbook"], { cwd: work });
      await publish("chore: run tasks without a task environment");
    },
  };
}

async function startFromForm(page: import("@playwright/test").Page, title: string) {
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await choose(form, "Repository", /^platform-skills/);
  await work(form, title);
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();
}

test("given a repository whose environment file sets up the checkout, when a task starts from the form, then the setup runs before the agent and the request opens", async ({ page, request }) => {
  test.skip(external, "the environment file is written straight into the suite's own demo repository");
  // given
  const repo = platform(request);
  await repo.write({ setup: { command: 'node -e "require(\'fs\').mkdirSync(\'vendor\',{recursive:true});require(\'fs\').writeFileSync(\'vendor/lib.js\',\'x\')"' } }, "chore: set up the checkout before a task");
  try {
    // when
    await startFromForm(page, "Add the on-call note");

    // then
    await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
    const log = (await taskLog(page));
    await expect(log).toContainText("Running the repository's setup:");
    await expect(log).toContainText("The setup created 1 path(s) the change leaves out.");
  } finally {
    await repo.remove();
  }
});

test("given a repository whose environment file allows the agent only some domains, when a task starts on an orchestrator without container isolation, then it fails before any agent runs and says why", async ({ page, request }) => {
  test.skip(external, "the environment file is written straight into the suite's own demo repository");
  // given
  const repo = platform(request);
  await repo.write({ agent: { allowedDomains: ["registry.npmjs.org"] } }, "chore: allow the agent only the package registry");
  try {
    // when
    await startFromForm(page, "Bump the linter");

    // then
    await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 30_000 });
    await expect(page.getByText("allows the agent only registry.npmjs.org, which only container isolation holds")).toBeVisible();
    await expect((await taskLog(page))).not.toContainText("Starting");
  } finally {
    await repo.remove();
  }
});
