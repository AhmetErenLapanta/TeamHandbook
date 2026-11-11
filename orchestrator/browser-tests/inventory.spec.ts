import { expect, test } from "@playwright/test";
import { openTab } from "./repo-tabs.js";

test("given two connected team repositories, when the orchestrator opens, then each team's skills, servers, commands and request record are listed", async ({ page }) => {
  // when
  await page.goto("/demo/repositories/payments-skills");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("payments-skills");
  const setup = page.getByRole("region", { name: /^Setup/ });
  await expect(setup.getByRole("heading")).toHaveText("Setup");
  await expect(setup).toContainText("All checks pass");
  await expect(setup).toContainText("Teammates can install it");
  await expect(setup).toContainText("Up to date");
  await expect(page.getByRole("region", { name: "What it shares" })).toContainText(/\d+ skills, 2 MCP servers, 1 slash command/);
  await openTab(page, "payments-skills", "Skills");
  await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();
  await openTab(page, "payments-skills", "MCP servers");
  await expect(page.getByRole("cell", { name: "postgres" })).toBeVisible();
  await openTab(page, "payments-skills", "Commands");
  await expect(page.getByText("/deploy-check", { exact: true })).toBeVisible();
  await openTab(page, "payments-skills", "Settings");
  await expect(page.getByText("ada, grace")).toBeVisible();

  // when another team is opened and a skill selected
  await page.goto("/demo/repositories/platform-skills");
  await openTab(page, "platform-skills", "Skills");
  await page.getByRole("cell", { name: "rotate-service-certificate" }).click();

  // then its history is the skill's own commit
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("platform-skills");
  await expect(page.getByRole("list").getByText("feat(skill): add rotate-service-certificate")).toBeVisible();
});

test("given a repository whose marketplace does not list its plugin and whose scaffold is behind, when it opens, then the setup panel says what that means and what to do", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const setup = [
      { level: "problem", title: "Teammates cannot install the plugin", detail: "The marketplace payments does not list the plugin payments-skills.", next: "Add payments-skills under plugins in .claude-plugin/marketplace.json." },
      { level: "attention", title: "TeamHandbook's files are out of date", detail: "It was written by TeamHandbook 0.1.0.", next: "Run /handbook:init --upgrade from a teammate's machine." },
      { level: "ok", title: "Every merge reaches teammates", detail: "Every merge is an update teammates receive." },
    ];
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, setup } } });
  });

  // when
  await page.goto("/demo/repositories/payments-skills");

  // then
  const setup = page.getByRole("region", { name: /^Setup/ });
  await expect(setup).toContainText("Something stops teammates");
  const items = setup.getByRole("listitem");
  await expect(items.nth(0)).toContainText("problem Teammates cannot install the plugin");
  await expect(items.nth(0)).toContainText("What to do: Add payments-skills under plugins in .claude-plugin/marketplace.json.");
  await expect(items.nth(1)).toContainText("attention TeamHandbook's files are out of date");
  await expect(items.nth(2)).not.toContainText("What to do");
});

test("given a command in a folder, when the repository opens and it is chosen, then it is shown as typed and its own file's history opens", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const commands = [...body.inventory.commands, { name: "git:sync", description: "Bring the branch up to date with main.", file: "commands/git/sync.md" }];
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, commands } } });
  });
  await page.goto("/demo/repositories/payments-skills/commands");

  // when
  await page.getByRole("button", { name: "/git:sync", exact: true }).click();

  // then
  await expect(page.getByRole("region", { name: /^Slash commands/ })).toContainText("Bring the branch up to date with main.");
  await expect(page.getByRole("heading", { name: /History/ })).toContainText("commands/git/sync.md");
});

