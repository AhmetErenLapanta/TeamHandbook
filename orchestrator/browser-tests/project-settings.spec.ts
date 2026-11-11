import { expect, test } from "@playwright/test";

// A project's own name in its Settings, from a stand-in answer for the rename, so the demo's
// projects keep the names the rest of the suite reads.

// A page keeps reading its projects after a test's last check; the stand-in answers stop with the test.
test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

test("given a project connected from the screen, when an admin renames it in Settings, then the new name shows on its page and in the list, and its address stays", async ({ page }) => {
  // given
  let name = "payments-skills";
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, repo: { ...body.repo, source: "orchestrator", name } } });
  });
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { repos: body.repos.map((r: { id: string }) => (r.id === "payments-skills" ? { ...r, name } : r)) } });
  });
  let sent: unknown = null;
  await page.route("**/api/projects/payments-skills", async (route) => {
    sent = route.request().postDataJSON();
    name = (sent as { name: string }).name;
    await route.fulfill({ json: { project: { id: "payments-skills", name, team: "Payments", url: "file:///srv/payments-skills", facts: null } } });
  });
  await page.goto("/demo/repositories/payments-skills/settings");
  const section = page.getByRole("region", { name: "Project" });
  const form = section.getByRole("form", { name: "Project name" });
  await expect(form.getByRole("button", { name: "Rename" })).toBeDisabled();

  // when
  await form.getByLabel("Name").fill("Payments handbook");
  await form.getByRole("button", { name: "Rename" }).click();

  // then
  expect(sent).toEqual({ name: "Payments handbook" });
  await expect(section.getByRole("status")).toHaveText("The project is now named Payments handbook.");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments handbook");
  await expect(page).toHaveURL(/\/demo\/repositories\/payments-skills\/settings$/);
  await page.goto("/demo/tasks?repo=payments-skills");
  await expect(page.locator(".day-sentence")).toHaveText(/^In Payments handbook, /);
});

test("given a project listed in the configuration file, when Settings opens, then its name shows with where it is set and no rename is offered", async ({ page }) => {
  // when
  await page.goto("/demo/repositories/payments-skills/settings");

  // then
  const section = page.getByRole("region", { name: "Project" });
  await expect(section).toContainText("Its name is set in the orchestrator's configuration file");
  await expect(section.getByRole("form", { name: "Project name" })).toHaveCount(0);
});

test("given a code project connected from the screen, when an admin picks the skills its tasks read, then the choice is sent and said, and None sends no project", async ({ page }) => {
  // given
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, repo: { ...body.repo, source: "orchestrator", kind: "code", skillsFrom: null } } });
  });
  const sent: unknown[] = [];
  await page.route("**/api/projects/payments-skills", async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { project: { id: "payments-skills", name: "payments-skills", facts: null } } });
  });
  await page.goto("/demo/repositories/payments-skills/settings");
  const section = page.getByRole("region", { name: "Project" });

  // when
  await section.getByRole("combobox", { name: "Skills its tasks read" }).click();
  await page.getByRole("option", { name: "platform-skills" }).click();

  // then
  await expect(section.getByRole("status")).toHaveText("Tasks in payments-skills read the skills of platform-skills.");

  // when
  await section.getByRole("combobox", { name: "Skills its tasks read" }).click();
  const reread = page.waitForResponse((r) => r.url().includes("/api/repos/payments-skills/inventory"));
  await page.getByRole("option", { name: "None" }).click();
  await reread;

  // then
  await expect(section.getByRole("status")).toHaveText("Tasks in payments-skills read no team's skills.");
  expect(sent).toEqual([{ skillsFrom: "platform-skills" }, { skillsFrom: null }]);
});

