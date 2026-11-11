import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chooseAgent, newTaskForm, optionsOf, work } from "./task-form.js";

const CANDIDATES = [
  { id: "checkout-service", name: "checkout-service", team: "Payments" },
  { id: "payments-bff", name: "payments-bff", team: "Payments" },
  { id: "api-gateway", name: "api-gateway", team: "Platform" },
];

/** Task options with three code repositories a task may span, and the start it would send. */
async function multiRepoForm(page: Page): Promise<{ sent: () => Record<string, unknown> | null }> {
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json()).catch(() => null);
    if (!real) return;
    const code = CANDIDATES.map((c) => ({ ...c, kind: "code", ticketExample: null }));
    await route.fulfill({ json: { ...real, repos: [...code, ...real.repos], multiRepo: { candidates: CANDIDATES, maxTargets: 5 } } });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    body = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  return { sent: () => body };
}

test("given one code project, when the form opens and a task starts, then it asks for no repository, the rail names the project and the start carries it", async ({ page }) => {
  // given
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json()).catch(() => null);
    if (!real) return;
    await route.fulfill({ json: { ...real, repos: [{ ...CANDIDATES[0], kind: "code", ticketExample: null }, ...real.repos], multiRepo: null } });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    body = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  await expect(form.getByRole("group", { name: /^Repositories/ })).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "checkout-service" })).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Before it starts" })).toContainText("checkout-service");

  // when
  await work(form, "Show the discount at checkout");
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({ repoId: "checkout-service" });
  expect(body).not.toHaveProperty("targets");
});

test("given the task options read before any code project and read again once one is there, when the form opens, then it is the form for that project rather than the one it first drew", async ({ page }) => {
  // given
  let reads = 0;
  await page.route("**/api/tasks/options", async (route) => {
    const real = await route.fetch().then((r) => r.json()).catch(() => null);
    if (!real) return;
    reads += 1;
    const first = reads === 1;
    await route.fulfill({ json: first
      ? { ...real, repos: [], agents: real.agents.map((a: Record<string, unknown>) => ({ ...a, readiness: null })) }
      : { ...real, repos: [{ ...CANDIDATES[0], kind: "code", ticketExample: null }, ...real.repos], multiRepo: null } });
  });
  await page.goto("/demo/tasks");
  const refused = page.getByRole("note").filter({ hasText: "You cannot start tasks" });
  await expect(refused).toBeVisible();

  // when the agents' check is read again, with the project there
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(1);

  // then
  const form = page.getByRole("form", { name: "New task" });
  await expect(page.getByRole("complementary", { name: "Before it starts" })).toContainText("checkout-service");
  await expect(form.getByRole("combobox", { name: "Repository" })).toHaveCount(0);
});

test("given code repositories and a pasted issue, when a task starts, then the agent decides the repositories by default, the issue shows with its title, and the line beside Start says what happens", async ({ page }) => {
  // given
  const start = await multiRepoForm(page);
  await page.route("**/api/issues/preview?*", (route) => route.fulfill({ json: { url: "https://tracker.example.invalid/browse/SHOP-233", key: "SHOP-233", title: "Show the discount at checkout", status: "To Do", reach: "The agent reads the issue's text and latest comments from the tracker before it starts." } }));
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then the form starts with the work, set to change code, with nothing more to fill
  await expect(form.getByRole("group", { name: "What changes" }).getByRole("button", { name: "Code" })).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByRole("combobox", { name: "Repository" })).toHaveCount(0);
  await expect(form.getByLabel("Title")).toBeHidden();
  await expect(form.getByRole("radio", { name: "Let the agent decide (recommended)" })).toBeChecked();

  // when
  await work(form, "https://tracker.example.invalid/browse/SHOP-233");

  // then
  await expect(form.getByRole("status", { name: "Issue" })).toContainText("SHOP-233 Show the discount at checkoutTo Do");
  await expect(form.getByRole("status", { name: "Issue" })).toContainText("The agent reads the issue's text and latest comments from the tracker before it starts.");
  await expect(form.locator(".actions.start")).toContainText("Reads SHOP-233, picks the repositories; a reviewer merges each change.");

  // when
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => start.sent()).toMatchObject({ targets: "orchestrator", issueUrl: "https://tracker.example.invalid/browse/SHOP-233", repoId: "checkout-service", title: "Show the discount at checkout" });
});

test("given code repositories, when some are picked, then they run in the order picked, and more than one without an issue is held back", async ({ page }) => {
  // given
  const start = await multiRepoForm(page);
  await page.route("**/api/issues/preview?*", (route) => route.fulfill({ json: { url: "https://tracker.example.invalid/browse/SHOP-233", key: "SHOP-233", title: null, status: null, reach: "The agent sees only the link; connect the issue tracker in Integrations so it reads the issue's text and comments." } }));
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Retry the payment webhook\nThree attempts, a minute apart.");

  // when
  await form.getByRole("radio", { name: "Pick repositories" }).check();
  const picks = form.getByRole("group", { name: "Repositories, in the order they run" });
  await picks.getByLabel("api-gateway").check();
  await picks.getByLabel("checkout-service").check();

  // then
  await expect(form.locator(".actions.start")).toContainText("Paste an issue link to let the agent pick the repositories or to change several.");
  await expect(form.getByRole("button", { name: "Start task" })).toBeDisabled();

  // when one is left, the work in words is enough
  await picks.getByLabel("api-gateway").uncheck();
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => start.sent()).toMatchObject({ repoId: "checkout-service", title: "Retry the payment webhook", issueUrl: "" });
  expect(start.sent()).not.toHaveProperty("targets");

  // when an issue is given and two are picked
  await work(form, "https://tracker.example.invalid/browse/SHOP-233");
  await picks.getByLabel("payments-bff").check();

  // then
  await expect(form.getByRole("status", { name: "Issue" })).toContainText("The agent sees only the link; connect the issue tracker in Integrations");
  await expect(form.locator(".actions.start")).toContainText("Works from SHOP-233, changes checkout-service and payments-bff in that order; a reviewer merges each change.");
  await form.getByRole("button", { name: "Start task" }).click();
  await expect.poll(() => start.sent()?.targets).toEqual(["checkout-service", "payments-bff"]);
});