test("given the demo's repository with the address teammates add it by, when it opens, then the join commands are shown and Copy puts one on the clipboard", async ({ page, context }) => {
  // given
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // when
  await page.goto("/demo/repositories/payments-skills");

  // then
  const join = page.getByRole("region", { name: "How teammates join" });
  await expect(join.getByText(/^\/plugin marketplace add file:\/\/.*payments-skills\.git$/)).toBeVisible();
  await expect(join.getByText("/plugin install payments-skills@payments-skills", { exact: true })).toBeVisible();
  await expect(join.getByText(/^\/handbook:join file:\/\/.*payments-skills\.git$/)).toBeVisible();

  // when
  await join.getByRole("button", { name: "Copy /plugin install payments-skills@payments-skills" }).click();

  // then
  await expect(join.getByRole("status")).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/plugin install payments-skills@payments-skills");
});

test("given a repository whose address for teammates is not configured, when it opens, then the page says where to set it and offers no command", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, join: { problem: "The orchestrator does not know the address teammates add this repository by. Set memberUrl for it in the orchestrator's configuration file and restart the orchestrator." } } });
  });

  // when
  await page.goto("/demo/repositories/payments-skills");

  // then
  const join = page.getByRole("region", { name: "How teammates join" });
  await expect(join).toContainText("Set memberUrl");
  await expect(join.getByRole("button")).toHaveCount(0);
});

test.describe("refreshing a scaffold that is behind", () => {
  const behind = async (page: import("@playwright/test").Page, refresh?: unknown) => {
    await page.route("**/api/repos/payments-skills/inventory", async (route) => {
      const body = await (await route.fetch()).json();
      const setup = [{ level: "attention", title: "TeamHandbook's files are out of date", detail: "It was written by TeamHandbook 0.1.0.", next: "Refresh the scaffold from this page, or run /handbook:init --upgrade.", refresh: true }];
      await route.fulfill({ json: { ...body, inventory: { ...body.inventory, setup }, ...(refresh ? { refresh } : {}) } });
    });
  };

  test("given an admin and a scaffold that is behind, when they refresh it from the setup panel, then the orchestrator's own refresh task starts and its page opens", async ({ page }) => {
    // given
    let sent: { repoId?: string; template?: unknown } | null = null;
    await behind(page);
    await page.route("**/api/tasks", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: { task: { id: "0123456789ab" } } });
    });
    await page.goto("/demo/repositories/payments-skills");

    // when
    await page.getByRole("region", { name: /^Setup/ }).getByRole("button", { name: "Update TeamHandbook's files" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\/0123456789ab$/);
    expect(sent).toMatchObject({ repoId: "payments-skills", template: { kind: "scaffold.refresh", commitVersioning: false } });
  });

  test("given a repository whose configuration names no memberUrl, when its scaffold is behind, then the panel says why it is not refreshed here and offers no button", async ({ page }) => {
    // given
    await behind(page, { problem: "The refresh writes the address teammates add this repository by, and the orchestrator's configuration names none: set memberUrl for it and restart the orchestrator." });

    // when
    await page.goto("/demo/repositories/payments-skills");

    // then
    const setup = page.getByRole("region", { name: /^Setup/ });
    await expect(setup).toContainText("set memberUrl for it");
    await expect(setup.getByRole("button", { name: "Update TeamHandbook's files" })).toHaveCount(0);
  });
});

test("given a team file whose commit prefix the plugin's rule refuses, when the repository opens, then the request facts say it is not used instead of showing it", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const team = { ...body.inventory.team, commitPrefix: undefined, commitPrefixProblem: "carrying a character other than letters, digits, spaces and . , : / [ ] ( ) _ -" };
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, team } } });
  });

  // when
  await page.goto("/demo/repositories/payments-skills/settings");

  // then
  await expect(page.getByRole("region", { name: /^Requests to this repository/ })).toContainText("Commit prefixnot used, see Setup");
});