test("given a folder without Git that the orchestrator has nothing to read in, when its page opens, then it shows the project with its name and place, and Make this a Git repository starts Git there", async ({ page }) => {
  // given
  let git: "none" | "repo" = "none";
  const shop = { id: "shop", team: "Mine", name: "shop", url: "/Users/you/code/shop", head: null, syncedAt: null, error: null, kind: "code", source: "orchestrator", skillsFrom: null };
  let listed = 0;
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { repos: [...body.repos, shop] } });
    listed += 1;
  });
  await page.route("**/api/repos/shop/inventory", (route) => route.fulfill({ status: 409, json: { error: "The orchestrator has not read this repository yet.", code: "conflict" } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [{ ...shop, facts: { git, empty: git === "repo", origin: null, name: "shop", kind: "code" }, machine: null }], last: "shop", home: "/Users/you" } }));
  let made = false;
  await page.route("**/api/projects/shop/git/init", (route) => {
    made = true;
    git = "repo";
    return route.fulfill({ json: { project: { ...shop, facts: { git: "repo", origin: null, name: "shop", kind: "code" } } } });
  });

  // when
  await page.goto("/demo/repositories/shop/settings");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("shop");
  await expect(page.locator("main")).toContainText("~/code/shop");
  await expect(page.getByText(/reading shop for the first time/)).toHaveCount(0);
  const section = page.getByRole("region", { name: "Project" });
  await expect(section.getByRole("form", { name: "Project name" })).toBeVisible();
  await expect(section).toContainText("No file is added or committed");

  // when
  await expect.poll(() => listed).toBeGreaterThan(0);
  const before = listed;
  await section.getByRole("button", { name: "Make this a Git repository" }).click();
  await expect.poll(() => listed).toBeGreaterThan(before);

  // then
  await expect(section).toContainText("This folder is a Git repository: a task's review offers to commit what it changed.");
  await expect(section.getByRole("button", { name: "Make this a Git repository" })).toHaveCount(0);
  expect(made).toBe(true);
});

test("given a folder made a Git repository with no commit yet, when its page is opened afresh, then it is the project's own page rather than a wait for a read that has nothing to read", async ({ page }) => {
  // given
  const shop = { id: "shop", team: "Mine", name: "shop", url: "/Users/you/code/shop", head: null, syncedAt: null, error: null, kind: "code", source: "orchestrator", skillsFrom: null };
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { repos: [...body.repos, shop] } });
  });
  await page.route("**/api/repos/shop/inventory", (route) => route.fulfill({ status: 409, json: { error: "The orchestrator has not read this repository yet.", code: "conflict" } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [{ ...shop, facts: { git: "repo", empty: true, origin: null, name: "shop", kind: "code" }, machine: null }], last: "shop", home: "/Users/you" } }));

  // when
  await page.goto("/demo/repositories/shop/settings");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("shop");
  await expect(page.getByText(/reading shop for the first time/)).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Project" })).toContainText("This folder is a Git repository: a task's review offers to commit what it changed.");
  await expect(page.getByRole("button", { name: "Make this a Git repository" })).toHaveCount(0);
});

