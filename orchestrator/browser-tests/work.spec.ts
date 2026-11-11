import { expect, test } from "@playwright/test";
import { connectJira, jiraSite } from "./jira-site.js";
import { stateFor } from "./roles.js";
import { GUESSED_MOVES, JIRA, sprintItems, standInStart, standInWork } from "./work-fixtures.js";

test.describe("the Work tab", () => {
  test("given an orchestrator run by its own team with no tracker, when it opens, then Work is a tab and says in one sentence how to connect one", async ({ page }) => {
    // when
    await page.goto("/demo/tasks");
    await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Work" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/work$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Work");
    await expect(page.getByRole("main").getByRole("link", { name: "Connect Jira, Linear or GitLab issues" })).toHaveAttribute("href", "/demo/integrations?open=jira");
  });

  test("given the cloud and no tracker, when Work opens, then one sentence says how to connect the team's tracker and leads to Integrations", async ({ page }) => {
    // given
    await standInWork(page, { cloud: true, sources: [] });

    // when
    await page.goto("/demo/tasks");
    await page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Work" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/work$/);
    await expect(page.getByRole("main").getByRole("link", { name: "Connect Jira, Linear or GitLab issues" })).toHaveAttribute("href", "/demo/integrations?open=jira");
  });

  test("given a tracker connected on an orchestrator run by its own team, when the search is used, then Work is offered there and as a tab", async ({ page }) => {
    // given
    await standInWork(page);

    // when
    await page.goto("/demo/activity");
    await page.getByRole("button", { name: /^Search/ }).click();
    await page.getByRole("searchbox", { name: "Search pages, projects and tasks" }).fill("sprint");

    // then
    await expect(page.getByRole("option", { name: /^Work/ }).first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link", { name: "Work" })).toBeVisible();
  });
});

