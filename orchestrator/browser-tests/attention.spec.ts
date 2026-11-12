import { expect, test } from "@playwright/test";

// The tasks a person started, as the attention watcher reads them, from stand-in answers: the tab
// counts what waits on them, and the browser is told once per new call, never on the first look.

const task = (id: string, title: string, status: string, phase: string) => ({ id, title, status, phase, repoId: "payments-skills", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null });

test("given a task of the person's that moves to review, when the watcher looks again, then the tab counts it and the browser is told once", async ({ page }) => {
  // given
  let phase = "working";
  await page.clock.install();
  await page.addInitScript(() => {
    const told: string[] = [];
    (window as unknown as { told: string[] }).told = told;
    class Stand { static permission = "granted"; static requestPermission = async () => "granted"; onclick: (() => void) | null = null; constructor(title: string) { told.push(title); } }
    (window as unknown as { Notification: unknown }).Notification = Stand;
    localStorage.setItem("orchestrator.attention.notify", "yes");
  });
  let looks = 0;
  await page.route((url) => url.pathname === "/api/tasks", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    looks++;
    return route.fulfill({ json: { tasks: [task("t1", "Retry a failed capture", phase === "review" ? "needs-review" : "running", phase), task("t2", "Someone else's", "failed", "failed")].map((t, i) => (i === 1 ? { ...t, createdBy: "pat@example.invalid" } : t)), next: null } });
  });
  await page.goto("/demo/activity");
  await page.clock.runFor(1_000);
  // The first look only learns what each task wants; a call is told only on a look after it.
  await expect.poll(() => looks).toBeGreaterThan(0);
  await expect(page).toHaveTitle("TeamHandbook Orchestrator");

  // when
  phase = "review";
  await page.clock.runFor(16_000);

  // then
  await expect(page).toHaveTitle("(1) TeamHandbook Orchestrator");
  expect(await page.evaluate(() => (window as unknown as { told: string[] }).told)).toEqual(["Retry a failed capture needs review"]);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /^data:image\/png/);

  // when the next look finds the same
  await page.clock.runFor(16_000);

  // then it is not told again
  expect(await page.evaluate(() => (window as unknown as { told: string[] }).told)).toHaveLength(1);
});

test("given a running task whose plan waits for its person, when the watcher looks, then the tab counts it and a page left in a background tab does not count it as seen", async ({ page }) => {
  // given
  let planned = false;
  await page.clock.install();
  await page.addInitScript(() => {
    const told: string[] = [];
    (window as unknown as { told: string[] }).told = told;
    class Stand { static permission = "granted"; static requestPermission = async () => "granted"; onclick: (() => void) | null = null; constructor(title: string) { told.push(title); } }
    (window as unknown as { Notification: unknown }).Notification = Stand;
    localStorage.setItem("orchestrator.attention.notify", "yes");
    Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
  });
  let looks = 0;
  const waiting = () => ({ ...task("t7", "Add a retry", "running", "working"), state: planned ? "needs-you" : "working" });
  await page.route((url) => url.pathname === "/api/tasks", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    looks++;
    return route.fulfill({ json: { tasks: [waiting()], next: null } });
  });
  await page.route("**/api/tasks/t7?*", (route) => route.fulfill({ json: { task: waiting(), log: [], outputCut: false } }));
  await page.goto("/demo/tasks/t7");
  await page.clock.runFor(1_000);
  // The first look only learns what each task wants; the plan comes on a look after it.
  await expect.poll(() => looks).toBeGreaterThan(0);
  await page.clock.runFor(1_000);
  await expect(page).toHaveTitle("TeamHandbook Orchestrator");

  // when
  planned = true;
  await page.clock.runFor(61_000);

  // then
  await expect(page).toHaveTitle("(1) TeamHandbook Orchestrator");
  expect(await page.evaluate(() => (window as unknown as { told: string[] }).told)).toEqual(["Add a retry needs your approval"]);
});

