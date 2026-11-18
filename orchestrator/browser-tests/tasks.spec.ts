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

test("given a file attached to the new task form, when the task starts, then the file is kept for the person first and the start names it", async ({ page }) => {
  // given
  const uploads: string[] = [];
  let started: Record<string, unknown> | null = null;
  await page.route("**/api/attachments", (route) => {
    uploads.push(route.request().headers()["x-attachment-name"] ?? "");
    return route.fulfill({ status: 201, json: { attachment: { id: "att_free1", taskId: "", name: "error.png", mime: "image/png", size: 8 } } });
  });
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON() as Record<string, unknown>;
    return route.fallback();
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await form.getByLabel("Choose files").setInputFiles({ name: "error.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  await expect(form.getByRole("list", { name: "Files" })).toContainText("error.png");
  await work(form, "Fix the error in the screenshot");
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => started).toMatchObject({ attachments: ["att_free1"] });
  expect(uploads).toEqual(["error.png"]);
});

test("given a repository whose branches are read, when another branch is picked, then the start names it and the default one is not sent", async ({ page }) => {
  // given
  let started: Record<string, unknown> | null = null;
  await page.route("**/api/repos/*/branches", (route) => route.fulfill({ json: { default: "main", branches: ["main", "release/2"] } }));
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON() as Record<string, unknown>;
    return route.fallback();
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Fix it on the release branch");
  await chooseAgent(form);

  // when
  await form.getByText("More options").click();
  await choose(form, "Start from branch", "release/2");
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => started).toMatchObject({ baseBranch: "release/2" });
});

test("given a phone, when the new task form is drawn, then the Attach files button is at least 24 pixels high", async ({ page }) => {
  // given
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  const box = await form.getByRole("button", { name: "Attach files" }).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(24);
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

test("given an agent whose readiness has a command that repairs it, when the form shows the agent, then the command is offered to copy beside the first problem", async ({ page }) => {
  // given
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json());
    const readiness = { ready: false, state: "not-ready", first: "signed out", fix: "claude auth login" };
    await route.fulfill({ json: { ...real, agents: real.agents.map((a: { id: string }) => (a.id === "fake" ? { ...a, readiness } : a)) } });
  });

  // when
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await chooseAgent(form);

  // then
  await expect(form.getByRole("alert", { name: /readiness/ })).toContainText("Signed out");
  await expect(form.getByText("claude auth login")).toBeVisible();
  await expect(form.getByRole("button", { name: "Copy the command" })).toBeVisible();
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

test("given a task set to repeat, when it starts, then the start carries when it repeats and the rail says what that means", async ({ page }) => {
  // given
  let started: Record<string, unknown> | null = null;
  let stopped = "";
  await page.route("**/api/tasks/repeats", (route) => route.fulfill({ json: { repeats: stopped ? [] : [{ id: "rep_1", title: "Check the nightly build", every: "weekday", at: "09:00", next: "2026-11-16T09:00:00", skipped: { at: "2026-11-10T09:00:00", reason: "this machine was off" } }] } }));
  await page.route("**/api/tasks/repeats/rep_1/stop", (route) => {
    stopped = "rep_1";
    return route.fulfill({ json: {} });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { repeat: { id: "rep_1", title: "Check the nightly build", every: "weekday", at: "09:00", next: "2026-11-16T09:00:00" } } });
  });
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  await page.goto("/demo/tasks/new");
  const form = await newTaskForm(page);
  await work(form, "Check the nightly build");
  await moreOptions(form);

  // when
  await choose(form, "Repeat", "Every weekday");
  await form.getByLabel("Time of day").fill("09:00");

  // then
  await expect(page.getByText("Runs every weekday at 9:00 on this machine, under the same limits; a run this machine is off for is skipped and said.").first()).toBeVisible();

  // when
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => started).toMatchObject({ repeat: { every: "weekday", at: "09:00" } });
  await expect(form).toContainText("It repeats every weekday at 9:00; the first run is Mon 9:00.");
});

test("given a task that repeats, when the task list opens, then a Repeats section holds it with its next run and the run it skipped, and stopping it asks first", async ({ page }) => {
  // given
  let stopped = false;
  await page.route("**/api/tasks/repeats", (route) => route.fulfill({ json: { repeats: stopped ? [] : [{ id: "rep_1", title: "Check the nightly build", every: "weekday", at: "09:00", next: "2026-11-16T09:00:00", skipped: { at: "2026-11-10T09:00:00", reason: "this machine was off" } }] } }));
  await page.route("**/api/tasks/repeats/rep_1/stop", (route) => {
    stopped = true;
    return route.fulfill({ json: {} });
  });

  // when
  await page.goto("/demo/tasks");
  const section = page.getByRole("region", { name: /^Repeats/ });

  // then
  await expect(section).toContainText("Check the nightly build");
  await expect(section).toContainText("every weekday at 9:00, next ");
  await expect(section).toContainText("Skipped Tue 9:00: this machine was off.");

  // when
  await section.getByRole("button", { name: "Stop repeating Check the nightly build" }).click();
  await section.getByRole("button", { name: "Stop repeating", exact: true }).click();

  // then
  await expect(page.getByRole("region", { name: /^Repeats/ })).toHaveCount(0);
});