test("given tasks that run on people's own machines, when the form opens over code projects, then it offers one project to pick and nothing the orchestrator would run", async ({ page }) => {
  // given
  const start = await multiRepoForm(page);
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, tasksRunHere: false } } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // then
  await expect(form.getByRole("group", { name: "Repositories, in the order they run" })).toBeVisible();
  await expect(form.getByRole("radio")).toHaveCount(0);
  await expect(form.getByText("Let the agent decide")).toHaveCount(0);

  // when one project is picked
  await form.getByRole("checkbox", { name: "checkout-service" }).check();

  // then no second one is offered beside it
  await expect(form.getByRole("checkbox", { name: "payments-bff" })).toBeDisabled();
  await expect(form.getByRole("checkbox", { name: "api-gateway" })).toBeDisabled();

  // when it starts
  await work(form, "Show the discount at checkout");
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then the start names that project alone, with no targets for the orchestrator to plan
  await expect.poll(() => start.sent()).not.toBeNull();
  expect(start.sent()).toMatchObject({ repoId: "checkout-service" });
  expect(start.sent()).not.toHaveProperty("targets");
});

test("given team skills chosen, when the form switches to them, then it asks for the repository and the kind of change, and the skill templates are there", async ({ page }) => {
  // given
  await multiRepoForm(page);
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await form.getByRole("group", { name: "What changes" }).getByRole("button", { name: "Team skills" }).click();

  // then
  expect(await optionsOf(form, "Repository")).toEqual(["payments-skills Payments", "platform-skills Platform"]);
  expect(await optionsOf(form, "Kind of task")).toEqual(["Any change", "Write a new skill", "Improve a skill", "Refresh the TeamHandbook scaffold", "Switch the plugin to versioning by commit"]);
  await expect(form.getByRole("radio", { name: "Let the agent decide (recommended)" })).toHaveCount(0);
});

test("given a task over three repositories, when its page follows it, then it plans first and then shows a card per repository with its reason, status, tests and request", async ({ page }) => {
  // given
  const base = {
    id: "tsk_multirepo00000000000000", repoId: "checkout-service", team: "Payments", title: "Work on PAY-142", description: "", issueUrl: "https://tracker.example.invalid/browse/PAY-142", issueKey: "PAY-142",
    agent: "fake", createdBy: "ada@example.invalid", createdAt: "2026-10-27T10:00:00.000Z", startedAt: "2026-10-27T10:00:01.000Z", finishedAt: null, baseSha: null, tests: null,
    cost: { usd: 0.42, inputTokens: null, outputTokens: null }, costPartial: true, requestNumber: null, error: null, template: null, queuePosition: null, request: null,
  };
  const planning = { ...base, status: "running", targets: [] };
  const working = {
    ...base, status: "running", targets: [
      { repoId: "checkout-service", name: "checkout-service", status: "request", reason: "The discount is computed here.", tests: "passed", error: null, request: { number: 7, url: "https://forge.example.invalid/checkout/7", status: "open" } },
      { repoId: "payments-bff", name: "payments-bff", status: "working", reason: "It passes the discount to the app.", tests: null, error: null, request: null },
      { repoId: "api-gateway", name: "api-gateway", status: "planned", reason: "Chosen by Ada Admin", tests: null, error: null, request: null },
    ],
  };
  const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  await page.route(`**/api/tasks/${base.id}/events*`, (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: event("connected", { after: 0 }) + event("task", planning) }));
  let reads = 0;
  await page.route(new RegExp(`/api/tasks/${base.id}\\?`), (route) => {
    reads += 1;
    return route.fulfill({ json: { task: reads > 1 ? working : planning, log: [{ seq: 1, at: "2026-10-27T10:00:02.000Z", text: "Planned 3 repositories: checkout-service, payments-bff, api-gateway." }], outputCut: false } });
  });

  // when
  await page.goto(`/demo/tasks/${base.id}`);

  // then
  const repositories = page.getByRole("region", { name: /^Repositories/ });
  await expect(repositories.getByRole("status")).toHaveText("Planning which repositories the change needs…");
  await expect(repositories.getByRole("listitem")).toHaveCount(3, { timeout: 10_000 });
  const first = repositories.getByRole("listitem", { name: "checkout-service, in review" });
  await expect(first).toContainText("The discount is computed here.");
  await expect(first).toContainText("passed");
  await expect(first.getByRole("link", { name: /^(Merge request !7 on GitLab|Pull request #7 on GitHub|See it on the forge)$/ })).toHaveAttribute("href", "https://forge.example.invalid/checkout/7");
  await expect(repositories.getByRole("listitem", { name: "payments-bff, working" })).toBeVisible();
  await expect(repositories.getByRole("listitem", { name: "api-gateway, waiting its turn" })).toContainText("Chosen by Ada Admin");
  await expect(page.getByText("Cost").locator("..")).toContainText("some parts unreported");
});