test.describe("the sprint board", () => {
  test("given the team's Jira board, when Work opens, then its own columns hold the issues, each agent's work is a badge on its card, and the header counts the sprint", async ({ page }) => {
    // given
    await standInWork(page);

    // when
    await page.goto("/demo/work");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments Sprint 31");
    await expect(page.getByText(/^2026-10-27 to 2026-11-07, (\d+ days? left|ended)\. Goal: Refunds and statements\.$/)).toBeVisible();
    const board = page.getByRole("group", { name: "Payments Sprint 31 board" });
    await expect(board.getByRole("heading", { level: 2 })).toHaveText([/^Ready for Dev 2/, /^In Dev 1/, /^Code Review 1/, /^Ready for Test 0/, /^In Test 1/, /^Test Passed 0/, /^Done 2/, /^Other 1/]);

    const working = board.getByRole("listitem", { name: "PAY-103 Retry a failed card capture" });
    await expect(working.getByRole("link", { name: "working" })).toHaveAttribute("href", "/demo/tasks/tsk_working");
    const review = board.getByRole("listitem", { name: "PAY-104 Export statements as CSV" });
    await expect(review.getByRole("link", { name: "in review on GitLab" })).toBeVisible();
    await expect(review.getByRole("link", { name: "Merge request !42 on GitLab" })).toHaveAttribute("href", "https://forge.example/acme/payments-api/merge_requests/42");
    await expect(board.getByRole("listitem", { name: "PAY-105 Block a card from the app" })).toContainText("Blocked");
    await expect(board.getByRole("listitem", { name: "PAY-107 Name the payee on the receipt" }).getByRole("link", { name: "payments-api #40" })).toHaveAttribute("href", "/demo/tasks/tsk_merged");
    await expect(board.getByRole("listitem", { name: "PAY-101 Round refunds half to even" }).getByRole("link", { name: "PAY-101" })).toHaveAttribute("href", "https://acme.atlassian.example/browse/PAY-101");

    const progress = page.getByRole("region", { name: "Sprint progress" });
    await expect(progress).toContainText("3 of 8 done");
    await expect(progress).toContainText("1 in review on GitLab");
    await expect(progress).toContainText("1 flagged");
    await expect(progress).toContainText("for $1.65, some unreported");
    await expect(progress).toContainText("9 of 24 points done");
    await expect(page.getByText("Read from the tracker at 09:00 UTC")).toBeVisible();
  });

  test("given issues assigned to the person and tasks they started, when My work is picked, then only those show, each card says who started its agent, and the address keeps the filter", async ({ page }) => {
    // given
    await standInWork(page);
    await page.goto("/demo/work");
    const board = page.getByRole("group", { name: "Payments Sprint 31 board" });
    await expect(board.getByRole("listitem", { name: "PAY-103 Retry a failed card capture" })).toContainText("started by you");
    await expect(board.getByRole("listitem", { name: "PAY-104 Export statements as CSV" })).toContainText("started by pat@example.invalid");

    // when
    await page.getByRole("group", { name: "Whose work" }).getByRole("button", { name: "My work 3" }).click();

    // then
    await expect(page).toHaveURL(/mine=1/);
    await expect(board.getByRole("listitem")).toHaveCount(3);
    for (const key of ["PAY-101", "PAY-103", "PAY-107"]) await expect(board.getByRole("listitem", { name: new RegExp(`^${key} `) })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("group", { name: "Whose work" }).getByRole("button", { name: "My work 3" })).toHaveAttribute("aria-pressed", "true");
  });

  test("given an answer the server kept while it reads the tracker again, when the board shows it, then it says the board is refreshing", async ({ page }) => {
    // given
    await standInWork(page, { items: () => ({ ...sprintItems(), stale: true }) });

    // when
    await page.goto("/demo/work");

    // then
    await expect(page.getByRole("status").filter({ hasText: "Read from the tracker at 09:00 UTC" })).toContainText("refreshing The tracker is being read again");
  });

  test("given a running agent, when the board asks again, then its card's badge follows the task without a reload", async ({ page }) => {
    // given
    let phase: "working" | "review" = "working";
    await page.clock.install();
    await standInWork(page, {
      items: () => {
        const read = sprintItems();
        const card = read.items.find((i) => i.key === "PAY-103")!;
        card.tasks = [{ ...card.tasks[0]!, phase, status: phase === "review" ? "needs-review" : "running" }];
        return read;
      },
    });
    await page.goto("/demo/work");
    const card = page.getByRole("listitem", { name: "PAY-103 Retry a failed card capture" });
    await expect(card.getByRole("link", { name: "working" })).toBeVisible();

    // when
    phase = "review";
    await page.clock.runFor(11_000);

    // then
    await expect(card.getByRole("link", { name: "needs you" })).toBeVisible();
  });

  test("given a later sprint picked, when the board reloads, then the address keeps the pick", async ({ page }) => {
    // given
    await standInWork(page);
    await page.goto("/demo/work");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments Sprint 31");

    // when
    await page.getByRole("combobox", { name: "Sprint" }).click();
    await page.getByRole("option", { name: /^Payments Sprint 32/ }).click();

    // then
    await expect(page).toHaveURL(/sprint=sprint%3A32/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments Sprint 32");
  });

  test("given a tracker that refuses its token, when Work opens, then it says why instead of an empty board", async ({ page }) => {
    // given
    await standInWork(page, { sources: [{ ...JIRA, problem: "the tracker refused the token (401)" }] });

    // when
    await page.goto("/demo/work");

    // then
    await expect(page.getByText("Couldn't load Jira (acme.atlassian.example). the tracker refused the token (401)")).toBeVisible();
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("given the board at 390 pixels, when another column is picked, then one column shows at a time with its count", async ({ page }) => {
      // given
      await standInWork(page);
      await page.goto("/demo/work");
      const columns = page.getByRole("group", { name: "Columns" });

      // then
      await expect(columns.getByRole("button", { name: "Ready for Dev column, 2" })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("heading", { name: /^Ready for Dev/, level: 2 })).toBeVisible();
      await expect(page.getByRole("heading", { name: /^Code Review/, level: 2 })).toBeHidden();

      // when
      await columns.getByRole("button", { name: "Code Review column, 1" }).click();

      // then
      await expect(page.getByRole("heading", { name: /^Code Review/, level: 2 })).toBeVisible();
      await expect(page.getByRole("listitem", { name: "PAY-104 Export statements as CSV" })).toBeVisible();
      await expect(page.getByRole("heading", { name: /^Ready for Dev/, level: 2 })).toBeHidden();
    });
  });

  test.describe("a member whose team has no board", () => {
    test.use({ storageState: stateFor("member") });

    test("given no board mapped to their team, when Work opens, then it says to ask an owner or an admin", async ({ page }) => {
      // given
      await standInWork(page, { boards: [] });

      // when
      await page.goto("/demo/work");

      // then
      await expect(page.getByText("No board is mapped to your team yet. Ask an owner or an admin to map your team's board.")).toBeVisible();
    });
  });
});

test.describe("moving issues as the agent works", () => {
  test("given a board nobody set moves for, when it first opens, then the guess from its columns is offered and one click turns it on", async ({ page }) => {
    // given
    const { saved } = await standInWork(page, { moves: GUESSED_MOVES });

    // when
    await page.goto("/demo/work");

    // then
    const offer = page.getByRole("region", { name: "Move issues as the agent works?" });
    await expect(offer).toContainText("Each issue moves on this board when its agent starts, to In Dev; when its request opens, to Code Review; when its request is merged, to Done.");
    const toggle = page.getByRole("switch", { name: "Move issues as the agent works" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // when
    await offer.getByRole("button", { name: "Turn on" }).click();

    // then
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(offer).toHaveCount(0);
    expect(saved).toEqual([{ enabled: true, moves: { started: "In Dev", requestOpened: "Code Review", merged: "Done" } }]);
  });

  test("given moves on, when the column for an opened request is changed, then only that column changes and the switch stays on", async ({ page }) => {
    // given
    const { saved } = await standInWork(page, { moves: { ...GUESSED_MOVES, guessed: false, enabled: true } });
    await page.goto("/demo/work");

    // when
    await page.getByRole("button", { name: "Columns" }).click();
    const form = page.getByRole("form", { name: "Where issues move" });
    await form.getByRole("combobox", { name: "When its request opens" }).click();
    await page.getByRole("option", { name: "Ready for Test" }).click();
    await form.getByRole("button", { name: "Save" }).click();

    // then
    expect(saved).toEqual([{ enabled: true, moves: { started: "In Dev", requestOpened: "Ready for Test", merged: "Done" } }]);
    await expect(page.getByRole("switch", { name: "Move issues as the agent works" })).toHaveAttribute("aria-checked", "true");
  });

  test("given a tracker the orchestrator cannot write to, when the board opens, then the switch is off and disabled, says why, and leads to allowing Jira writes", async ({ page }) => {
    // given
    await standInWork(page, { moves: { ...GUESSED_MOVES, write: { allowed: false, reason: "Your atlassian server does not allow transitionJiraIssue.", off: false } } });

    // when
    await page.goto("/demo/work");

    // then
    const toggle = page.getByRole("switch", { name: "Move issues as the agent works" });
    await expect(toggle).toBeDisabled();
    await expect(page.getByText("Your atlassian server does not allow transitionJiraIssue.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Allow Jira writes" })).toHaveAttribute("href", "/demo/integrations?allow=transitionJiraIssue");
    await expect(page.getByRole("region", { name: "Move issues as the agent works?" })).toHaveCount(0);
  });

  test("given the organization's tracker and a person who may not change it, when the board opens, then the switch is disabled and says who changes it", async ({ page }) => {
    // given
    await standInWork(page, { moves: { ...GUESSED_MOVES, canChange: false } });

    // when
    await page.goto("/demo/work");

    // then
    await expect(page.getByRole("switch", { name: "Move issues as the agent works" })).toBeDisabled();
    await expect(page.getByText("Only an owner or an admin changes this for the organization's tracker.")).toBeVisible();
  });
});

test.describe("starting agents on picked issues", () => {
  test("given two picked issues, when Start agents opens, then one ask covers both, each issue shows the suggested skill with its reason, and a changed pick is what starts", async ({ page }) => {
    // given
    await standInWork(page);
    const start = await standInStart(page);
    await page.goto("/demo/work");
    await page.getByRole("checkbox", { name: "Pick PAY-101" }).check();
    await page.getByRole("checkbox", { name: "Pick PAY-102" }).check();

    // when
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();

    // then
    const form = page.getByRole("form", { name: "Start agents" });
    const first = form.getByRole("listitem", { name: "PAY-101 Round refunds half to even" });
    await expect(first.getByRole("checkbox", { name: /add-endpoint/ })).toBeChecked();
    await expect(first.getByRole("checkbox", { name: /write-migration/ })).not.toBeChecked();
    await expect(first).toContainText("add-endpoint: the issue adds a route to the payments API");
    expect(start.asked()).toHaveLength(1);
    expect((start.asked()[0]!.items as unknown[]).length).toBe(2);

    // when
    await first.getByRole("checkbox", { name: /write-migration/ }).check();
    await form.getByRole("button", { name: "Start 2 agents" }).click();

    // then
    await expect(page.getByRole("region", { name: /^Start agents/ }).getByRole("status")).toBeVisible();
    expect((start.sent()!.items as { skills?: string[] }[]).map((i) => i.skills)).toEqual([["add-endpoint", "write-migration"], ["add-endpoint"]]);
  });

  test("given one person's own orchestrator with no repository on record, when issues are picked and started, then no repository is asked for and each issue starts the way the Tasks box starts one", async ({ page }) => {
    // given
    await standInWork(page);
    await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
    });
    await page.route("**/api/tasks/options", async (route) => {
      const real = await route.fetch().then((r) => r.json());
      await route.fulfill({ json: { ...real, repos: [], multiRepo: null } });
    });
    const sent: Record<string, unknown>[] = [];
    await page.route("**/api/tasks", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON() as Record<string, unknown>;
      sent.push(body);
      const n = sent.length;
      return route.fulfill({ json: { task: { id: `t${n}`, title: body.title, status: "queued", phase: "waiting", repoId: "code", team: "Mine", description: "", issueUrl: body.issueUrl, issueKey: null, agent: body.agent, createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null } } });
    });
    await page.goto("/demo/work");
    await page.getByRole("checkbox", { name: "Pick PAY-101" }).check();
    await page.getByRole("checkbox", { name: "Pick PAY-102" }).check();

    // when
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();

    // then
    const panel = page.getByRole("region", { name: /^Start agents/ });
    await expect(panel).not.toContainText("Connect a repository");
    await expect(panel.getByRole("group", { name: "Repositories" })).toHaveCount(0);
    await expect(panel.getByLabel("Repository")).toHaveCount(0);

    // when
    await panel.getByRole("button", { name: "Start 2 agents" }).click();

    // then
    await expect(panel.getByRole("status")).toContainText("2 agents started");
    expect(sent.map((b) => [b.title, "repoId" in b])).toEqual([["Round refunds half to even", false], [expect.any(String), false]]);
    expect(sent.every((b) => typeof b.issueUrl === "string" && b.issueUrl)).toBe(true);
  });

  test("given two issues picked on the board, when agents start, then one request goes out with both issues, the agent finds the repositories, and each issue says whether it started", async ({ page }) => {
    // given
    await standInWork(page);
    const start = await standInStart(page, { refuse: [1] });
    await page.goto("/demo/work");
    await page.getByRole("checkbox", { name: "Pick PAY-101" }).check();
    await page.getByRole("checkbox", { name: "Pick PAY-102" }).check();
    const bar = page.getByRole("region", { name: "Picked issues" });
    await expect(bar).toContainText("2 issues picked");

    // when
    await bar.getByRole("button", { name: "Start agents" }).click();
    const form = page.getByRole("form", { name: "Start agents" });
    await expect(form.getByRole("radio", { name: /^Let each agent find the repositories/ })).toBeChecked();
    await expect(form.getByRole("checkbox", { name: /add-endpoint/ })).toHaveCount(2);
    await form.getByRole("button", { name: "Start 2 agents" }).click();

    // then
    const panel = page.getByRole("region", { name: /^Start agents/ });
    await expect(panel.getByRole("status")).toHaveText("1 of 2 agents started. Their cards show where each stands.");
    await expect(panel.getByRole("listitem").filter({ hasText: "PAY-101" }).getByRole("link", { name: "started" })).toHaveAttribute("href", "/demo/tasks/tsk_started_0");
    await expect(panel.getByRole("listitem").filter({ hasText: "PAY-102" })).toContainText("not started: this month's task budget for Payments is spent");

    // when
    await panel.getByRole("button", { name: "Done picking" }).click();

    // then
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Pick PAY-101" })).not.toBeChecked();
    const sent = start.sent()!;
    expect(sent.items).toEqual([
      { issueUrl: "https://acme.atlassian.example/browse/PAY-101", repoId: "payments-api", targets: "orchestrator", skills: ["add-endpoint"] },
      { issueUrl: "https://acme.atlassian.example/browse/PAY-102", repoId: "payments-api", targets: "orchestrator", skills: ["add-endpoint"] },
    ]);
  });

  test("given one code repository, when an issue from the backlog is started, then it runs there without asking the agent to find repositories", async ({ page }) => {
    // given
    await standInWork(page, { backlog: () => ({ ...sprintItems(), items: sprintItems().items.slice(0, 1).map((i) => ({ ...i, key: "PAY-120", summary: "Refund to a closed card", url: "https://acme.atlassian.example/browse/PAY-120" })) }) });
    const start = await standInStart(page, { multiRepo: false });
    await page.goto("/demo/work");
    await page.getByRole("navigation", { name: "Work" }).getByRole("link", { name: "Backlog" }).click();

    // when
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Backlog");
    await page.getByRole("checkbox", { name: "Pick PAY-120" }).check();
    await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
    const form = page.getByRole("form", { name: "Start agents" });
    await expect(form.getByRole("radio")).toHaveCount(0);
    await expect(form.getByRole("checkbox", { name: /add-endpoint/ })).toBeChecked();
    await form.getByRole("button", { name: "Start 1 agent" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "1 agent started. Its card shows where it stands." })).toBeVisible();
    expect(start.sent()!.items).toEqual([{ issueUrl: "https://acme.atlassian.example/browse/PAY-120", repoId: "payments-api", skills: ["add-endpoint"] }]);
  });

  test("given twenty issues picked, when the twenty-first is reached, then it cannot be picked and the bar says that is as many as start at once", async ({ page }) => {
    // given
    const many = Array.from({ length: 21 }, (_, i) => ({ ...sprintItems().items[0]!, key: `PAY-${200 + i}`, summary: `Issue ${i}` }));
    await standInWork(page, { backlog: () => ({ ...sprintItems(), items: many }) });
    await page.goto("/demo/work/backlog");

    // when
    for (let i = 0; i < 20; i++) await page.getByRole("checkbox", { name: `Pick PAY-${200 + i}` }).check();

    // then
    await expect(page.getByRole("region", { name: "Picked issues" })).toContainText("20 issues picked, as many as start at once");
    await expect(page.getByRole("checkbox", { name: "Pick PAY-220" })).toBeDisabled();
  });
});