test("given an orchestrator that runs tasks, when a repository opens, then its servers say whether a task gets them and why", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const mcpServers = body.inventory.mcpServers.map((m: { name: string }) =>
      m.name === "docs"
        ? { ...m, inTasks: { usable: true, signIn: true, detail: "search for Claude Code; it sends no credential, so a server that asks for a sign-in fails in a task: nobody is there to finish one in a browser" } }
        : { ...m, inTasks: { usable: false, signIn: false, detail: "no tool of it is allowed for tasks; name one in the repository's mcpTools in orchestrator.json" } },
    );
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, mcpServers } } });
  });

  // when
  await page.goto("/demo/repositories/payments-skills/mcp");

  // then
  const servers = page.getByRole("region", { name: /^MCP servers/ });
  await expect(servers.getByRole("row", { name: /^docs/ }).getByText("In tasks", { exact: true })).toHaveCount(1);
  await expect(servers.getByRole("row", { name: /^docs/ })).toContainText("given, no sign-in search for Claude Code; it sends no credential");
  await expect(servers.getByRole("row", { name: /^postgres/ })).toContainText("not given no tool of it is allowed for tasks");
});

test("given open requests on the forge, one a teammate opened and one the orchestrator opened, when the repository opens, then the teammate's is listed with its link and the orchestrator's is counted toward the list above", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/pending", (route) =>
    route.fulfill({
      json: {
        pending: [
          { number: 7, title: "feat(skill): share on-call", branch: "TEAM-7-on-call", url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7", author: "grace", updatedAt: "2026-10-24T09:00:00Z", fromFork: false, byOrchestrator: false },
          { number: 9, title: "feat(skill): share from elsewhere", branch: "TEAM-7-on-call", url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/9", author: "mallory", updatedAt: "2026-10-24T08:00:00Z", fromFork: true, byOrchestrator: false },
          { number: 8, title: "PAY chore(skill): remove release-checklist", branch: "handbook/orchestrator-remove-release-checklist-0a1b2c", url: null, author: "Ada Example", updatedAt: "2026-10-24T10:00:00Z", fromFork: false, byOrchestrator: true },
        ],
      },
    }),
  );

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  const waiting = page.getByRole("region", { name: /^Waiting to be merged/ });
  await expect(waiting.getByRole("link", { name: "#7 feat(skill): share on-call" })).toHaveAttribute("href", "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/7");
  await expect(waiting.getByRole("row", { name: /#8 PAY chore/ })).toHaveCount(0);
  await expect(waiting.getByRole("row", { name: /#9 feat/ })).toContainText("from a fork");
  await expect(waiting.getByRole("row", { name: /#7 feat/ })).not.toContainText("from a fork");
  await expect(waiting).toContainText("1 more, opened from the orchestrator, is under Requests from the orchestrator.");
});

test("given a hosted repository with no forge access, when it opens, then the panel says why nothing waiting is read", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/pending", (route) => route.fulfill({ json: { pending: null, reason: "No forge access is set for this repository, so what waits to be merged there is not read." } }));

  // when
  await page.goto("/demo/repositories/payments-skills/requests");

  // then
  await expect(page.getByRole("region", { name: /^Waiting to be merged/ })).toContainText("No forge access is set for this repository");
});

test("given a skill the plugin's format finds things missing in and two that answer the same requests, when the repository opens, then each says so beside its description", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    const skills = body.inventory.skills.map((s: { slug: string }) =>
      s.slug === "release-checklist" ? { ...s, format: ["it has no pitfalls section", "it has fewer than 3 numbered steps, or a numbered heading with nothing under it"] } : { ...s, format: [] },
    );
    await route.fulfill({ json: { ...body, inventory: { ...body.inventory, skills } } });
  });
  await page.route("**/api/repos/payments-skills/overlaps", (route) =>
    route.fulfill({ json: { head: "x", overlaps: { "release-checklist": { names: ["add-ledger-migration"], more: 2 }, "add-ledger-migration": { names: ["release-checklist"], more: 0 } } } }),
  );

  // when
  await page.goto("/demo/repositories/payments-skills/skills");
  const row = page.getByRole("row", { name: /^release-checklist/ });
  await row.getByText("2 things the plugin's skill format asks for").click();

  // then
  await expect(row).toContainText("Answers the same requests as add-ledger-migration and 2 more, so Claude can pick either.");
  await expect(row.getByRole("listitem")).toHaveText(["it has no pitfalls section", "it has fewer than 3 numbered steps, or a numbered heading with nothing under it"]);
  await expect(page.getByRole("heading", { name: /History/ })).not.toContainText("release-checklist");
});