test("given a task list with an agent at work, when its tab is hidden and shown again, then the board is not read while hidden and is read once when it comes back", async ({ page }) => {
  // given
  let reads = 0;
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => (window as unknown as { __hidden?: boolean }).__hidden === true });
  });
  await page.clock.install();
  await page.route("**/api/tasks/board*", async (route) => {
    reads++;
    const real = await route.fetch().then((r) => r.json());
    await route.fulfill({ json: { ...real, counts: { ...real.counts, agents: 1 } } });
  });
  await page.goto("/demo/tasks");
  await expect.poll(() => reads).toBeGreaterThan(0);

  // when hidden
  await page.evaluate(() => { (window as unknown as { __hidden?: boolean }).__hidden = true; });
  await page.clock.runFor(1_000);
  const before = reads;
  await page.clock.runFor(10_000);

  // then
  expect(reads).toBe(before);

  // when shown
  await page.evaluate(() => {
    (window as unknown as { __hidden?: boolean }).__hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // then
  await expect.poll(() => reads).toBeGreaterThan(before);
});

test("given the orchestrator reads handbooks, when a handbook is turned off for this task, then the folded line counts one change from the default, Reset returns to the default and the start carries only this task's off", async ({ page }) => {
  // given
  let started: Record<string, unknown> | null = null;
  const plugin = "plugin:payments-skills@payments-market";
  const sources = [
    { id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes", description: "Write release notes" }], commands: [], mcpServers: [{ name: "jira" }], hooks: [], claudeMd: true },
    { id: plugin, kind: "plugin", name: "payments-skills", version: "1.4.0", enabled: true, skills: [{ name: "add-endpoint", context: { tokens: 900, percent: 1 } }, { name: "review-checklist", context: { tokens: 600, percent: 1 } }], commands: [], mcpServers: [], hooks: [{ name: "PreToolUse" }] },
  ];
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { sources, readAt: new Date().toISOString() } }));
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Use less of my setup");
  await chooseAgent(form);
  const setup = page.locator(".task-setup");

  // then
  await expect(setup.getByRole("heading", { name: "This task will use" })).toBeVisible();
  await expect(setup).toContainText("Your default setup: 6 of 6 on");
  await expect(setup).toContainText("Turn anything off for this task only; your default stays the same.");
  // each thing is said once: no second summary and no second sentence under the heading
  await expect(setup.getByText("Only for this task")).toHaveCount(0);
  await expect(setup.getByText(/on, .* off|servers not measured/)).toHaveCount(0);

  // when the list stands open on a wide screen
  await setup.getByRole("switch", { name: "Use payments-skills 1.4.0" }).uncheck();

  // then
  await expect(setup).toContainText("1 change from your default");
  await expect(setup.getByRole("link", { name: "Change your default on Team" })).toBeVisible();
  const offRow = setup.locator("li.handbook-off");
  await expect(offRow).toContainText("Off");
  await expect(offRow).toContainText("1 handbook");
  await expect(offRow.locator(":scope > .handbook-line").getByRole("switch")).toHaveCount(0);
  const rowLine = async (row: import("@playwright/test").Locator) => row.locator(":scope > .handbook-line").boundingBox();
  const sourceLine = await rowLine(setup.locator("li.handbook").first());
  expect((await rowLine(offRow))!.height).toBeCloseTo(sourceLine!.height, 0);
  expect(await offRow.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");

  // when
  await setup.getByRole("button", { name: "Reset" }).click();

  // then
  await expect(setup).toContainText("Your default setup: 6 of 6 on");

  // when
  await setup.getByRole("switch", { name: "Use payments-skills 1.4.0" }).uncheck();
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => started).toMatchObject({ off: { sources: [plugin] } });
});

