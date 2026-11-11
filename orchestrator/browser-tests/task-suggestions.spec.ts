import { expect, test } from "@playwright/test";

// A teammate reviewing a task's request suggests a follow-up; it waits in front of the person who
// started the task, who alone passes it on to the agent or dismisses it.

const task = (over: Record<string, unknown> = {}) => ({ id: "t1", title: "Retry a failed capture", status: "needs-review", phase: "review", repoId: "payments-skills", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: new Date().toISOString(), baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null, startedBy: { name: "Ada Admin" }, ...over });
const suggestion = (over: Record<string, unknown> = {}) => ({ id: "fup_1", by: { name: "Pat Payments" }, text: "Retry only on a timeout, not on a 4xx.", quotes: [{ path: "src/capture.ts", lines: "11-12", text: "+retry()" }], createdAt: new Date().toISOString(), status: "waiting", canAnswer: true, ...over });

test.beforeEach(async ({ page }) => {
  // The page follows the task by polling once no stream opens.
  await page.addInitScript(() => delete (window as unknown as { EventSource?: unknown }).EventSource);
});

test("given a teammate's suggested follow-up, when its starter continues with it, then it is sent to its own route and the card says it was continued", async ({ page }) => {
  // given
  let answered: string | null = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ suggestions: [answered ? suggestion({ status: "continued", canAnswer: false }) : suggestion()] }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/suggestions/fup_1/*", (route) => {
    answered = new URL(route.request().url()).pathname.split("/").pop()!;
    return route.fulfill({ json: { suggestion: { id: "fup_1", status: "continued" } } });
  });
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("listitem", { name: "Pat Payments suggests a follow-up" });

  // then
  await expect(card).toContainText("Pat Payments suggests: Retry only on a timeout, not on a 4xx.");
  await expect(card.getByRole("list", { name: "Quoted lines" })).toHaveText("src/capture.ts:11-12");
  await expect(page.getByRole("heading", { name: /^Suggested follow-ups/ })).toContainText("1 waiting");

  // when
  await card.getByRole("button", { name: "Continue with it" }).click();

  // then
  await expect(card).toContainText("You continued with it.");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(answered).toBe("continue");
});

test("given a teammate reviewing someone else's task, when they suggest a follow-up, then it goes to the suggestions route with its words and their card waits for the starter with no button", async ({ page }) => {
  // given
  let sent: Record<string, unknown> | null = null;
  const theirs = () => task({ createdBy: "pat@example.invalid", startedBy: { name: "Pat Payments" }, suggests: true, suggestions: sent ? [suggestion({ by: { name: "Ada Admin" }, text: "Log the retry count.", quotes: null, canAnswer: false })] : [] });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: theirs(), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/suggestions", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 202, json: { suggestion: { id: "fup_2", status: "waiting" } } });
  });
  await page.goto("/demo/tasks/t1");
  const box = page.getByRole("form", { name: "Suggest a follow-up to Pat Payments" });

  // then
  await expect(box).toContainText("Pat Payments reads it first; the agent gets it only if they continue with it.");
  await expect(box.getByRole("button", { name: "Suggest" })).toBeDisabled();

  // when
  await box.getByLabel("What the agent should do").fill("Log the retry count.");
  await box.getByRole("button", { name: "Suggest" }).click();

  // then
  const card = page.getByRole("listitem", { name: "Ada Admin suggests a follow-up" });
  await expect(card).toContainText("Waiting for Pat Payments to continue with it or dismiss it.");
  await expect(card.getByRole("button")).toHaveCount(0);
  expect(sent).toMatchObject({ text: "Log the retry count." });
  expect(typeof (sent as unknown as { commandId: string }).commandId).toBe("string");
});

test("given a suggestion its starter dismissed and one the request outlived, when the writer reads them, then each says how it ended", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ createdBy: "pat@example.invalid", startedBy: { name: "Pat Payments" }, suggestions: [suggestion({ id: "a", status: "dismissed", canAnswer: false }), suggestion({ id: "b", status: "expired", canAnswer: false })] }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const cards = page.getByRole("list").filter({ has: page.getByRole("listitem", { name: /suggests a follow-up/ }) }).first().getByRole("listitem", { name: /suggests a follow-up/ });
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("The request ended before it was answered.");
  await expect(cards.nth(1)).toContainText("Pat Payments dismissed it.");
});