test("given the orchestrator's own batch start and the stand-in agent, when an agent starts on a picked issue, then a real task opens with the issue as its link", async ({ page, request }) => {
  // given
  await standInWork(page);
  await page.goto("/demo/work");
  await page.getByRole("checkbox", { name: "Pick PAY-101" }).check();
  await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
  const form = page.getByRole("form", { name: "Start agents" });
  await form.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: "Demo agent" }).click();

  // when
  await form.getByRole("button", { name: "Start 1 agent" }).click();

  // then
  const started = page.getByRole("region", { name: /^Start agents/ }).getByRole("link", { name: "started" });
  await expect(started).toHaveAttribute("href", /^\/demo\/tasks\/[\w-]+$/);
  const id = (await started.getAttribute("href"))!.split("/").pop()!;
  const { task } = await (await request.get(`/api/tasks/${id}`)).json();
  expect(task.issueUrl).toBe("https://acme.atlassian.example/browse/PAY-101");
});

test("given the organization's Jira connected, when Work opens, then the orchestrator's own work reads draw the team's workflow and its backlog", async ({ page }) => {
  // given
  const { server, url } = await jiraSite();
  const disconnect = await connectJira(page, url);
  try {
    // when
    await page.goto("/demo/work");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments Sprint 41");
    const board = page.getByRole("group", { name: "Payments Sprint 41 board" });
    await expect(board.getByRole("heading", { level: 2 })).toHaveText([/^Ready for Dev 1/, /^In Dev 1/, /^Code Review 0/, /^Ready for Test 0/, /^In Test 0/, /^Test Passed 1/, /^Done 0/]);
    await expect(board.getByRole("listitem", { name: "PAY-302 Export statements as CSV" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Sprint progress" })).toContainText("0 of 3 done");

    // when
    await page.getByRole("navigation", { name: "Work" }).getByRole("link", { name: "Backlog" }).click();

    // then
    await expect(page.getByRole("listitem", { name: "PAY-310 Hide a card number in the log" })).toBeVisible();
  } finally {
    await disconnect();
    server.close();
  }
});