test("given a plugin that runs hooks and a server, when the task form opens, then one notice says so with Look, Start stays, and × puts it away and tells the orchestrator", async ({ page }) => {
  // given
  const noticed: unknown[] = [];
  const docs = { id: "plugin:docs-kit@payments-market", kind: "plugin", name: "docs-kit", version: "2.0.0", enabled: true, skills: [{ name: "write-docs" }], commands: [], mcpServers: [{ name: "docs-search" }], hooks: [{ name: "PreToolUse" }, { name: "Stop" }], notice: { hooks: 2, mcpServers: 1 } };
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { sources: [docs], readAt: new Date().toISOString() } }));
  await page.route("**/api/handbook/noticed", (route) => {
    noticed.push(route.request().postDataJSON());
    return route.fulfill({ json: { noticed: "docs-kit@payments-market@2.0.0" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  await expect(page.locator(".handbook-news")).toContainText("docs-kit 2.0.0 runs 2 hooks and 1 MCP server. Look Got it");
  await expect(form.getByRole("button", { name: "Start task" })).toBeVisible();
  await expect(page.locator(".task-setup")).toContainText("Your default setup: 4 of 4 on");

  // when
  await page.getByRole("button", { name: "Got it" }).click();

  // then
  await expect(page.locator(".handbook-news")).toHaveCount(0);
  await expect(page.getByText("Put away; nothing changed.")).toBeVisible();
  await expect.poll(() => noticed).toEqual([{ plugin: "plugin:docs-kit@payments-market" }]);
});

test("given the orchestrator reads handbooks, when the new task form is wide, then This task will use stands to the form's right, and narrow it sits under the form", async ({ page }) => {
  // given
  const sources = [{ id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes" }], commands: [], mcpServers: [], hooks: [] }];
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { sources, readAt: new Date().toISOString() } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  const setup = page.locator(".task-setup");
  await expect(setup).toBeVisible();

  // then wide
  const formBox = (await form.boundingBox())!;
  const wide = (await setup.boundingBox())!;
  expect(wide.x).toBeGreaterThanOrEqual(formBox.x + formBox.width - 1);
  expect(Math.abs(wide.y - formBox.y)).toBeLessThan(40);

  // when narrow
  await page.setViewportSize({ width: 800, height: 900 });

  // then
  const narrow = (await setup.boundingBox())!;
  expect(narrow.y).toBeGreaterThanOrEqual(formBox.y + formBox.height - 2);
});

test("given a handbook with a long skill name and unused items, when the task panel lists them at 1440, then every row is one line, names are cut with the whole name in the title, switches share one right edge, and no use note stands in a row", async ({ page }) => {
  // given
  const long = "release-notes-for-the-payments-webhook-retry-queue-and-its-dead-letter-handling-in-every-region";
  const sources = [{ id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: long, used: { tasks: 0, lastAt: null } }, { name: "standup", used: { tasks: 0, lastAt: null } }, { name: "changelog" }], commands: [], mcpServers: [], hooks: [] }];
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { sources, readAt: new Date().toISOString() } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo/tasks");
  await newTaskForm(page);
  await page.locator(".task-setup .handbook-name").first().click();

  // when
  const rows = await page.locator(".task-setup .handbook-row").evaluateAll((els) => els.map((el) => { const line = el.querySelector(".handbook-line")!.getBoundingClientRect(); const sw = el.querySelector("[role=switch]")!.getBoundingClientRect(); return { height: Math.round(line.height), right: Math.round(sw.right), cut: (el.querySelector(".handbook-name") as HTMLElement).scrollWidth > (el.querySelector(".handbook-name") as HTMLElement).clientWidth }; }));

  // then
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.height)).size).toBe(1);
  expect(new Set(rows.map((r) => r.right)).size).toBe(1);
  await expect(page.locator(".task-setup")).not.toContainText("Not used in 30 days");
  await expect(page.locator(".task-setup .handbook-name", { hasText: "release-notes-for" })).toHaveAttribute("title", long);
});

test("given the new task form at 1440, when the panel's edge is dragged, stepped by arrow and double pressed, then the panel changes width within its limits, keeps it after a reload, and goes back to its default", async ({ page }) => {
  // given
  const sources = [{ id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "standup" }], commands: [], mcpServers: [], hooks: [] }];
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { sources, readAt: new Date().toISOString() } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/demo/tasks");
  await newTaskForm(page);
  const panel = page.locator(".task-setup");
  const handle = page.getByRole("separator", { name: "Width of the side panel" });
  const width = async () => Math.round((await panel.boundingBox())!.width);

  // then the default
  await expect.poll(width).toBe(420);

  // when dragged left by 100 px
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + 40, { steps: 5 });
  await page.mouse.up();

  // then wider, and kept
  await expect.poll(width).toBeGreaterThan(500);
  const dragged = await width();
  await page.reload();
  await newTaskForm(page);
  await expect.poll(width).toBe(dragged);

  // when stepped by arrow past the half of the window
  await handle.focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowLeft");

  // then it stops at half the window
  await expect.poll(width).toBeLessThanOrEqual(720);

  // when the arrows take it in past the least
  for (let i = 0; i < 80; i++) await page.keyboard.press("ArrowRight");

  // then it stops at its least
  await expect.poll(width).toBe(320);

  // when double pressed
  await handle.dblclick();

  // then it is the default again
  await expect.poll(width).toBe(420);
});
