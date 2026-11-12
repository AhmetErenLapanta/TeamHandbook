import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work } from "./task-form.js";
import { stateFor } from "./roles.js";
import { taskLog } from "./task-page.js";

// A page's own second read of the task options, the agents' names, can still be in a route when a test ends.
test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

test("given an admin and the stand-in agent, when a task is started, then its log runs live and it ends waiting for review with a request on the repository", async ({ page }) => {
  // given
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await work(form, "Add an on-call handover\nWrite down what the outgoing engineer hands over.");
  await choose(form, "Repository", /^payments-skills/);
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/tasks\/(?:tsk_[0-9a-z]{26}|[a-f0-9]{12})$/);
  const id = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add an on-call handover");
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  const log = (await taskLog(page));
  await expect(log).toContainText("wrote skills/add-an-on-call-handover/SKILL.md");
  await expect(log).toContainText(`on task/${id}. It waits for a person to review and merge it.`);
  // A run that reported no cost says so in the rail, and nothing is said as unknown.
  const rail = page.getByRole("complementary", { name: "About this task" });
  await expect(rail).toContainText("Not reported");
  await expect(rail).not.toContainText(/unknown/i);

  // when the request is followed
  await page.getByRole("link", { name: "Open the request" }).click();

  // then the repository's requests list it, still awaiting review
  await expect(page).toHaveURL(/\/demo\/repositories\/payments-skills\/requests$/);
  const row = page.getByRole("row").filter({ hasText: `task/${id}` });
  await expect(row).toContainText("PAY Add an on-call handover");
  await expect(row).toContainText("awaiting review");
  await row.getByText("Description", { exact: true }).click();
  await expect(row.locator(".markdown")).toContainText("The block below is the agent's own output, quoted as data.");
  // The task's own words and the agent's report are each fenced as data, in that order.
  await expect(row.locator("pre")).toHaveText([/^Add an on-call handover\s+Write down what the outgoing engineer hands over\.$/, "Added the skill add-an-on-call-handover."]);

  // and the task list shows it as a call on the person who started it
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: "Add an on-call handover" }).first()).toContainText("needs you");
});

test("given an issue link and no title, when a task is started, then the task shows the issue and its request carries the key", async ({ page }) => {
  // given
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await work(form, "https://tracker.example.com/browse/PAY-142");
  await expect(form.getByRole("status", { name: "Issue" })).toContainText("PAY-142");
  await choose(form, "Repository", /^payments-skills/);
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work on PAY-142");
  await expect(page.getByRole("link", { name: "PAY-142" })).toHaveAttribute("href", "https://tracker.example.com/browse/PAY-142");
  await expect((await taskLog(page))).toContainText("It waits for a person to review and merge it.", { timeout: 30_000 });
  await page.getByRole("link", { name: "Open the request" }).click();
  await expect(page.getByRole("row").filter({ hasText: "PAY Work on PAY-142" })).toContainText("awaiting review");
});

/** Runs `body` with the named teams restricted to their owners, as an admin sets it, and opens them again after, so the shared demo stays open. */
async function restricted(browser: Browser, teams: string[], body: () => Promise<void>): Promise<void> {
  const admin = await browser.newContext({ storageState: stateFor("admin") });
  const { csrf } = await (await admin.request.get("/api/me")).json();
  const put = (team: string, on: boolean) => admin.request.put(`/api/teams/${team}/restricted`, { data: { restricted: on }, headers: { "x-csrf-token": csrf } });
  try {
    for (const team of teams) expect((await put(team, true)).status()).toBe(200);
    await body();
  } finally {
    for (const team of teams) await put(team, false);
    await admin.close();
  }
}