test("given a project, when an admin adds a skill repository and an MCP server for tasks there, then a refused folder says why, the server's values are sent but only their names come back, and each one is removed after a second answer", async ({ page }) => {
  // given
  const sources: Record<string, unknown>[] = [];
  const servers: Record<string, unknown>[] = [];
  const sent: { source?: unknown; server?: unknown } = {};
  const base = "/api/projects/payments-skills";
  await page.route((url) => url.pathname === `${base}/task-tools`, (route) => route.fulfill({ json: { skillSources: sources, mcpServers: servers } }));
  await page.route((url) => url.pathname === `${base}/skill-sources`, (route) => {
    const body = route.request().postDataJSON() as { folder?: string; url?: string };
    if (body.folder === "~/code/empty") return route.fulfill({ status: 400, json: { error: "no SKILL.md in ~/code/empty; a skill repository holds at least one skill", code: "no-skills" } });
    sent.source = body;
    const source = { id: "ssrc_1", kind: "folder", path: body.folder, name: "team-skills", skills: [{ name: "release-notes", description: "Write release notes" }, { name: "on-call", description: "Hand over on-call" }], readAt: "2026-11-03T12:00:00Z" };
    sources.push(source);
    return route.fulfill({ json: { source } });
  });
  await page.route((url) => url.pathname === `${base}/skill-sources/ssrc_1`, (route) => {
    sources.splice(0);
    return route.fulfill({ status: 204, body: "" });
  });
  await page.route((url) => url.pathname === `${base}/mcp-servers`, (route) => {
    sent.server = route.request().postDataJSON();
    const server = { id: "mcp_1", name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-server"], env: ["DOCS_TOKEN"] };
    servers.push(server);
    return route.fulfill({ json: { server } });
  });
  await page.route((url) => url.pathname === `${base}/mcp-servers/mcp_1`, (route) => {
    servers.splice(0);
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/demo/repositories/payments-skills/settings");
  const section = page.getByRole("region", { name: /^Skills and MCP servers for tasks here/ });
  await expect(section).toContainText("No skill repository yet.");
  await expect(section).toContainText("No MCP server yet.");
  // each form waits behind its own button, and no Remove shows before a row is picked
  await expect(section.getByRole("form")).toHaveCount(0);
  await expect(section.getByRole("button", { name: /^Remove/ })).toHaveCount(0);

  // when a folder with no skill is added
  await section.getByRole("button", { name: "Add a skill repository" }).click();
  const addSource = section.getByRole("form", { name: "Add a skill repository" });
  await addSource.getByLabel("Folder or git address").fill("~/code/empty");
  await addSource.getByRole("button", { name: "Add a skill repository" }).click();

  // then
  await expect(addSource.getByRole("alert")).toHaveText("No SKILL.md in ~/code/empty; a skill repository holds at least one skill.");

  // when one with skills is added
  await addSource.getByLabel("Folder or git address").fill("~/code/team-skills");
  await addSource.getByRole("button", { name: "Add a skill repository" }).click();

  // then
  await expect(section.getByRole("status")).toHaveText("Added team-skills: 2 skills for tasks here.");
  await expect(section).toContainText("team-skills ~/code/team-skills 2 skills");
  expect(sent.source).toEqual({ folder: "~/code/team-skills" });

  // when an MCP server is added with a value
  await expect(section.getByRole("form", { name: "Add a skill repository" })).toHaveCount(0);
  await section.getByRole("button", { name: "Add an MCP server" }).click();
  const addServer = section.getByRole("form", { name: "Add an MCP server" });
  await addServer.getByLabel("Name", { exact: true }).fill("docs");
  await addServer.getByLabel("Command").fill("npx");
  await addServer.getByLabel("Arguments").fill("-y docs-server");
  await addServer.getByLabel(/Environment/).fill("DOCS_TOKEN=stand-in-value-0001");
  await addServer.getByRole("button", { name: "Add the MCP server" }).click();

  // then the value is sent once and only its name is shown
  expect(sent.server).toEqual({ name: "docs", command: "npx", args: ["-y", "docs-server"], env: { DOCS_TOKEN: "stand-in-value-0001" } });
  await expect(section).toContainText("docs npx -y docs-server with DOCS_TOKEN");
  expect(await page.content()).not.toContain("stand-in-value-0001");

  // then no Remove shows until a row is picked, and no row carries a button of its own
  await expect(section.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await expect(section.locator("li.tool-row button")).toHaveCount(0);

  // when each row is picked and removed with a second answer
  await section.getByRole("option", { name: /team-skills/ }).click();
  await expect(section.getByRole("option", { name: /team-skills/ })).toHaveAttribute("aria-selected", "true");
  await section.getByRole("button", { name: "Remove team-skills" }).click();
  await section.getByRole("button", { name: "Remove repository" }).click();
  await expect(section).toContainText("No skill repository yet.");
  await section.getByRole("option", { name: /docs/ }).press("Enter");
  await section.getByRole("button", { name: "Remove docs" }).click();
  await section.getByRole("button", { name: "Remove server" }).click();

  // then
  await expect(section).toContainText("No skill repository yet.");
  await expect(section).toContainText("No MCP server yet.");
});

test("given a project with two skill repositories, when its list is reached by keyboard, then it is one Tab stop and the arrow keys move between its rows", async ({ page }) => {
  // given
  const source = (id: string, name: string) => ({ id, kind: "folder", path: `~/code/${name}`, name, skills: [], readAt: "2026-11-04T10:00:00Z" });
  await page.route("**/api/projects/payments-skills/task-tools", (route) => route.fulfill({ json: { skillSources: [source("s1", "team-skills"), source("s2", "docs-skills")], mcpServers: [] } }));
  await page.goto("/demo/repositories/payments-skills/settings");
  const list = page.getByRole("listbox", { name: "Skill repositories" });
  await expect(list.getByRole("option")).toHaveCount(2);

  // then only the first row is in the Tab order
  await expect(list.getByRole("option").nth(0)).toHaveAttribute("tabindex", "0");
  await expect(list.getByRole("option").nth(1)).toHaveAttribute("tabindex", "-1");

  // when
  await list.getByRole("option").nth(0).focus();
  await page.keyboard.press("ArrowDown");

  // then
  await expect(list.getByRole("option").nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(list.getByRole("option").nth(0)).toBeFocused();
});
