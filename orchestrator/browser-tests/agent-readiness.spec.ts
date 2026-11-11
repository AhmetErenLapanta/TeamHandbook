import { expect, test } from "@playwright/test";
import { chooseAgent, moreOptions, newTaskForm, optionsOf } from "./task-form.js";
import { stateFor } from "./roles.js";

// Against an orchestrator run elsewhere the agents it offers are its own.
test.skip(!!process.env.ORCHESTRATOR_E2E_BASE_URL, "the suite's own orchestrator offers Claude Code as a stand-in script of the suite's");

test("given the stand-in and a Claude Code CLI that is old and signed out, when an admin opens the tasks screen, then the form shows only where the picked agent stands and See details opens Settings, where readiness shows one ready and one not with the reasons", async ({ page }) => {
  // when
  await page.goto("/demo/tasks");

  // then
  const form = await newTaskForm(page);
  await chooseAgent(form, /^Claude Code/);
  const note = form.getByRole("alert", { name: "Claude Code readiness" });
  await expect(note).toHaveText("Not ready No model credential. See details", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "Agent readiness" })).toHaveCount(0);
  await expect(page.getByText("Checking…")).toHaveCount(0);
  await chooseAgent(form);
  await expect(form.getByRole("alert", { name: "Claude Code readiness" })).toHaveCount(0);
  await expect(form.getByRole("note", { name: "Demo agent readiness" })).toHaveText("Ready");
  await expect(form.getByRole("link", { name: "See details" })).toHaveCount(0);

  // when the admin opens the agents' readiness from Settings
  await page.goto("/demo/settings/agents");

  // then
  await expect(page).toHaveURL(/\/demo\/settings\/agents$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agent readiness" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Agent readiness" })).toHaveAttribute("aria-current", "page");
  const readiness = page.getByRole("region", { name: "Agent readiness" });
  await expect(readiness.locator('[data-agent="fake"]')).toContainText("ready", { timeout: 15_000 });
  await expect(readiness.locator('[data-agent="fake"]')).not.toContainText("not ready");
  const claude = readiness.locator('[data-agent="claude-code"]');
  await expect(claude).toContainText("not ready");
  await expect(claude).toContainText("2.0.0 is older than 2.1.309, the version the orchestrator was checked with. Update the CLI to 2.1.309.");
  await expect(claude).toContainText("none of ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN is set on the orchestrator");
  await expect(claude).toContainText("not logged in and no API key");

  // when a fresh check is asked for
  const before = await readiness.getByText(/Checked at/).textContent();
  await page.waitForTimeout(1100);
  await readiness.getByRole("button", { name: "Check again" }).click();

  // then
  await expect(readiness.getByText(/Checked at/)).not.toHaveText(before!);
});

test.describe("a team's owner", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given the Payments owner, when they open the tasks screen, then the readiness report and its details are not shown, Settings does not offer them, and the form says the agent is not ready and who sees why", async ({ page }) => {
    // when
    await page.goto("/demo/tasks");

    // then
    const form = await newTaskForm(page);
    await moreOptions(form);
    await expect.poll(() => optionsOf(form, "Agent"), { timeout: 15_000 }).toEqual(["Demo agent", "Claude Code not ready"]);
    await chooseAgent(form, /^Claude Code/);
    const note = form.getByRole("alert", { name: "Claude Code readiness" });
    // one sentence beside the badge; why it stops a start waits behind its hint
    await expect(note).toContainText("Not ready No model credential.");
    await expect(note.locator("details.hint")).toContainText("A task started now fails. An admin sees why on Agent readiness.");
    await expect(note.getByRole("link")).toHaveCount(0);
    const options = await (await page.request.get("/api/tasks/options")).json();
    expect(options.agents.find((a: { id: string }) => a.id === "claude-code").readiness).toEqual({ ready: false, state: "not-ready", first: "no model credential" });
    await expect(page.getByRole("region", { name: "Agent readiness" })).toHaveCount(0);
    expect((await page.request.get("/api/agents/readiness")).status()).toBe(403);
    await page.goto("/demo/settings");
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Your account" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Agent readiness" })).toHaveCount(0);
  });
});