test.describe("a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member and teams open to every member, when they open the tasks screen, then the form offers to start a task", async ({ page }) => {
    // when
    await page.goto("/demo/tasks");

    // then
    const form = await newTaskForm(page);
    await expect(form.getByRole("note", { name: "Demo agent readiness" })).toContainText("Ready");
    await expect(form.getByRole("button", { name: "Start task" })).toBeVisible();
    await expect(page.getByText("You cannot start tasks")).toHaveCount(0);
  });

  test("given a member and every team restricted to its owners, when they open the tasks screen or call the API with their session, then no task can be started", async ({ page, browser }) => {
    await restricted(browser, ["Payments", "Platform"], async () => {
      // when
      await page.goto("/demo/tasks");

      // then
      await expect(page.getByRole("note")).toContainText("You cannot start tasks");
      await expect(page.getByRole("button", { name: "Start task" })).toHaveCount(0);

      // when the API is called directly, with the session's CSRF token
      const { csrf } = await (await page.request.get("/api/me")).json();
      const before = (await (await page.request.get("/api/tasks")).json()).tasks.length;
      const res = await page.request.post("/api/tasks", { data: { title: "Sneak in", description: "", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });

      // then
      expect(res.status()).toBe(403);
      expect((await (await page.request.get("/api/tasks")).json()).tasks).toHaveLength(before);
    });
  });
});

test.describe("another team's owner", () => {
  test.use({ storageState: stateFor("platformOwner") });

  test("given the Platform owner, when they open the task form, then every open team's project is offered, and a restricted team's is not", async ({ page, browser }) => {
    // when
    await page.goto("/demo/tasks");

    // then
    const form = await newTaskForm(page);
    await expect(form.getByRole("combobox", { name: "Repository" })).toBeVisible();
    expect(await optionsOf(form, "Repository")).toEqual(["payments-skills Payments", "platform-skills Platform"]);

    await restricted(browser, ["Payments"], async () => {
      // when
      await page.reload();
      await newTaskForm(page);

      // then
      await expect(form.getByRole("combobox", { name: "Kind of task" })).toHaveCount(0);
      await expect(form.getByRole("combobox", { name: "Repository" })).toHaveCount(0);
      await expect(form).not.toContainText("payments-skills");
    });
  });
});

test("given the dark theme, when a task's links are shown, then a row's title takes the theme's text colour and a keyboard focus draws a ring", async ({ page }) => {
  // given
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Check the link colours");
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();
  await expect(page.getByRole("link", { name: "Open the request" })).toBeVisible({ timeout: 30_000 });

  // when
  const text = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text").trim());
  const expected = await page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, text);
  // Focus that arrives by keyboard, the case the ring is for: a click or a script focus draws none.
  await page.getByRole("link", { name: "Open the request" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const outline = await page.getByRole("link", { name: "Open the request" }).evaluate((a) => getComputedStyle(a).outlineStyle);
  // A row's title is a link drawn in the text colour, so the table reads as rows rather than a column of links.
  await page.goto("/demo/tasks");
  await expect(page.getByRole("link", { name: "Check the link colours" }).first()).toBeVisible({ timeout: 30_000 });
  const colours = await page.locator("main a.row-link").evaluateAll((links) => links.map((a) => getComputedStyle(a).color));

  // then
  // The dark theme's text colour, whatever colour space the tokens write it in.
  expect(text).not.toBe("");
  expect(colours.length).toBeGreaterThan(0);
  expect(new Set(colours)).toEqual(new Set([expected]));
  expect(outline).toBe("solid");
});

test("given the task form's options failing, when the tasks screen opens, then the form's panel says so, and Try again brings the form", async ({ page }) => {
  // given
  await page.route("**/api/tasks/options", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The store did not answer." }) }));

  // when
  await page.goto("/demo/tasks");

  // then
  const panel = page.getByRole("region", { name: "New task" });
  await expect(panel.getByRole("alert")).toContainText(/Couldn't load the task form\. The store did not answer\./);
  await expect(panel.getByText("Loading…")).toHaveCount(0);

  // when the orchestrator answers again
  await page.unroute("**/api/tasks/options");
  await panel.getByRole("button", { name: "Retry the task form" }).click();

  // then
  await expect(page.getByRole("form", { name: "New task" })).toBeVisible();
});

test("given a running task's page that cannot open its stream, when the orchestrator stops answering for a moment, then the page says it is asking again and catches up once it answers", async ({ page, request }) => {
  // given: no stream, so the page follows the task by asking, as it does when one cannot open
  const { csrf } = await (await request.get("/api/me")).json();
  const started = await request.post("/api/tasks", { data: { title: "Ride out a break", description: "stand-in: wait 4 seconds", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });
  const { task } = await started.json();
  await page.route(`**/api/tasks/${task.id}/events*`, (route) => route.abort());
  await page.goto(`/demo/tasks/${task.id}`);
  await expect((await taskLog(page))).toContainText("waiting 4 seconds", { timeout: 30_000 });

  // when
  await page.route(`**/api/tasks/${task.id}?*`, (route) => route.abort());

  // then
  // one line that says when it asks again, the server's reason behind its hint
  await expect(page.getByRole("status")).toContainText(/The task did not refresh; trying again in \d+ s\./);
  await expect(page.getByRole("status").locator("details.hint")).toHaveCount(1);

  // when it answers again
  await page.unroute(`**/api/tasks/${task.id}?*`);

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  await expect(page.getByText("The task did not refresh")).toHaveCount(0);
});

test("given a start the orchestrator refuses, when the refusal shows, then the form's fields are marked and described by it", async ({ page }) => {
  // given
  await page.route("**/api/tasks", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "unknown agent" }) }) : route.fallback(),
  );
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Refused on purpose");
  await moreOptions(form);

  // when
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  const alert = form.getByRole("alert").filter({ hasText: "unknown agent" });
  await expect(alert).toBeVisible();
  const id = await alert.getAttribute("id");
  for (const label of ["What needs doing?", "Title", "Repository", "Agent"]) {
    await expect(form.getByLabel(label, { exact: true })).toHaveAttribute("aria-describedby", id!);
    await expect(form.getByLabel(label, { exact: true })).toHaveAttribute("aria-invalid", "true");
  }
});