test("given a browser that has not been asked, when the page of a task working for its person opens, then one quiet line offers notifications there only, and asking once or saying not now takes it away", async ({ page }) => {
  // given
  await page.addInitScript(() => {
    class Stand { static permission = "default"; static async requestPermission() { Stand.permission = "granted"; return "granted"; } }
    (window as unknown as { Notification: unknown }).Notification = Stand;
  });
  await page.route("**/api/tasks/t8?*", (route) => route.fulfill({ json: { task: task("t8", "Add a retry", "running", "working"), log: [], outputCut: false } }));
  await page.goto("/demo/tasks");
  const ask = page.getByRole("note", { name: "Notifications" });
  await expect(ask).toHaveCount(0);

  // when
  await page.goto("/demo/tasks/t8");

  // then
  await expect(ask).toContainText("Away from this page when it needs you?");
  await expect(ask.getByRole("button", { name: "Get a notification" })).not.toHaveClass(/secondary/);

  // when
  await ask.getByRole("button", { name: "Get a notification" }).click();

  // then
  await expect(ask).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("orchestrator.attention.notify"))).toBe("yes");

  // when a fresh browser says not now
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Not now" }).click();

  // then
  await expect(ask).toHaveCount(0);
  await page.reload();
  await expect(ask).toHaveCount(0);
});

test("given a call waiting, when the person opens that task, then the tab stops counting it", async ({ page }) => {
  // given
  await page.clock.install();
  await page.route((url) => url.pathname === "/api/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { tasks: [task("t9", "Broken build", "failed", "failed")], next: null } }) : route.fallback()));
  await page.goto("/demo/activity");
  await page.clock.runFor(1_000);
  await expect(page).toHaveTitle("(1) TeamHandbook Orchestrator");

  // when
  await page.route("**/api/tasks/t9?*", (route) => route.fulfill({ json: { task: task("t9", "Broken build", "failed", "failed"), log: [], outputCut: false } }));
  await page.goto("/demo/tasks/t9");
  await page.clock.runFor(16_000);

  // then
  await expect(page).toHaveTitle("TeamHandbook Orchestrator");
});

test("given the board's turns, when the task list opens, then what waits on the person leads with what it waits for and an empty turn is not drawn", async ({ page }) => {
  // given
  const card = (id: string, title: string, status: string, phase: string, next: string | null) => ({ id, title, repoId: "payments-skills", status, phase, next, createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), finishedAt: null, waitingFor: null, changes: next === "review" ? { files: 2, additions: 9, deletions: 2 } : null, request: null, cost: { usd: 0.41, inputTokens: null, outputTokens: null }, agent: "fake", startedAt: new Date().toISOString(), issueKey: null });
  await page.route("**/api/tasks/board", (route) => route.fulfill({ json: {
    sections: { yours: [card("t3", "Wants a command", "running", "working", "answer"), card("t1", "Ready to read", "needs-review", "review", "review")], agents: [card("t2", "Quiet one", "running", "working", null)], waiting: [], done: [] },
    counts: { yours: 2, agents: 1, waiting: 0, done: 0 },
  } }));

  // when
  await page.goto("/demo/tasks");

  // then the day is said once under the box, and each turn holds its own
  await expect(page.locator(".day-sentence")).toHaveText("2 wait on you, 1 is working.");
  const yours = page.getByRole("region", { name: /^Your turn/ });
  await expect(yours.getByRole("row")).toHaveCount(2);
  await expect(yours.getByRole("row").nth(0)).toContainText("needs you");
  await expect(yours.getByRole("row").nth(1)).toContainText("needs you");
  await expect(yours.getByRole("row").nth(1).getByRole("img", { name: "9 lines added, 2 removed" })).toBeVisible();
  await expect(page.getByRole("region", { name: /^The agents' turn/ })).toContainText("working");
  await expect(page.getByRole("region", { name: /^Done this week/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Which tasks" })).toHaveCount(0);
});
