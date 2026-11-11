import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { startStandInForge } from "../server/forge/stand-in-forge.js";
import type { StandInForge } from "../server/forge/stand-in-forge.js";
import { FORGE_PORTS } from "../playwright.forge.config.js";

// Run with: ORCHESTRATOR_E2E_PORT=18196 npx playwright test -c playwright.forge.config.ts --workers=1
const PORT = Number(process.env.ORCHESTRATOR_E2E_PORT ?? 18196);
const CALLBACK = `http://127.0.0.1:${PORT}/integrations/forge/callback`;

// Connecting a repository reads it with git from the stand-in, and setting one up writes it first: seconds, more on a loaded machine.
const SERVER_WORK = 30_000;

const forges: Partial<Record<"gitlab" | "github", StandInForge>> = {};
test.beforeAll(async () => {
  forges.gitlab = await startStandInForge("gitlab", FORGE_PORTS.gitlab);
  forges.github = await startStandInForge("github", FORGE_PORTS.github, CALLBACK);
});
test.afterAll(async () => {
  await Promise.all(Object.values(forges).map((f) => f!.close()));
});

/** A forge's card on Integrations: its one action, and its connection's management under Other ways to connect. */
async function card(page: Page, kind: string): Promise<Locator> {
  await page.goto("/demo/integrations");
  return page.locator(`#card-${kind}`);
}

/** The card with Other ways to connect opened, its connection section inside it. */
async function connection(page: Page, name: "GitLab" | "GitHub", kind: string): Promise<Locator> {
  const forge = await card(page, kind);
  await forge.getByText("Other ways to connect", { exact: true }).click();
  return forge.getByRole("region", { name: `${name} connection` });
}

async function connect(page: Page, name: "GitLab" | "GitHub", kind: string, account: string): Promise<Locator> {
  const forge = await card(page, kind);
  await expect(forge.getByText(`Connect ${name} once for the organization`)).toBeVisible();
  await forge.getByRole("button", { name: `Connect with ${name}` }).click();
  await page.waitForURL(`**/demo/integrations?forge_connected=${kind}`);
  await expect(page.locator(`#card-${kind}`)).toContainText(`Connected as ${account}.`);
  return connection(page, name, kind);
}

for (const [kind, name, account] of [["gitlab", "GitLab", "ada-gl"], ["github", "GitHub", "acme-org"]] as const) {
  test(`given an owner and ${name} registered, when they connect, pick repositories and set up the team repository, then the stand-in holds each change, the webhook is set and disconnecting waits for the repositories`, async ({ page }) => {
    const forge = forges[kind]!;
    forge.addRepo(`${account}/${kind}-handbook`, { withCommit: true });
    forge.addRepo(`${account}/${kind}-empty`);

    // A connection with nothing on it comes off at once.
    let section = await connect(page, name, kind, account);
    await section.getByRole("button", { name: `Disconnect ${name}` }).click();
    await section.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.locator(`#card-${kind}`).getByRole("button", { name: `Connect with ${name}` })).toBeVisible();

    section = await connect(page, name, kind, account);
    const list = section.getByRole("list", { name: `${name} repositories` });
    const withHistory = list.getByRole("listitem").filter({ hasText: `${account}/${kind}-handbook` });
    const empty = list.getByRole("listitem").filter({ hasText: `${account}/${kind}-empty` });
    // Only a repository with no commit is offered as the team repository.
    await expect(withHistory.getByRole("button", { name: `Use ${account}/${kind}-handbook as the team repository` })).toHaveCount(0);

    await withHistory.getByRole("combobox", { name: `Team for ${account}/${kind}-handbook` }).fill("Payments");
    await withHistory.getByRole("button", { name: `Connect ${account}/${kind}-handbook` }).click();
    await expect(withHistory.getByText("Connected")).toBeVisible({ timeout: SERVER_WORK });
    expect(forge.read(`${account}/${kind}-handbook`).commits.map((c) => c.subject)).toEqual(["someone's first commit"]);

    await empty.getByRole("combobox", { name: `Team for ${account}/${kind}-empty` }).fill("Platform");
    await empty.getByRole("button", { name: `Use ${account}/${kind}-empty as the team repository` }).click();
    await expect(empty.getByText("Connected")).toBeVisible({ timeout: SERVER_WORK });
    expect(forge.read(`${account}/${kind}-empty`).commits.at(-1)).toMatchObject({ subject: "chore: scaffold team skill base", author: "Ada Admin", parents: 0 });
    expect(forge.hooks.has(`${account}/${kind}-empty`)).toBe(true);

    await section.getByRole("button", { name: "Create team repository" }).click();
    const form = section.getByRole("form", { name: "Create team repository" });
    await expect(form.getByText("writes its first commit straight to it")).toBeVisible();
    await form.getByRole("textbox", { name: "Name" }).fill(`${kind}-team-skills`);
    await form.getByRole("combobox", { name: "Team" }).fill("Payments");
    await form.getByRole("combobox", { name: "Visibility" }).selectOption("private");
    await form.getByRole("button", { name: "Create repository" }).click();
    await expect(section.getByRole("status").filter({ hasText: `Created ${account}/${kind}-team-skills.` })).toBeVisible({ timeout: SERVER_WORK });
    const made = forge.read(`${account}/${kind}-team-skills`);
    expect(made.commits.at(-1)).toMatchObject({ author: "Ada Admin", parents: 0 });
    expect(JSON.parse(made.files[".claude-plugin/marketplace.json"]!).name).toBe(`${kind}-team-skills`);
    const hook = forge.hooks.get(`${account}/${kind}-team-skills`) as { url?: string; config?: { url: string } };
    expect(hook.url ?? hook.config!.url).toBe(`http://127.0.0.1:${PORT}/api/hooks/forge/${kind}-team-skills`);

    // While repositories reach the forge through it, the connection stays and the card says which.
    section = await connection(page, name, kind);
    await section.getByRole("button", { name: `Disconnect ${name}` }).click();
    await section.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(section.getByRole("alert")).toContainText(`${kind}-handbook`);
    await expect(section.getByText(`Connected as ${account}`)).toBeVisible();
  });
}

test("given a connection refused on the way back, when the orchestrator lands, then the Integrations page says why as an alert", async ({ page }) => {
  await page.goto(`/demo/integrations?forge_problem=${encodeURIComponent("That sign-in is unknown or expired; connect the forge again.")}`);
  await expect(page.getByRole("alert").filter({ hasText: "unknown or expired" })).toBeVisible();
});

test("given a phone-width screen, when the GitLab connection is open, then nothing in it sticks out past the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const section = await connection(page, "GitLab", "gitlab");
  await expect(section).toBeVisible();
  // Names what sticks out, so a failure says where the section is too wide.
  const wider = await section.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
      .map((e) => `${e.tagName.toLowerCase()} "${(e.textContent ?? "").trim().slice(0, 40)}" ${Math.round(e.getBoundingClientRect().right)}`),
  );
  expect(wider).toEqual([]);
});