test("given a described piece of work, when skills are suggested, then the agent's picks show with their reasons, and the start carries the skills as changed", async ({ page }) => {
  // given
  let asked: Record<string, unknown> | null = null;
  let started: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/skill-suggestions", async (route) => {
    asked = route.request().postDataJSON();
    await route.fulfill({ json: { suggestions: [{ skill: "on-call", reason: "the work changes the on-call handover" }], skills: [{ name: "on-call", description: "On-call" }, { name: "runbooks", description: "Runbooks" }] } });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Add an on-call handover\nWrite down what the outgoing engineer hands over.");

  // when
  await form.getByRole("button", { name: "Suggest skills" }).click();

  // then
  await expect(form.getByRole("checkbox", { name: /on-call/ })).toBeChecked();
  await expect(form).toContainText("on-call: the work changes the on-call handover");
  expect(asked).toMatchObject({ repoId: "payments-skills" });

  // when
  await form.getByRole("checkbox", { name: /runbooks/ }).check();
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  expect((started as { skills?: string[] } | null)?.skills).toEqual(["on-call", "runbooks"]);
});

test("given a task by the stand-in agent, when the task list and its page open, then they name the agent as people know it and never by its id", async ({ page, request }) => {
  // given
  const { csrf } = await (await request.get("/api/me")).json();
  const label: string = (await (await request.get("/api/tasks/options")).json()).agents.find((a: { id: string }) => a.id === "fake").label;
  const { task } = await (await request.post("/api/tasks", { data: { title: "Name the agent", description: "", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json();

  // when
  await page.goto("/demo/tasks");

  // then
  const row = page.getByRole("row").filter({ hasText: "Name the agent" }).first();
  await expect(row).toContainText(label);
  await expect(row.getByRole("cell", { name: "fake", exact: true })).toHaveCount(0);

  // when
  await page.goto(`/demo/tasks/${task.id}`);

  // then
  const rail = page.getByRole("complementary", { name: "About this task" });
  await expect(rail.getByRole("region", { name: "Where" })).toContainText("Repositorypayments-skillsTeamPayments");
  await expect(rail.getByRole("region", { name: "Run" })).toContainText(`Agent${label}Started`);
});

test("given an agent that offers a model and an effort, when one is picked, then the form shows only that agent's choices and the start carries only what was picked", async ({ page }) => {
  // given
  let started: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json());
    const options = [
      { id: "model", label: "Model", choices: [{ value: "fable", label: "Fable" }, { value: "opus", label: "Opus" }, { value: "sonnet", label: "Sonnet" }] },
      { id: "effort", label: "Effort", choices: [{ value: "low", label: "Low" }, { value: "max", label: "Max" }] },
    ];
    await route.fulfill({ json: { ...real, agents: real.agents.map((a: { id: string }) => (a.id === "fake" ? { ...a, options } : { ...a, options: [] })) } });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Pick a model");
  await chooseAgent(form);
  await moreOptions(form);

  // when
  await choose(form, "Model", "Opus");
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("Stopped by the test");
  expect((started as { choices?: unknown } | null)?.choices).toEqual({ model: "opus" });
  expect(await optionsOf(form, "Effort")).toEqual(["The agent's default", "Low", "Max"]);
});

test("given a team's project with a server that runs a command, when a task starts with it ticked, then the start names it and confirms its command, and with nothing ticked it names no server at all", async ({ page }) => {
  // given
  await page.route(/\/api\/projects\/[^/]+\/task-skills$/, (route) => route.fulfill({ json: { team: [], project: [] } }));
  await page.route(/\/api\/projects\/[^/]+\/task-tools$/, (route) => route.fulfill({ json: { skillSources: [], mcpServers: [{ id: "mcp_1", name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs-server"], env: [] }] } }));
  const starts: Record<string, unknown>[] = [];
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    starts.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  // The project's skills and MCP servers fold under More options with the model and the budget.
  await moreOptions(form);
  const tools = form.getByRole("group", { name: "Skills and MCP servers for this task" });
  await work(form, "Write the release notes");
  await chooseAgent(form);

  // when nothing is ticked
  await expect(tools.getByRole("checkbox", { name: /docs runs npx -y docs-server/ })).not.toBeChecked();
  await form.getByRole("button", { name: "Start task" }).click();
  await expect.poll(() => starts.length).toBe(1);

  // when the command server is ticked
  await tools.getByRole("checkbox", { name: /docs runs/ }).check();
  await form.getByRole("button", { name: "Start task" }).click();
  await expect.poll(() => starts.length).toBe(2);

  // then
  expect(starts[0]).toMatchObject({ mcpServers: [] });
  expect(starts[0]).not.toHaveProperty("mcpConfirmed");
  expect(starts[1]).toMatchObject({ mcpServers: ["mcp_1"], mcpConfirmed: ["mcp_1"] });
});

test("given the agents' names answering late, when the Tasks list and a task's page open, then neither draws a row or a header that fills in a moment later", async ({ page }) => {
  // given
  const { csrf } = await (await page.request.get("/api/me")).json();
  await page.request.post("/api/tasks", { data: { title: "Name the agent from the first frame", description: "Design.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } });
  // One stand-in for every read of the names, each held until its gate opens; the gate is swapped
  // rather than the route, since a route removed mid-read is answered twice.
  let release!: () => void;
  let gate = new Promise<void>((done) => (release = done));
  await page.route("**/api/tasks/options", async (route) => {
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  await page.goto("/demo/tasks");

  // then while the names are on their way, the list waits as a whole
  await expect(page.getByRole("form", { name: "New task" }).or(page.getByText("Loading the task form…")).first()).toBeVisible();
  await expect(page.locator("table.row-cards")).toHaveCount(0);

  // when they arrive
  release();

  // then every row names its agent in the line under its title from its first frame
  const agents = page.locator("table.turn-rows tbody tr td.rc-title > div.muted");
  await expect(agents.first()).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Name the agent from the first frame" }).first().locator("td.rc-title > div.muted")).toHaveText(/^payments-skills, Demo agent, started by /);
  // Other tests' tasks are on the list too, some by an agent no longer offered; each still names one.
  for (const name of await agents.allInnerTexts()) expect(name.split(", ")).toHaveLength(3);

  // when a task's page opens with its names late again
  gate = new Promise<void>((done) => (release = done));
  await page.getByRole("row").nth(1).click();

  // then the header is not drawn until it is whole
  await expect(page.getByText("Loading the task…")).toBeVisible();
  await expect(page.locator("header.page-head h1")).toHaveCount(0);
  release();
  await expect(page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Run" })).not.toContainText("AgentThe agent");
});
