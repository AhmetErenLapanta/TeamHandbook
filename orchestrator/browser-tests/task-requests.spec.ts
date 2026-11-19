import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { standInChanges } from "./request-changes";
import { stateFor } from "./roles.js";
import { taskLog } from "./task-page.js";
import { choose, chooseAgent, newTaskForm, work } from "./task-form.js";

// A task page from stand-in answers: what the agent asks waits on the person who started the
// task, and a task ready for review opens its changes until that person closes them.

const task = (over: Record<string, unknown> = {}) => ({ id: "t1", title: "Retry a failed capture", status: "running", phase: "working", repoId: "payments-skills", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null, ...over });
const asked = (over: Record<string, unknown> = {}) => ({ id: "r1", kind: "command", payload: { tool: "Bash", summary: "npm test" }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: new Date().toISOString(), ...over });

test.beforeEach(async ({ page }) => {
  // The page follows the task by polling once no stream opens.
  await page.addInitScript(() => delete (window as unknown as { EventSource?: unknown }).EventSource);
});

test("given the agent asks to run a command, when its starter allows it once, then the decision is sent and the card says who allowed it", async ({ page }) => {
  // given
  let answered = false;
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/t1?*", (route) =>
    route.fulfill({ json: { task: task({ requests: [answered ? asked({ status: "answered", answer: { decision: "allow_once" }, answeredBy: "Ada" }) : asked()] }), log: [], outputCut: false } }),
  );
  await page.route("**/api/tasks/t1/requests/r1", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    answered = true;
    return route.fulfill({ json: asked({ status: "answered", answer: { decision: "allow_once" }, answeredBy: "Ada" }) });
  });
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("listitem", { name: "The agent asks to run a command" });
  await expect(card).toContainText("Bash: npm test");

  // when
  await card.getByRole("button", { name: "Allow once" }).click();

  // then
  await expect(card).toContainText("You allowed once.");
  expect(sent).toMatchObject({ answer: { decision: "allow_once" } });
  expect((sent as unknown as { answer: Record<string, unknown> }).answer).not.toHaveProperty("note");
});

test("given someone else's task asks, when a teammate opens it, then the card names who answers and offers no decision", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ createdBy: "pat@example.invalid", requests: [asked()] }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const card = page.getByRole("listitem", { name: "The agent asks to run a command" });
  await expect(card).toContainText("Waiting for the person who started this task to answer.");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("given a task ready for review, when its page opens, then its changes are the page with no fold of their own, the log is folded under them, and a log the person opens stays open on the next visit", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", requestNumber: 7, request: { status: "open", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" } }), log: [{ seq: 1, at: "2026-11-03T10:00:00Z", text: "Started" }], outputCut: false } }));
  await standInChanges(page, "payments-skills", 7, [{ path: "src/capture.ts", status: "modified", additions: 2, deletions: 1, patch: "+retry" }]);

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const changes = page.getByRole("region", { name: /^Changes/ });
  await expect(changes.getByRole("heading", { level: 2 })).toHaveText(/^Changes/);
  await expect(changes).toContainText("src/capture.ts");
  await expect(changes.locator(".diff-stat")).toHaveText("+2 −1");
  await expect(changes).not.toContainText("1 file,");
  await expect(changes.locator("details.request-diff")).toHaveCount(0);
  await expect(page.locator("header.page-head").getByRole("link", { name: "Open the request" })).toBeVisible();
  const log = page.locator("details.log-fold");
  await expect(log).not.toHaveAttribute("open", "");

  // when
  await log.locator("summary").click();
  await expect((await taskLog(page))).toContainText("Started");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("orchestrator.task.log"))).toBe("open:t1");
  await page.reload();

  // then it is open on this task, and another task's log is folded again
  await expect(page.locator("details.log-fold")).toHaveAttribute("open", "");
  await page.route("**/api/tasks/t2?*", (route) => route.fulfill({ json: { task: task({ id: "t2", status: "needs-review", phase: "review", requestNumber: 8, request: { status: "open", provider: "local", branch: "handbook/t2", url: "local://requests/payments-skills/8" } }), log: [], outputCut: false } }));
  await standInChanges(page, "payments-skills", 8, [{ path: "src/capture.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }]);
  await page.goto("/demo/tasks/t2");
  await expect(page.locator("details.log-fold")).not.toHaveAttribute("open", "");
});

test("given a log with two failing lines, when the person finds 'failed' and presses Enter, then the count moves to the second match and each match is marked", async ({ page }) => {
  // given
  const line = (seq: number, text: string) => ({ seq, at: "2026-11-03T10:00:0" + seq + "Z", text });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed" }), log: [line(1, "Cloning payments-api"), line(2, "npm test: 3 FAILED"), line(3, "retrying the failed tests")], outputCut: false } }));
  await page.goto("/demo/tasks/t1");
  const find = page.getByRole("search").getByLabel("Find in the log");

  // when
  await find.fill("failed");

  // then
  await expect(page.getByRole("status").filter({ hasText: "of 2" })).toHaveText("1 of 2");
  await expect(page.locator(".task-log mark")).toHaveCount(2);

  // when
  await find.press("Enter");

  // then
  await expect(page.getByRole("status").filter({ hasText: "of 2" })).toHaveText("2 of 2");
  await expect(page.locator(".task-log li[aria-current='true']")).toContainText("retrying the failed tests");
});

test("given a finished task's page, when the palette opens, then its first row is Find in this task, which puts the cursor in the find row where Previous, Next and the close button work", async ({ page }) => {
  // given
  const line = (seq: number, text: string) => ({ seq, at: "2026-11-03T10:00:0" + seq + "Z", text });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed" }), log: [line(1, "npm test: 3 FAILED"), line(2, "Cloning payments-api"), line(3, "retrying the failed tests")], outputCut: false } }));
  await page.goto("/demo/tasks/t1");

  await expect(page.getByRole("search", { name: "Find in the log" })).toBeVisible();

  // when
  await page.keyboard.press("ControlOrMeta+K");
  const first = page.getByRole("option").first();

  // then
  await expect(first).toHaveText("Find in this task");

  // when
  await first.click();
  const find = page.getByRole("search").getByLabel("Find in the log");
  await expect(find).toBeFocused();
  await page.keyboard.type("failed");

  // then
  await expect(page.getByRole("status").filter({ hasText: "of 2" })).toHaveText("1 of 2");

  // when
  await page.getByRole("button", { name: "Next" }).click();

  // then
  await expect(page.getByRole("status").filter({ hasText: "of 2" })).toHaveText("2 of 2");

  // when
  await page.getByRole("button", { name: "Previous" }).click();

  // then
  await expect(page.getByRole("status").filter({ hasText: "of 2" })).toHaveText("1 of 2");

  // when
  await page.getByRole("button", { name: "Close find" }).click();

  // then
  await expect(find).toHaveValue("");
  await expect(page.locator(".task-log mark")).toHaveCount(0);
});

test("given a finished task with a log longer than the page holds, when it opens, then the newest lines show and the earlier ones come back on request", async ({ page }) => {
  // given
  const lines = Array.from({ length: 1510 }, (_, i) => ({ seq: i + 1, at: "2026-11-03T10:00:00Z", text: `line ${i + 1}` }));
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed" }), log: lines, outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator(".task-log li")).toHaveCount(1500);
  await expect(page.locator(".task-log li").first()).toContainText("line 11");

  // when
  await page.getByRole("button", { name: "Show earlier lines (10)" }).click();

  // then
  await expect(page.locator(".task-log li")).toHaveCount(1510);
  await expect(page.locator(".task-log li").first()).toContainText("line 1");
});

test("given words typed into the task form and not started, when the page is closed, then the browser asks first, and with nothing typed it does not", async ({ page, context }) => {
  // given
  await page.goto("/demo/tasks");
  await (await newTaskForm(page)).getByLabel("What needs doing?").fill("Tidy the refund skill");
  const asked = new Promise<string>((done) => page.once("dialog", (d) => {
    done(d.type());
    void d.dismiss();
  }));

  // when
  await page.close({ runBeforeUnload: true });

  // then
  expect(await asked).toBe("beforeunload");

  // given an untouched form
  const fresh = await context.newPage();
  await fresh.goto("/demo/tasks");
  await expect(await newTaskForm(fresh)).toBeVisible();
  let prompted = false;
  fresh.on("dialog", (d) => {
    prompted = true;
    void d.dismiss();
  });

  // when
  await fresh.close({ runBeforeUnload: true });

  // then
  expect(prompted).toBe(false);
});

test("given a prompt link with a title and a description, when it opens, then the form holds them and nothing starts", async ({ page }) => {
  // when
  await page.goto(`/demo/tasks/new?title=${encodeURIComponent("Tidy refunds")}&description=${encodeURIComponent("Round half to even.")}`);

  // then
  await expect(page.getByLabel("What needs doing?")).toHaveValue("Round half to even.");
  await expect(page).toHaveURL(/\/demo\/tasks\/new\?/);
});

test("given words typed and not started, when the page is opened again, then they are back and Clear them empties the form", async ({ page }) => {
  // given
  await page.goto("/demo/tasks");
  await (await newTaskForm(page)).getByLabel("What needs doing?").fill("Retry the payment webhook");
  // Leaving with typed words asks first; the person says leave.
  page.on("dialog", (d) => void d.accept());

  // when
  await page.reload();

  // then
  const field = page.getByLabel("What needs doing?");
  await expect(field).toHaveValue("Retry the payment webhook");
  await expect(page.getByRole("note").filter({ hasText: "The words you had not started are back." })).toBeVisible();

  // when
  await page.getByRole("button", { name: "Clear them" }).click();
  await page.reload();

  // then no words wait, so the form waits behind New task, empty
  await expect((await newTaskForm(page)).getByLabel("What needs doing?")).toHaveValue("");
});

test("given a task ready for review that takes a follow-up, when its starter quotes lines of its changes and continues, then the words and the quote are sent apart and the quote leaves the form", async ({ page }) => {
  // given
  let sent: Record<string, unknown> | null = null;
  const review = task({ status: "needs-review", phase: "review", requestNumber: 7, followUp: "continue", request: { status: "open", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: sent ? { ...review, status: "queued", followUp: null } : review, log: [], outputCut: false } }));
  await standInChanges(page, "payments-skills", 7, [{ path: "src/refund.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -10,2 +10,3 @@\n const total = sum(lines);\n-return round(total);\n+const rounded = halfEven(total);\n+return rounded;" }]);
  await page.route("**/api/tasks/t1/messages", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 202, json: { followUp: null } });
  });
  await page.goto("/demo/tasks/t1");
  // The changes are the page, so a short list opens its patches without a click.
  const patch = page.locator("pre.diff-patch");
  await expect(patch).toContainText("halfEven");

  // when the starter selects two added lines
  await patch.evaluate((pre) => {
    const lines = pre.querySelectorAll("[data-i]");
    const range = document.createRange();
    // A line's text follows its gutter of numbers, which a selection never takes.
    range.setStart(lines[3]!.lastChild!, 0);
    range.setEnd(lines[4]!.lastChild!, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    pre.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Quote lines 11-12 in a follow-up" }).click();

  // then
  const form = page.getByRole("form", { name: "Continue with a follow-up" });
  await expect(form.getByRole("list", { name: "Quoted lines" })).toContainText("src/refund.ts:11-12");

  // when
  await form.getByLabel("What the agent should do").fill("Keep the old rounding for refunds before 2024.");
  await form.getByRole("button", { name: "Start the next run" }).click();

  // then
  await expect(page.getByRole("form", { name: "Continue with a follow-up" })).toHaveCount(0);
  expect(sent).toMatchObject({ text: "Keep the old rounding for refunds before 2024.", quotes: [{ path: "src/refund.ts", lines: "11-12", text: "+const rounded = halfEven(total);\n+return rounded;" }] });
  expect(typeof (sent as unknown as { commandId: unknown }).commandId).toBe("string");
});

test("given someone else's task that takes a follow-up, when a teammate opens it, then no follow-up form shows and no line is offered to quote", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ createdBy: "pat@example.invalid", followUp: "steer" }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Retry a failed capture");
  await expect(page.getByRole("form", { name: "Tell the agent while it works" })).toHaveCount(0);
});

test("given the starter's own task while the agent works, when they write to it and press Enter, then the words go to the agent and the box empties", async ({ page }) => {
  // given
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ followUp: "steer" }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/messages", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 202, json: { followUp: "steer" } });
  });
  await page.goto("/demo/tasks/t1");
  const steer = page.getByRole("form", { name: "Tell the agent while it works" });
  const box = steer.getByRole("textbox", { name: "Tell the agent something while it works" });
  await expect(steer.getByRole("button", { name: "Send" })).toBeDisabled();

  // when
  await box.fill("Use our logger, not print lines.");
  await box.press("Shift+Enter");
  await box.pressSequentially("Keep the old format.");
  await box.press("Enter");

  // then
  await expect.poll(() => sent).toMatchObject({ text: "Use our logger, not print lines.\nKeep the old format." });
  await expect(box).toHaveValue("");
});

test("given the agent asks two questions, when its starter picks with a key and writes their own words, then both answers go together, and words that look like a secret are not sent", async ({ page }) => {
  // given
  const questions = [
    { key: "rounding", title: "How should refunds round?", choice: "one", options: [{ value: "even", label: "Half to even" }, { value: "up", label: "Half up" }] },
    { key: "reason", title: "Why the change?", choice: "text" },
  ];
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ requests: [asked({ id: "q1", kind: "question", payload: { questions } })] }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/requests/q1", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return sent.length === 1
      ? route.fulfill({ status: 400, json: { error: "part of the answer looks like a password or key; write it without that, then send", code: "answer-looks-secret" } })
      : route.fulfill({ json: asked({ id: "q1", kind: "question", status: "answered" }) });
  });
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("form", { name: /^Answer / });
  await expect(card.getByRole("button", { name: "Send the answers" })).toBeDisabled();

  // when the starter picks the first option with its key and writes a reason holding a token
  await card.getByRole("group", { name: "How should refunds round?" }).getByLabel(/Half up/).focus();
  await page.keyboard.press("1");
  await card.getByLabel("Your answer").fill("Finance asked; the password is stand-in-not-a-secret");
  await card.getByRole("button", { name: "Send the answers" }).click();

  // then it is refused with the next step, and the words stay to fix
  await expect(page.getByRole("alert")).toHaveText("Not sent: part of it looks like a password or key. Write it without that, then send.");
  expect(sent[0]).toMatchObject({ answer: { answers: { rounding: { chosen: ["even"], other: null }, reason: { chosen: [] } } } });

  // when
  await card.getByLabel("Your answer").fill("Finance asked for it.");
  await card.getByRole("button", { name: "Send the answers" }).click();

  // then
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ answer: { answers: { rounding: { chosen: ["even"], other: null }, reason: { chosen: [], other: "Finance asked for it." } } } });
});

test("given a task kept for its starter's machine and none of theirs connected, when its page and the task list open, then each says so in one sentence or badge with the link that moves it", async ({ page }) => {
  // given
  const waiting = task({ status: "queued", phase: "planned", waitingFor: "connect" });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: waiting, log: [], outputCut: false } }));
  await page.route((url) => url.pathname === "/api/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { tasks: [waiting], next: null } }) : route.fallback()));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const note = page.locator(".waiting");
  await expect(note).toContainText("This task waits for your machine: none of yours is connected yet.");
  await expect(note.getByRole("link", { name: "Connect your machine" })).toHaveAttribute("href", "/demo/settings/machines");

  // when every task is read, from the fold at the foot of Tasks
  await page.goto("/demo/tasks");
  await page.locator("details.log-fold > summary").filter({ hasText: /^All tasks/ }).click();

  // then
  const row = page.getByRole("row", { name: /Retry a failed capture/ });
  await expect(row).toContainText("waiting for your machine");
  await expect(row.getByRole("link", { name: "Connect your machine" })).toBeVisible();
});

test("given a task whose change stayed on its branch on its person's machine, with no remote to push to, when its page opens, then it says where the change stays and gives the command to switch to it, and asks for no review", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const kept = { repoId: "payments-skills", name: "payments-skills", status: "local", reason: "no-remote", path: "", branch: "task/delivery-window", tests: null, error: null, request: null };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", runner: "local", startedAt: at, finishedAt: at, targets: [kept], ranOn: "ada-laptop" }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator("header.page-head .page-summary")).toHaveText("The agent finished in 0s, changing payments-skills; the change stays on its branch on ada-laptop.");
  const group = page.getByRole("region", { name: "Changes", exact: true }).getByRole("region", { name: "payments-skills" });
  await expect(group).toContainText("With no remote to push to, its change stays on the branch task/delivery-window in this repository on ada-laptop.");
  await expect(group.getByRole("button", { name: "Copy the command" })).toBeVisible();
  await expect(group).toContainText("git switch task/delivery-window");
  await expect(page.getByRole("main")).not.toContainText("waits for your review");
});

test("given a task in review whose change stayed on a branch in its person's repository, when its page opens, then its log is open with the line that says where the change is", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const log = [{ seq: 1, at, text: "Claude Code finished." }, { seq: 2, at, text: "the folder: no remote to push to; the branch task/delivery-window is in that repository." }];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", runner: "local", startedAt: at, finishedAt: at }), log, outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("log", { name: "Task log" })).toContainText("the branch task/delivery-window is in that repository.");
});

test("given a task the orchestrator's own restart stopped, when its page opens, then it says the orchestrator restarted, not that a machine went away, and offers to pick it up", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "interrupted", phase: "working", interruptedBy: "restart", startedAt: new Date().toISOString() }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const note = page.locator(".waiting");
  await expect(note).toContainText("Stopped when the orchestrator restarted.");
  await expect(note).not.toContainText("machine");
  await expect(note.getByRole("button", { name: "Pick up where it stopped" })).toBeVisible();
});

test("given a task whose session closed after waiting half an hour on a card, when its page opens, then it says why in the orchestrator's words and offers to pick it up", async ({ page }) => {
  // given
  const why = "The agent waited half an hour for an answer, so its session was closed to free this machine; Continue brings it back where it left off.";
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "interrupted", phase: "working", error: why, startedAt: new Date().toISOString() }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const note = page.locator(".waiting");
  await expect(note).toContainText(why);
  await expect(note).not.toContainText("machine went away");
  await expect(note.getByRole("button", { name: "Pick up where it stopped" })).toBeVisible();
});

test("given a task its machine left part way, when its starter picks it up and the machine is gone, then the reason shows; when the machine is back, the task goes back in line and only its starter is offered it", async ({ page, browser }) => {
  // given
  let status = "interrupted";
  const sent: Record<string, unknown>[] = [];
  let gone = true;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status, phase: "working", runner: "local", startedAt: new Date().toISOString() }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/continue", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    if (gone) return route.fulfill({ status: 409, json: { error: "Ada's laptop is no longer connected; start it again", code: "machine-gone" } });
    status = "queued";
    return route.fulfill({ json: { task: task({ status: "queued" }) } });
  });
  await page.goto("/demo/tasks/t1");

  // when
  await page.getByRole("button", { name: "Pick up where it stopped" }).click();

  // then
  await expect(page.getByRole("alert")).toContainText("Ada's laptop is no longer connected; start it again");

  // when
  gone = false;
  await page.getByRole("button", { name: "Pick up where it stopped" }).click();

  // then
  await expect(page.locator("[data-status]").first()).toHaveText(/^waiting its turn/);
  await expect(page.getByRole("button", { name: "Pick up where it stopped" })).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect(typeof sent[1]!.commandId).toBe("string");

  // when someone who did not start it reads it
  const other = await browser.newContext({ storageState: stateFor("orgAdmin") });
  try {
    const theirs = await other.newPage();
    await theirs.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "interrupted", phase: "working", runner: "local" }), log: [], outputCut: false } }));
    await theirs.goto("/demo/tasks/t1");

    // then
    await expect(theirs.locator("[data-status]").first()).toHaveText(/^stopped/);
    await expect(theirs.getByRole("button", { name: "Pick up where it stopped" })).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test("given one person's folder task whose repository's remote is on GitLab, when they open a merge request from its group and the first try is refused, then the reason and the forge's own page show, and once it opens the group names the merge request instead of the button", async ({ page }) => {
  // given
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  const at = new Date().toISOString();
  const target = { repoId: "payments-skills--alpha", name: "alpha", status: "request", reason: "changed by the agent in alpha", path: "alpha", branch: "task/alpha", tests: null, error: null, request: { number: 3, url: "local://requests/payments-skills--alpha/3", status: "open" } };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, targets: [target] }), log: [], outputCut: false } }));
  await page.route((url) => url.pathname.startsWith("/api/repos/payments-skills--alpha/requests/3/changes"), (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [] } } }));
  let tries = 0;
  let opened: string | null = null;
  await page.route("**/api/repos/payments-skills--alpha/requests/3/on-forge", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { forge: "gitlab", url: opened, number: opened ? 12 : null } });
    tries += 1;
    if (tries === 1) return route.fulfill({ status: 409, json: { error: "glab is not signed in on this machine; run glab auth login", code: "not-opened", createUrl: "https://gitlab.example.invalid/team/alpha/-/merge_requests/new" } });
    opened = "https://gitlab.example.invalid/team/alpha/-/merge_requests/12";
    return route.fulfill({ json: { url: opened, number: 12 } });
  });
  await page.goto("/demo/tasks/t1");
  const group = page.getByRole("region", { name: "Changes", exact: true }).getByRole("region", { name: "alpha" });

  // then
  await expect(group).toContainText("Your checkout changes only when you keep this, and nothing reaches GitLab until you open a merge request there.");
  await expect(group).not.toContainText("only as a request");
  await expect(group).not.toContainText("Request #3");
  await expect(group.locator(".actions").getByRole("button")).toHaveText(["Keep these changes", "Discard these changes…", "Open a merge request"]);

  // when
  await group.getByRole("button", { name: "Open a merge request" }).click();

  // then
  await expect(group.getByRole("alert")).toContainText("is not signed in on this machine; run glab auth login");
  await expect(group.getByRole("link", { name: "Open the filled-in page on GitLab" })).toHaveAttribute("href", "https://gitlab.example.invalid/team/alpha/-/merge_requests/new");

  // when
  await group.getByRole("button", { name: "Open a merge request" }).click();

  // then
  await expect(group).toContainText("Merge request !12 is open on GitLab.");
  await expect(group.getByRole("link", { name: "!12" })).toHaveAttribute("href", "https://gitlab.example.invalid/team/alpha/-/merge_requests/12");
  await expect(group.getByRole("button", { name: "Open a merge request" })).toHaveCount(0);
});

test("given one person's own task whose change is its own copy's request, when it is reviewed, then the head keeps or discards it, the request is never named, and a refused keep gives the command to run where the branch is checked out", async ({ page }) => {
  // given
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  const at = new Date().toISOString();
  let status = "open";
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, requestNumber: 3, request: { status, provider: "local", branch: "task/x", url: "local://requests/payments-skills/3" } }), log: [], outputCut: false } }));
  await page.route((url) => url.pathname.startsWith("/api/repos/payments-skills/requests/3/changes"), (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [] } } }));
  await page.route("**/api/repos/payments-skills/requests/3/on-forge", (route) => route.fulfill({ json: { forge: null, url: null, number: null } }));
  const asked: string[] = [];
  let checkedOut = true;
  await page.route(/\/api\/repos\/payments-skills\/requests\/3\/(merge|close)$/, (route) => {
    const action = new URL(route.request().url()).pathname.split("/").pop()!;
    asked.push(action);
    if (action === "merge" && checkedOut) return route.fulfill({ status: 409, json: { error: "Main is checked out in ~/code/shop with changes of its own; merge it there: git merge task/x." } });
    status = action === "merge" ? "merged" : "closed";
    return route.fulfill({ json: { request: { number: 3, status } } });
  });
  await page.goto("/demo/tasks/t1");
  const head = page.locator("header.page-head");

  // then
  await expect(head.getByRole("button", { name: "Keep these changes" })).not.toHaveClass(/secondary/);
  await expect(head.getByRole("button", { name: "Discard these changes…" })).toHaveClass(/secondary/);
  await expect(page.getByRole("link", { name: "Open the request" })).toHaveCount(0);
  await expect(page.getByRole("main")).not.toContainText("Request #3");

  // when
  await head.getByRole("button", { name: "Keep these changes" }).click();

  // then
  await expect(page.getByRole("alert")).toContainText("merge it there");
  await expect(page.getByRole("alert")).toContainText("git merge task/x");

  // when the checkout is free and the person keeps it again
  checkedOut = false;
  await head.getByRole("button", { name: "Keep these changes" }).click();

  // then
  await expect.poll(() => asked).toEqual(["merge", "merge"]);
  await expect(head.getByRole("button", { name: "Keep these changes" })).toHaveCount(0);
});

test("given a change a machine kept because its remote is not a connected repository, when its starter signed in to GitLab, then the same button opens a merge request, and without the sign-in only the command is offered", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const kept = { repoId: "payments-skills", name: "payments-skills", status: "local", reason: "not-connected", path: "alpha", branch: "task/alpha", forge: "gitlab", tests: null, error: null, request: null };
  let target: Record<string, unknown> = kept;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, targets: [target], ranOn: "ada-laptop" }), log: [], outputCut: false } }));
  await page.goto("/demo/tasks/t1");
  const group = page.getByRole("region", { name: "Changes", exact: true }).getByRole("region", { name: "alpha" });

  // then
  await expect(group.getByRole("button", { name: "Open a merge request" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Copy the command" })).toHaveCount(0);

  // when the starter is not signed in to a forge
  target = { ...kept, forge: null };
  await page.reload();

  // then
  await expect(group.getByRole("button", { name: "Copy the command" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Open a merge request" })).toHaveCount(0);
});

test("given a change a machine kept on its branch with a GitLab remote, when its starter opens a merge request and the machine first answers why it cannot, then the reason shows, and once opened the group reads as a request", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const kept = { repoId: "payments-skills", name: "payments-skills", status: "local", reason: "unpushed", path: "alpha", branch: "task/alpha", forge: "gitlab", tests: null, error: null, request: null };
  const opened = { repoId: "payments-skills--alpha", name: "alpha", status: "request", reason: "changed by the agent in alpha", path: "alpha", branch: "task/alpha", forge: "gitlab", tests: null, error: null, request: { number: 3, url: "https://gitlab.example.invalid/team/alpha/-/merge_requests/3", status: "open" } };
  let target: Record<string, unknown> = kept;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, targets: [target], ranOn: "ada-laptop" }), log: [], outputCut: false } }));
  await page.route((url) => url.pathname.startsWith("/api/repos/payments-skills--alpha/requests/3/changes"), (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [] } } }));
  let tries = 0;
  await page.route("**/api/tasks/t1/targets/0/on-forge", (route) => {
    tries += 1;
    if (tries === 1) return route.fulfill({ status: 409, json: { error: "ada-laptop is not connected; open it and try again", code: "not-pushed" } });
    target = opened;
    return route.fulfill({ json: { target: opened } });
  });
  await page.goto("/demo/tasks/t1");
  const changes = page.getByRole("region", { name: "Changes", exact: true });

  // then
  const group = changes.getByRole("region", { name: "alpha" });
  await expect(group).toContainText("Nothing is pushed to its remote yet, so its change stays on the branch task/alpha in this repository on ada-laptop.");
  await expect(group.getByRole("button", { name: "Copy the command" })).toHaveCount(0);

  // when
  await group.getByRole("button", { name: "Open a merge request" }).click();

  // then
  await expect(group.getByRole("alert")).toContainText("is not connected; open it and try again");

  // when
  await group.getByRole("button", { name: "Open a merge request" }).click();

  // then
  await expect(changes.getByRole("region", { name: "alpha" })).toContainText("Merge request !3 on GitLab waits for a person to review and merge it.");
  await expect(changes.getByRole("button", { name: "Open a merge request" })).toHaveCount(0);
});

test("given a change its starter opened on GitLab, when its page opens, then the group reads the merge request in the forge's own facts, and Read again reads it once more", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const opened = { repoId: "payments-skills--alpha", name: "alpha", status: "request", reason: "changed by the agent in alpha", path: "alpha", branch: "task/alpha", forge: "gitlab", tests: null, error: null, request: { number: 3, url: "https://gitlab.example.invalid/team/alpha/-/merge_requests/3", status: "open" } };
  const reads = [
    { kind: "gitlab", number: 3, url: "https://gitlab.example/alpha/-/merge_requests/3", read: { status: "open", checks: "passing", approvals: 1, comments: 3, mergedBy: null, readAt: "2026-11-12T10:42:00" } },
    { kind: "gitlab", number: 3, url: "https://gitlab.example/alpha/-/merge_requests/3", unread: "sign in to GitLab from Integrations." },
  ];
  let read = 0;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, targets: [opened], ranOn: "ada-laptop" }), log: [], outputCut: false } }));
  await page.route((url) => url.pathname.startsWith("/api/repos/payments-skills--alpha/requests/3/changes"), (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [] } } }));
  await page.route("**/api/tasks/t1/targets/0/on-forge", (route) => route.fulfill({ json: { onForge: reads[Math.min(read++, 1)] } }));

  // when
  await page.goto("/demo/tasks/t1");
  const group = page.getByRole("region", { name: "Changes", exact: true }).getByRole("region", { name: "alpha" });

  // then
  await expect(group).toContainText("Merge request !3 on GitLab: checks passing, 1 approval, 3 comments, read at 10:42");

  // when
  await group.getByRole("button", { name: "Read again" }).click();

  // then
  await expect(group).toContainText("Not read from GitLab for now: sign in to GitLab from Integrations.");
});

test("given a task held at its plan's usage limit, when its page and the task list open, then both say it is at the usage limit in the waiting tone rather than queued", async ({ page }) => {
  // given
  const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const held = task({ status: "queued", phase: "working", waitingFor: "limit", resetAt, startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), cost: { usd: 0.41, inputTokens: null, outputTokens: null } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: held, log: [], outputCut: false } }));
  await page.route((url) => url.pathname === "/api/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { tasks: [held], next: null } }) : route.fallback()));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const badge = page.locator("header.page-head [data-status]").first();
  await expect(badge).toHaveText("at the usage limit");
  await expect(badge).toHaveClass(/warn/);
  await expect(page.locator(".waiting")).toContainText("Your plan's usage limit is reached; the task goes on by itself at");
  // while it stands still the head counts no time, only what was spent
  await expect(page.locator("header.page-head .page-summary")).toHaveText("The agent has spent $0.41 so far.");

  // when every task is read, from the fold at the foot of Tasks
  await page.goto("/demo/tasks");
  await page.locator("details.log-fold > summary").filter({ hasText: /^All tasks/ }).click();

  // then
  await expect(page.getByRole("row", { name: /Retry a failed capture/ })).toContainText("at the usage limit");
  await expect(page.getByRole("row", { name: /Retry a failed capture/ })).not.toContainText("queued");
});

test("given a running task whose agent was denied a tool, once outright and once after it started, when its page opens, then each call reads as refused in the product's words, never as used, with why and its own name in its fold", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let n = 0;
  const line = (data: Record<string, unknown>) => ({ seq: ++n, at, text: "masked", kind: data.type, data });
  const events = [
    line({ type: "tool_call", id: "a", tool: "mcp__atlassian__getJiraIssue", target: "PAY-412", status: "refused" }),
    line({ type: "tool_call", id: "b", tool: "mcp__slack__search", target: "delivery window", status: "started" }),
    line({ type: "tool_call", id: "b", tool: "mcp__slack__search", status: "refused" }),
  ];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at }), log: new URL(route.request().url()).searchParams.get("after") === "0" ? events : [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const stream = page.getByRole("region", { name: "The agent at work" }).getByRole("list", { name: "What the agent did" });
  await expect(stream.locator(":scope > li")).toHaveText([
    "Read PAY-412 in Jira refused",
    `Searched Slack for "delivery window" refused`,
    "Thinking…",
  ], { useInnerText: true });
  await expect(stream).not.toContainText("Used ");
  // why, and the tool's own name, are in the line's fold
  const first = stream.locator(":scope > li").first();
  await first.locator("summary").click();
  await expect(first).toContainText("This task does not allow this tool.");
  await expect(first).toContainText("mcp__atlassian__getJiraIssue");
});

test("given a running task the orchestrator routed to a folder whose CLAUDE.md names it, when its starter changes the folder, then the run's first line says the folder from its heading and never the model's reason, Change lists the other folders, asks first, and opens the task started there", async ({ page }) => {
  // given
  const home = "/home/ada";
  const at = new Date().toISOString();
  const moved: unknown[] = [];
  const forgotten: string[] = [];
  await page.route("**/api/projects/payments-skills/verification", (route) => {
    forgotten.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, routing: { path: `${home}/code/payments-api`, reason: "the ask names refunds", fallback: false, loaded: { skills: 2, claudeMd: true, memory: true } } }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/verification", (route) => route.fulfill({ json: { verifications: [{ repoId: "payments-skills", verification: { checks: [{ command: "npm test", runs: "the tests", source: "package.json", before: null, after: [], verdict: "not-run" }], setup: null, repairs: 0, verdict: "not-run", reason: "" } }] } }));
  await page.route("**/api/tasks/t2?*", (route) => route.fulfill({ json: { task: task({ id: "t2", status: "queued", routing: { path: `${home}/code/notes`, reason: "", fallback: false } }), log: [], outputCut: false } }));
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: [
    { path: `${home}/code/payments-api`, name: "payments-api", about: "Payments API", usedAt: at },
    { path: `${home}/code/notes`, name: "notes", about: null, usedAt: at },
  ] } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [], last: null, home } }));
  await page.route("**/api/tasks/t1/move", (route) => {
    moved.push(route.request().postDataJSON());
    return route.fulfill({ json: { task: task({ id: "t2", status: "queued" }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const first = page.getByRole("list", { name: "What the agent did" }).locator(":scope > li").first();
  await expect(first).toHaveAttribute("data-kind", "where");
  await expect(first).toHaveText("Working in ~/code/payments-api, which its CLAUDE.md calls Payments API, checked with npm test Change\nLoaded: 2 skills, CLAUDE.md, memory from ~/code/payments-api.", { useInnerText: true });
  await expect(page.getByText("the ask names refunds")).toHaveCount(0);
  await expect(first).toContainText("checked with npm test");
  await expect(first).toContainText("Loaded: 2 skills, CLAUDE.md, memory from ~/code/payments-api.");
  await expect(page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Where" })).toContainText("~/code/payments-api");

  // when the checks are taken back
  await first.getByRole("button", { name: "Change where the task works" }).click();
  await first.getByRole("button", { name: "Run without checks" }).click();
  await expect(first.getByRole("group", { name: "Run without checks" })).toContainText("tasks there run none until you approve them again");
  await first.getByRole("button", { name: "Take them back" }).click();

  // then the approval is deleted for the folder's project
  await expect.poll(() => forgotten).toEqual(["DELETE /api/projects/payments-skills/verification"]);

  // when a path is typed, not picked from the list
  await first.getByRole("button", { name: "Change where the task works" }).click();
  await first.getByLabel("A folder's path").fill("~/code/elsewhere");
  await first.getByLabel("A folder's path").press("Enter");

  // then it is asked about as any other folder is, with the home written out
  await expect(first.getByRole("group", { name: "Start it there" })).toContainText("The task starts again in ~/code/elsewhere");
  await first.getByRole("button", { name: "Keep it here" }).click();

  // when
  await first.getByRole("button", { name: "Change where the task works" }).click();
  await first.getByRole("button", { name: /^notes/ }).click();

  // then
  const ask = first.getByRole("group", { name: "Start it there" });
  await expect(ask).toContainText("The task starts again in ~/code/notes; what it did so far is dropped.");
  expect(moved).toEqual([]);

  // when
  await ask.getByRole("button", { name: "Start it there" }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/tasks\/t2$/);
  expect(moved).toEqual([{ path: `${home}/code/notes` }]);
});

test("given a task whose run found two MCP servers that need sign-in, when its page opens, then it says how many and which, and how to sign in, and a task with none says nothing", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let needs: string[] = ["gitlab", "notion"];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, mcpNeedsSignIn: needs }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const note = page.getByRole("note").filter({ hasText: "sign-in" });
  await expect(note.locator("summary")).toHaveText("2 MCP servers need sign-in");
  await note.locator("summary").click();
  await expect(note).toContainText("GitLab, Notion");
  await expect(note).toHaveText(/run claude\s+Copy, then \/mcp/);

  // when
  needs = [];
  await page.reload();

  // then
  await expect(page.getByRole("note").filter({ hasText: "need sign-in" })).toHaveCount(0);
});
test("given a task whose run found a plugin's server and one service reached twice, when its page opens, then each service is named once as a person reads it and the plugin is named only where it brought the server", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const needs = ["plugin:acme-skills:atlassian", "claude.ai Notion", "notion"];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, mcpNeedsSignIn: needs }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");
  const note = page.getByRole("note").filter({ hasText: "sign-in" });
  await note.locator("summary").click();

  // then
  await expect(note.locator("summary")).toHaveText("2 MCP servers need sign-in");
  await expect(note).toContainText("Atlassian (from acme-skills), Notion");
  await expect(note).not.toContainText("plugin:");
});

test("given a task whose run stopped to ask a question, when its starter picks an option and sends it, then the answer goes as the option's words and the question is gone, and a teammate sees only who it waits on", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const question = { text: "Which environment should the migration run against?", options: ["staging", "production"] };
  let answered: unknown = null;
  let state: Record<string, unknown> = { status: "failed", phase: "failed", finishedAt: at, error: "The agent stopped to ask you: Which environment should the migration run against?", question };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ startedAt: at, ...state }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/answer", (route) => {
    answered = route.request().postDataJSON();
    state = { status: "queued", phase: "waiting", question: { ...question, answer: "staging" } };
    return route.fulfill({ json: { task: task({ startedAt: at, ...state }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");

  // then the question is the one thing to answer, said once
  const card = page.getByRole("region", { name: /stopped to ask/ });
  await expect(card).toContainText("Which environment should the migration run against?");
  await expect(page.getByRole("alert").filter({ hasText: "The agent stopped to ask you" })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Send the answer" })).toBeDisabled();

  // and the head says what waits, with no log opened beside the card
  await expect(page.locator("header.page-head [data-status]").first()).toHaveText("needs you");
  await expect(page.locator("header.page-head .page-summary")).toHaveText("The agent stopped to ask you.");
  await expect(page.getByRole("group").filter({ hasText: /^Log/ })).not.toHaveAttribute("open", "");
  await expect(page.locator("header.page-head").getByRole("button", { name: "Run again" })).toHaveCount(0);

  // when
  await card.getByRole("radio", { name: "staging" }).check();
  await card.getByRole("button", { name: "Send the answer" }).click();

  // then
  await expect(page.getByRole("region", { name: /stopped to ask/ })).toHaveCount(0);
  expect(answered).toEqual({ answer: "staging" });
});

test("given a task whose read of its own issue was refused, when its starter chooses to paste the issue text, then a field opens in place and what they paste is sent as the answer", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let answered: unknown = null;
  const question = { text: "The issue was not read: this task does not allow Jira.", options: ["Paste the issue text", "Skip the issue"] };
  let state: Record<string, unknown> = { status: "failed", phase: "failed", finishedAt: at, question };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ startedAt: at, ...state }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/answer", (route) => {
    answered = route.request().postDataJSON();
    state = { status: "queued", phase: "waiting", question: { ...question, answer: "pasted" } };
    return route.fulfill({ json: { task: task({ startedAt: at, ...state }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("region", { name: /stopped to ask/ });
  await expect(card.getByLabel("The issue's text")).toHaveCount(0);
  await card.getByRole("radio", { name: "Paste the issue text" }).check();

  // then the field is there, and the answer waits for words in it
  const field = card.getByLabel("The issue's text");
  await expect(field).toBeVisible();
  await expect(card.getByRole("button", { name: "Send the answer" })).toBeDisabled();

  // when
  await field.fill("PAY-412: Retry the capture call on a timeout, five times.");
  await card.getByRole("button", { name: "Send the answer" }).click();

  // then
  expect(answered).toEqual({ answer: "PAY-412: Retry the capture call on a timeout, five times." });
  await expect(page.getByRole("region", { name: /stopped to ask/ })).toHaveCount(0);
});

test("given a stopped task that held a plan nobody answered, when its page opens, then the head's action approves the plan and goes on", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const plan = "1. Read the webhook code\n2. Add the retry";
  const held = { id: "pl1", kind: "plan", payload: { plan }, status: "expired", responseCapability: "not_resumable", answer: null, answeredBy: null, createdAt: at };
  let sent: unknown = null;
  let state: Record<string, unknown> = { status: "interrupted", phase: "failed", finishedAt: at, error: "Nobody answered the plan in time.", requests: [held] };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ startedAt: at, ...state }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/continue", (route) => {
    sent = route.request().postDataJSON();
    state = { status: "queued", phase: "waiting", requests: [held] };
    return route.fulfill({ json: { task: task({ startedAt: at, ...state }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");
  const head = page.locator("header.page-head");

  // then
  await expect(head.getByRole("button", { name: "Approve the plan and continue" })).toBeVisible();

  // when
  await head.getByRole("button", { name: "Approve the plan and continue" }).click();

  // then
  await expect.poll(() => sent).toMatchObject({ approvePlan: true });
  await expect(head.getByRole("button", { name: "Approve the plan and continue" })).toHaveCount(0);
});

test("given a failed task from before plans came as cards, when its page opens, then the plan its agent filed can be approved to go on, the reason is said once, and the open log holds its lines in a box", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let n = 0;
  const line = (data: Record<string, unknown>) => ({ seq: ++n, at, text: "masked", kind: data.type, data });
  const log = [
    line({ type: "tool_call", id: "w", tool: "Write", target: "work/.orchestrator-plans/plan.md", status: "started" }),
    line({ type: "edit", id: "w", path: "work/.orchestrator-plans/plan.md", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+# The plan\n+1. Add the retry" }),
    ...Array.from({ length: 200 }, (_, i) => ({ seq: ++n, at, text: `raw line ${i}` })),
  ];
  let sent: unknown = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, error: "nobody answered in time.", requests: [] }), log, outputCut: false } }));
  await page.route("**/api/tasks/t1/continue", (route) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ json: { task: task({ status: "queued", phase: "waiting", startedAt: at }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");
  const head = page.locator("header.page-head");

  // then
  await expect(head.getByRole("button", { name: "Approve the plan and continue" })).toBeVisible();
  await expect(page.getByText("nobody answered in time.")).toHaveCount(1);
  await page.locator("details.log-fold").filter({ hasText: "Log" }).last().locator("summary").click();
  const box = page.locator("ol.task-log");
  expect(await box.evaluate((el) => el.clientHeight < el.scrollHeight)).toBe(true);

  // when
  await head.getByRole("button", { name: "Approve the plan and continue" }).click();

  // then
  await expect.poll(() => sent).toEqual(expect.objectContaining({ approvePlan: true, plan: "# The plan\n1. Add the retry" }));
});

test("given a task its starter stopped that left changes for review, when its page opens, then why it stopped is a quiet note, not an alert", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, error: "Stopped by the person who started the task." }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("note").filter({ hasText: "Stopped by the person who started the task." })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Stopped by" })).toHaveCount(0);
});

test("given a running task its starter can message and a log with several lines, when two lines of the log are selected, then a button quotes them into the follow-up as the log's lines, and a selection outside the log offers none", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const log = [1, 2, 3, 4].map((seq) => ({ seq, at, text: `The agent said line ${seq}` }));
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ startedAt: at, followUp: "steer" }), log, outputCut: false } }));
  await page.goto("/demo/tasks/t1");
  await page.locator("details.log-fold").filter({ hasText: "Log" }).last().evaluate((d) => ((d as HTMLDetailsElement).open = true));
  await expect(page.locator("ol.task-log li").first()).toBeVisible();

  // when
  await page.evaluate(() => {
    const rows = document.querySelectorAll("ol.task-log li");
    window.getSelection()!.setBaseAndExtent(rows[1]!, 0, rows[2]!, rows[2]!.childNodes.length);
  });

  // then
  const button = page.getByRole("button", { name: "Quote in follow-up" });
  await expect(button).toBeVisible();

  // when
  await button.click();

  // then
  await expect(page.getByRole("list", { name: "Quoted lines" })).toContainText("log 2-3");
  await expect(button).toHaveCount(0);

  // when the title is selected
  await page.evaluate(() => window.getSelection()!.selectAllChildren(document.querySelector("h1")!));

  // then
  await expect(button).toHaveCount(0);
});

test("given messages of the starter's that wait for the agent's next step, when one is changed, one is taken back and one has reached the agent meanwhile, then each goes to its own route and the list follows the page's next read", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let messages = [
    { id: "m1", text: "Also cover refunds.", quotes: null, createdAt: at },
    { id: "m2", text: "Skip the docs.", quotes: [{ path: "the agent's log", lines: "3", text: "x" }], createdAt: at },
    { id: "m3", text: "Late one.", quotes: null, createdAt: at },
  ];
  const sent: string[] = [];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ startedAt: at, followUp: "queue", messages }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/messages/*", (route) => {
    const id = route.request().url().split("/").pop()!;
    sent.push(`${route.request().method()} ${id} ${route.request().postData() ?? ""}`.trim());
    if (id === "m3") return route.fulfill({ status: 409, json: { error: "that message already reached the agent", code: "message-not-waiting" } });
    const edited = route.request().method() === "PATCH" ? (route.request().postDataJSON() as { text: string }).text : null;
    messages = messages.filter((m) => m.id !== id || edited !== null).map((m) => (m.id === id && edited !== null ? { ...m, text: edited } : m));
    return route.fulfill({ json: route.request().method() === "PATCH" ? { message: messages.find((m) => m.id === id) } : { removed: true } });
  });
  await page.goto("/demo/tasks/t1");
  const waiting = page.getByRole("region", { name: "Messages waiting for the agent" });
  await expect(waiting.getByRole("listitem")).toHaveCount(3);
  await expect(waiting).toContainText("with 1 quoted passage");

  // when the first is changed
  await waiting.getByRole("listitem").nth(0).getByRole("button", { name: "Edit" }).click();
  await waiting.getByRole("textbox", { name: "Change the message" }).fill("Also cover refunds and returns.");
  await waiting.getByRole("button", { name: "Save" }).click();

  // then
  await expect(waiting.getByRole("listitem").nth(0)).toContainText("Also cover refunds and returns.");

  // when the second, which carries a quoted passage, is changed
  await waiting.getByRole("listitem").nth(1).getByRole("button", { name: "Edit" }).click();
  await waiting.getByRole("textbox", { name: "Change the message" }).fill("Skip the docs and the changelog.");
  await waiting.getByRole("button", { name: "Save" }).click();

  // then its words changed and the quote went with them, so the server keeps it
  await expect(waiting.getByRole("listitem").nth(1)).toContainText("Skip the docs and the changelog.");
  await expect(waiting).toContainText("with 1 quoted passage");

  // when the second is taken back
  await waiting.getByRole("listitem").nth(1).getByRole("button", { name: "Remove" }).click();

  // then
  await expect(waiting.getByRole("listitem")).toHaveCount(2);

  // when the third has already reached the agent
  messages = messages.filter((m) => m.id !== "m3");
  await waiting.getByRole("listitem").nth(1).getByRole("button", { name: "Remove" }).click();

  // then it says so and the list reads again without it
  await expect(waiting.getByRole("alert")).toContainText("already reached the agent");
  expect(sent).toEqual([
    'PATCH m1 {"text":"Also cover refunds and returns."}',
    'PATCH m2 {"text":"Skip the docs and the changelog.","quotes":[{"path":"the agent\'s log","lines":"3","text":"x"}]}',
    "DELETE m2",
    "DELETE m3",
  ]);
});

test("given a task in review that goes on from a change with no request, when its page opens, then the follow-up says the new run joins this review, with a request it says the request's branch, and once the change is kept it says the new changes come back for review", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let over: Record<string, unknown> = { status: "needs-review", phase: "review", startedAt: at, finishedAt: at, followUp: "continue" };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task(over), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const form = page.getByRole("form", { name: "Continue with a follow-up" });
  await expect(form).toContainText("A new run starts where this one left off, with your words, and its changes join this review.");

  // when the task has a request
  over = { ...over, requestNumber: 7, request: { status: "open", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" } };
  await page.reload();

  // then
  await expect(page.getByRole("form", { name: "Continue with a follow-up" })).toContainText("A new run starts on the request's branch");

  // when the change was kept
  over = { ...over, state: "kept", request: { status: "merged", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" } };
  await page.reload();

  // then
  await expect(page.getByRole("form", { name: "Continue with a follow-up" })).toContainText("A new run starts from the kept change, with your words, and its new changes come to you for review.");
});

test("given the follow-up box of a task in review, when its text is measured, then it is the task form's text: regular weight, medium size, a box of at least 96 px", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, followUp: "continue" }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");
  const style = await page.getByRole("textbox", { name: "What the agent should do" }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight, min: s.minHeight };
  });

  // then
  expect(style).toEqual({ size: "16px", weight: "400", min: "96px" });
});

test("given a folder task that changed files in place, when its change is waiting, kept or undone, then the follow-up goes on from the files as left, says where the next run starts once kept, and is not drawn once undone", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const files = [{ path: "a.md", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }];
  const by = { at, by: "ada@example.invalid" };
  let over: Record<string, unknown> = { status: "needs-review", phase: "review", result: "changes", startedAt: at, finishedAt: at, followUp: "continue", changes: { files, undone: null, kept: null } };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task(over), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.goto("/demo/tasks/t1");
  const form = page.getByRole("form", { name: "Continue with a follow-up" });

  // then
  await expect(form).toContainText("A new run starts where this one left off, with your words, and its changes join this review.");

  // when kept
  over = { ...over, changes: { files, undone: null, kept: by } };
  await page.reload();

  // then
  await expect(form).toContainText("A new run starts from the kept change, with your words, and its new changes come to you for review.");

  // when undone
  over = { ...over, changes: { files, undone: { ...by, kept: [] }, kept: null } };
  await page.reload();

  // then
  await expect(page.getByRole("heading", { name: "Continue with a follow-up" })).toHaveCount(0);
});

test("given a queued task that waits behind another task's card, when its page and the board open, then both say what it waits for with a link to that task", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const behind = { id: "t0", title: "Add the delivery window" };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "queued", phase: "waiting", queuePosition: 1, waitingBehind: behind }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const note = page.getByRole("note").filter({ hasText: "Starts once you answer" });
  await expect(note).toContainText("Starts once you answer Add the delivery window, which works in the same folder.");
  await expect(note.getByRole("link", { name: "Add the delivery window" })).toHaveAttribute("href", "/demo/tasks/t0");
  void at;
});

test("given a run that finished without changing a file, when its page opens, then the head says so, the agent's last words are its answer, and Run again is secondary", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", state: "finished-nothing-changed", description: "Is the retry already there?", startedAt: at, finishedAt: at, lastSaid: "No change is needed: the retry is already there." }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator("header.page-head [data-status]").first()).toHaveText("finished, nothing changed");
  await expect(page.locator("header.page-head .page-summary")).toHaveText(/^The agent finished in .* without changing a file\.$/);
  await expect(page.getByRole("region", { name: "The agent's answer" })).toContainText("No change is needed");
  await expect(page.getByRole("region", { name: "The agent's answer" })).toContainText("You asked: Is the retry already there?");
  await expect(page.getByRole("button", { name: "Run again" })).toHaveClass(/secondary/);
});

test("given an answered request to change a file, when the starter reads it, then it is one line naming the file and who allowed it", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const answered = { id: "r9", kind: "file-change", payload: { tool: "Write", summary: "src/endpoints/delivery-window.ts" }, status: "answered", responseCapability: "live", answer: { decision: "allow_once" }, answeredBy: "ada@example.invalid", createdAt: at };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ requests: [answered] }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("listitem", { name: "The agent asks to change a file" })).toHaveText("You allowed writing src/endpoints/delivery-window.ts once.");
});

test("given a follow-up with two files chosen and one refused, when it is sent, then each file goes to the task first and the message carries their ids", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const uploads: string[] = [];
  let sent: Record<string, unknown> | null = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, followUp: "continue" }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/tasks/t1/attachments", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { attachments: [] } });
    uploads.push(`${route.request().headers()["x-attachment-name"]} ${route.request().headers()["content-type"]}`);
    return route.fulfill({ status: 201, json: { attachment: { id: `att_${uploads.length}`, taskId: "t1", name: "x", mime: "text/plain", size: 3 } } });
  });
  await page.route("**/api/tasks/t1/messages", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 202, json: { followUp: null } });
  });
  await page.goto("/demo/tasks/t1");
  const form = page.getByRole("form", { name: "Continue with a follow-up" });

  // when
  await form.getByLabel("Choose files").setInputFiles([
    { name: "error.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: "notes.md", mimeType: "", buffer: Buffer.from("hi\n") },
    { name: "tool.zip", mimeType: "application/zip", buffer: Buffer.from("PK") },
  ]);

  // then the zip is refused in one line and two chips remain
  await expect(form.getByRole("alert").filter({ hasText: "tool.zip" })).toHaveText("tool.zip is not a file the agent reads: PNG, JPEG, GIF, WebP, PDF, text or JSON.");
  await expect(form.getByRole("list", { name: "Files" }).getByRole("listitem")).toHaveCount(2);

  // when
  await form.getByRole("textbox", { name: "What the agent should do" }).fill("Look at the screenshot.");
  await form.getByRole("button", { name: "Start the next run" }).click();

  // then
  await expect.poll(() => sent).toMatchObject({ text: "Look at the screenshot.", attachments: ["att_1", "att_2"] });
  expect(uploads).toEqual(["error.png image%2Fpng".replace("%2F", "/"), "notes.md text/plain"]);
});

test("given a task that was given a file, when its page opens, then the rail lists it after what was asked and opens it by a signed address, and a task with none has no Files heading", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let given = [{ id: "att_1", taskId: "t1", name: "error.png", mime: "image/png", size: 245760 }];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, description: "Fix what the screenshot shows." }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/tasks/t1/attachments", (route) => route.fulfill({ json: { attachments: given } }));
  await page.route("**/api/tasks/t1/attachments/att_1/url", (route) => route.fulfill({ json: { url: "/api/attachments/att_1?u=x", expiresAt: at } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const rail = page.getByRole("complementary", { name: "About this task" });
  await expect(rail.getByRole("heading", { level: 2 })).toHaveText(["The ask", "Files", "Where", "Run"]);
  await expect(rail.getByRole("region", { name: "Files" })).toContainText("error.png 240 KB");
  await expect(rail).toContainText("The agent reads them; they are not part of its change.");

  // when none
  given = [];
  await page.reload();

  // then
  await expect(rail.getByRole("heading", { name: "Files" })).toHaveCount(0);
});

test("given a secret the agent asks for, when its starter gives it or declines, then the value goes to the secrets route alone, the field empties, and the answered card is one line with no value", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const ask = (over: Record<string, unknown> = {}) => ({ id: "s1", kind: "secret", payload: { name: "STRIPE_TEST_KEY", why: "To call the sandbox." }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: at, ...over });
  let requests = [ask()];
  const sent: string[] = [];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, requests }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/tasks/t1/secrets/s1", (route) => {
    sent.push(`secret ${(route.request().postDataJSON() as { value: string }).value}`);
    requests = [ask({ status: "answered", answer: { provided: true }, answeredBy: "ada@example.invalid" })];
    return route.fulfill({ json: { request: { id: "s1", status: "answered" } } });
  });
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("listitem", { name: "The agent asks for STRIPE_TEST_KEY" });

  // then
  await expect(card).toContainText("To call the sandbox.");
  await expect(card).toContainText("It is sealed for this task alone; the agent gets it by name, and the value is never in the chat or the log.");
  await expect(card.getByRole("button", { name: "Give it to the agent" })).toBeDisabled();

  // when
  const field = card.getByLabel("STRIPE_TEST_KEY", { exact: true });
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("sk_test_not_a_real_one");
  await card.getByRole("button", { name: "Give it to the agent" }).click();

  // then
  await expect(card).toHaveText("You gave STRIPE_TEST_KEY.");
  expect(sent).toEqual(["secret sk_test_not_a_real_one"]);
  await expect(page.locator("body")).not.toContainText("sk_test_not_a_real_one");
});

test("given a secret asked for and someone other than the starter reading the task, when the page opens, then one line says who it waits for and no field is drawn", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, createdBy: "pat@example.invalid", startedBy: { name: "Pat Payments" }, requests: [{ id: "s1", kind: "secret", payload: { name: "STRIPE_TEST_KEY", why: "x" }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: at }] }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("listitem", { name: "The agent asks for STRIPE_TEST_KEY" })).toHaveText("Waiting for Pat Payments to give STRIPE_TEST_KEY.");
  await expect(page.getByLabel("STRIPE_TEST_KEY", { exact: true })).toHaveCount(0);
});

test("given a task whose agent made a plan first, when its starter reads it, changes it and starts with it, then the changed plan is what is sent, the card shrinks to one line, and a decline is sent as a decline", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const plan = "1. Read the webhook code\n2. Add the retry\n3. Run the tests";
  const asked = (over: Record<string, unknown> = {}) => ({ id: "pl1", kind: "plan", payload: { plan }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: at, ...over });
  let requests: Record<string, unknown>[] = [asked()];
  const sent: unknown[] = [];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, requests }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/requests/pl1", (route) => {
    const body = route.request().postDataJSON() as { answer: { decision: string; plan?: string } };
    sent.push(body.answer);
    requests = [asked({ status: "answered", answer: { decision: body.answer.decision }, answeredBy: "ada@example.invalid" })];
    return route.fulfill({ json: requests[0] });
  });

  // when
  await page.goto("/demo/tasks/t1");
  const card = page.getByRole("listitem", { name: "The agent's plan" });

  // then the plan is read as the agent wrote it
  await expect(card).toContainText("Read the webhook code");
  await expect(card.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expect(page.locator("header.page-head [data-status]").first()).toHaveText("needs you");
  await expect(card.getByRole("button", { name: "Start with this plan" })).toBeVisible();

  // when the person changes it and starts with their version
  await card.getByRole("button", { name: "Change the plan" }).click();
  await card.getByRole("textbox").fill(`${plan}\n4. Say what changed`);
  await card.getByRole("button", { name: "Start with this plan" }).click();

  // then
  expect(sent).toEqual([{ decision: "allow_once", plan: `${plan}\n4. Say what changed` }]);
  await expect(card).toContainText("started with the plan, 3 steps");
  await expect(card.getByRole("button")).toHaveCount(0);
});

test("given the agent can plan first, when the person ticks Show me the plan and starts, then the start asks for the plan first, and an agent that cannot plan offers no such box", async ({ page }) => {
  // given
  let plans = true;
  await page.route("**/api/tasks/options", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, agents: real.agents.map((a: Record<string, unknown>) => ({ ...a, plan: plans })) } });
  });
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 400, json: { error: "stopped by the test" } });
  });
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);
  await work(form, "Add a retry to the capture call");
  await chooseAgent(form);

  // when
  const box = form.getByRole("checkbox", { name: "Show me the plan before it changes anything" });
  await expect(box).not.toBeChecked();
  await box.check();
  await choose(form, "Repository", /^payments-skills/);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ planFirst: true });

  // when the agent cannot plan
  plans = false;
  await page.reload();
  await newTaskForm(page);

  // then
  await expect(page.getByRole("checkbox", { name: "Show me the plan before it changes anything" })).toHaveCount(0);
});

test("given a task that stopped to ask its starter, when a teammate opens it, then the question shows with whose answer it waits on and no field", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, createdBy: "pat@example.invalid", question: { text: "Which environment?", options: [] } }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const card = page.getByRole("region", { name: /stopped to ask/ });
  await expect(card).toContainText("Which environment?");
  await expect(card).toContainText("pat@example.invalid");
  await expect(card.getByRole("textbox")).toHaveCount(0);
});

test("given a running task with a long run, when its page opens and the person scrolls up, then Stop sits at the foot with the steer field and not in the head, Jump to latest appears and takes them back, and a queued task's foot holds Stop alone", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let status = "running";
  const events = Array.from({ length: 80 }, (_, i) => ({ seq: i + 1, at, text: "masked", kind: "message", data: { type: "message", text: `Step ${i + 1} of the work, said in a sentence long enough to take a line.` } }));
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status, startedAt: at, followUp: status === "running" ? "steer" : null }), log: new URL(route.request().url()).searchParams.get("after") === "0" ? events : [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const foot = page.locator("form.run-steer");
  await expect(foot.getByRole("button", { name: "Stop…", exact: true })).toBeVisible();
  await expect(foot.getByRole("textbox", { name: "Tell the agent something while it works" })).toBeVisible();
  await expect(page.locator("header.page-head").getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);

  // when the person scrolls up
  await page.evaluate(() => window.scrollTo(0, 0));

  // then
  const jump = foot.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeVisible();

  // when
  await jump.click();

  // then
  await expect(jump).toHaveCount(0);
  expect(await page.evaluate(() => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48)).toBe(true);

  // when the task waits in line
  status = "queued";
  await page.reload();

  // then
  await expect(foot.getByRole("button", { name: "Stop…", exact: true })).toBeVisible();
  await expect(foot.getByRole("textbox")).toHaveCount(0);
});

/** A task that changed the folder shop in place, its changes and their undo, as the server answers them. */
async function changedInPlace(page: Page, git: "none" | "repo") {
  let undone = false;
  let kept = false;
  const changed = () => task({ status: "needs-review", phase: "review", result: "changes", repoId: "shop", changes: { files: [{ path: "src/cart.ts", status: "modified", previousPath: null, additions: 3, deletions: 1, binary: false, test: false }, { path: "README.md", status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], undone: undone ? { at: "2026-11-04T10:00:00Z", by: "Ada", kept: ["README.md"] } : null, kept: kept ? { at: "2026-11-04T10:05:00Z", by: "Ada" } : null } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: changed(), log: [], outputCut: false } }));
  const base = "/api/tasks/t1/changes";
  await page.route((url) => url.pathname === base, (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [{ path: "src/cart.ts", status: "modified", previousPath: null, additions: 3, deletions: 1, binary: false, test: false }, { path: "README.md", status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], untracked: [{ path: ".env", status: "modified" }] } } }));
  await page.route((url) => url.pathname.startsWith(`${base}/`), (route) => route.fulfill({ json: { file: { path: "src/cart.ts", status: "modified", previousPath: null, additions: 3, deletions: 1, binary: false, test: false, patch: "@@ -1 +1 @@\n-old\n+new", truncated: false, note: null } } }));
  await page.route("**/api/tasks/t1/undo", (route) => {
    undone = true;
    return route.fulfill({ json: { task: changed(), undone: ["src/cart.ts"], kept: ["README.md"] } });
  });
  const keeps: unknown[] = [];
  await page.route("**/api/tasks/t1/keep", (route) => {
    keeps.push(route.request().postDataJSON());
    kept = true;
    return route.fulfill({ json: { task: changed() } });
  });
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [{ id: "shop", name: "shop", facts: { git, origin: null, name: "shop", kind: "code" } }], last: "shop" } }));
  return { keeps };
}

test("given a task that changed two files in place, when its starter undoes one of them with a line on why, then only that file is sent, it stays in the list as undone with no action, and the other file and Keep stay", async ({ page }) => {
  // given
  const sent: Record<string, unknown>[] = [];
  const file = (path: string, state?: "undone") => ({ path, status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false, ...(state ? { state } : {}) });
  const changed = () => task({ status: "needs-review", phase: "review", result: "changes", repoId: "shop", changes: { files: [file("src/cart.ts", sent.length ? "undone" : undefined), file("README.md")], undone: null, kept: null } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: changed(), log: [], outputCut: false } }));
  const base = "/api/tasks/t1/changes";
  await page.route((url) => url.pathname === base, (route) => route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [file("src/cart.ts"), file("README.md")] } } }));
  await page.route((url) => url.pathname.startsWith(`${base}/`), (route) => route.fulfill({ json: { file: { ...file("src/cart.ts"), patch: "@@ -1 +1 @@\n-old\n+new", truncated: false, note: null } } }));
  await page.route("**/api/tasks/t1/undo", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ json: { task: changed(), undone: ["src/cart.ts"], kept: [] } });
  });
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [{ id: "shop", name: "shop", facts: { git: "none", origin: null, name: "shop", kind: "code" } }], last: "shop" } }));
  await page.goto("/demo/tasks/t1");
  const review = page.getByRole("region", { name: /^Changes/ });

  // when
  await review.getByRole("button", { name: "Undo src/cart.ts" }).click();
  const question = review.getByRole("group", { name: "Undo this file" });
  await expect(question).toContainText("src/cart.ts goes back to how it was before the task; the other files stay as they are.");
  await expect(question).toContainText("Goes in the task's log");
  await question.getByLabel("Why").fill("The cart rounding belongs in another task");
  await question.getByRole("button", { name: "Undo this file", exact: true }).click();

  // then
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ paths: ["src/cart.ts"], reason: "The cart rounding belongs in another task" });
  const cart = review.locator(".request-diff li").filter({ hasText: "src/cart.ts" });
  await expect(cart.locator("summary")).toContainText("undone");
  await expect(cart.locator(".diff-stat")).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Undo src/cart.ts" })).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Undo README.md" })).toBeVisible();
  await expect(page.locator("header.page-head").getByRole("button", { name: "Keep these changes" })).toBeVisible();
});

test("given a task that changed a folder without Git in place, when its starter reads the changes and undoes them, then the files and untracked note show with no word of Git, and undo asks first and names the file kept", async ({ page }) => {
  // given
  await changedInPlace(page, "none");
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(e.message));
  await page.goto("/demo/tasks/t1");
  const review = page.getByRole("region", { name: /^Changes/ });

  // then the server's list of changed files is counted and drawn as rows, never as an object
  await expect(review.getByRole("heading", { level: 2 })).toHaveText(/^Changes 2/);
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  expect(crashes).toEqual([]);
  await expect(review.locator(".request-diff")).toBeVisible();
  await expect(review.locator("details.request-diff")).toHaveCount(0);
  await expect(review).toContainText("src/cart.ts");
  await expect(review).toContainText("The orchestrator keeps no copy of these files, such as one that looks like it holds a secret, so Undo leaves them as the agent left them.");
  await expect(review).toContainText(".env");
  await expect(page.getByText(/Request #/)).toHaveCount(0);

  // then Keep is the one thing to do, Undo sits beside it, and a person who does not use Git meets no word of it here
  await expect(page.locator("header.page-head .actions > button")).toHaveText(["Keep these changes", "Undo these changes…", "Share…"]);
  await expect(page.locator("header.page-head").getByRole("button", { name: "Keep these changes" })).not.toHaveClass(/secondary/);
  await expect(page.locator("header.page-head").getByRole("button", { name: "Undo these changes…" })).toHaveClass(/secondary/);
  await expect(review).not.toContainText(/git|commit/i);
  await expect(page.locator("header.page-head")).not.toContainText(/git|commit/i);

  // when the starter undoes the changes
  await page.locator("header.page-head").getByRole("button", { name: "Undo these changes…" }).click();
  await page.locator("header.page-head").getByRole("button", { name: "Undo changes" }).click();

  // then
  await expect(review).toContainText("Undone by Ada");
  await expect(page.locator('[data-status="undone"]')).toHaveText("undone");
  await expect(page.locator('[data-status="undone"]')).toHaveClass(/neutral/);
  await expect(review).toContainText("One file was edited after the task and kept as you left it: README.md.");
  await expect(page.locator("header.page-head").getByRole("button", { name: "Undo these changes…" })).toHaveCount(0);
});

test("given a task that changed a folder without Git, when its starter keeps the changes, then the review closes with who kept them, and neither Keep nor Undo is offered again", async ({ page }) => {
  // given
  const { keeps } = await changedInPlace(page, "none");
  await page.goto("/demo/tasks/t1");
  const review = page.getByRole("region", { name: /^Changes/ });

  // when
  await page.locator("header.page-head").getByRole("button", { name: "Keep these changes" }).click();

  // then
  await expect(review).toContainText("Kept by Ada at 2026-11-04 10:05. The files stay as the agent left them.");
  await expect(page.locator('[data-status="kept"]')).toHaveText("kept on this machine");
  await expect(page.locator('[data-status="kept"]')).toHaveClass(/\bok\b/);
  await expect(page.locator("header.page-head").getByRole("button", { name: "Keep these changes" })).toHaveCount(0);
  await expect(page.locator("header.page-head").getByRole("button", { name: "Undo these changes…" })).toHaveCount(0);
  expect(keeps).toHaveLength(1);
  expect((keeps[0] as { commandId: string }).commandId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});

test("given a folder its person made a Git repository, when the task's changes are committed, then the first commit takes the server's message and leaves the secret-looking file out", async ({ page }) => {
  // given
  await changedInPlace(page, "repo");
  let committed: unknown = null;
  await page.route("**/api/projects/shop/git/commit", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { files: [{ path: "src/cart.ts", status: "modified", bytes: 120, secretLike: false }, { path: ".env", status: "added", bytes: 40, secretLike: true }], omitted: 0, first: true, message: "Start shop" } });
    committed = route.request().postDataJSON();
    return route.fulfill({ json: { project: { id: "shop", facts: { git: "repo" } }, headSha: "abc1234def5678" } });
  });
  await page.goto("/demo/tasks/t1");
  const review = page.getByRole("region", { name: /^Changes/ });

  // when
  await page.locator("header.page-head").getByRole("button", { name: "Commit these changes" }).click();
  const commit = review.getByRole("form", { name: "Commit these changes" });

  // then
  await expect(commit.getByLabel("Message")).toHaveValue("Start shop");
  await expect(commit.getByRole("checkbox", { name: /src\/cart\.ts/ })).toBeChecked();
  await expect(commit.getByRole("checkbox", { name: /\.env/ })).not.toBeChecked();
  await expect(commit).toContainText("looks like it holds a secret, left out");
  await expect(commit).toContainText("1 of 2");

  // when
  await commit.getByRole("button", { name: "Commit", exact: true }).click();

  // then
  await expect(review.getByRole("status")).toHaveText("Committed as abc1234.");
  expect(committed).toMatchObject({ message: "Start shop", exclude: [".env"] });
  expect((committed as { commandId: string }).commandId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
});

test("given tasks whose person undid their changes, kept them or closed their request, and one whose agent failed, when Tasks opens, then each row says the decision in its own words and only the agent's failure reads as failed", async ({ page }) => {
  // given
  const ended = { status: "needs-review", finishedAt: new Date().toISOString(), createdBy: "ada@example.invalid" };
  const tasks = [
    task({ ...ended, id: "tsk_undone", title: "Undone one", phase: "failed", result: "changes", changes: { files: [], undone: { at: "2026-11-04T10:00:00Z", by: "Ada", kept: [] }, kept: null } }),
    task({ ...ended, id: "tsk_kept", title: "Kept one", phase: "merged", result: "changes", changes: { files: [], undone: null, kept: { at: "2026-11-04T10:00:00Z", by: "Ada" } } }),
    task({ ...ended, id: "tsk_closed", title: "Closed one", phase: "failed", result: "request", requestNumber: 7, request: { status: "closed", provider: "local", branch: "b", url: "local://requests/payments-skills/7" } }),
    task({ id: "tsk_failed", title: "Failed one", status: "failed", phase: "failed", error: "the agent exited with code 1", finishedAt: new Date().toISOString(), createdBy: "ada@example.invalid" }),
  ];
  await page.route(/\/api\/tasks(\?.*)?$/, (route) => route.request().method() === "GET" ? route.fulfill({ json: { tasks, next: null } }) : route.fallback());

  // when every task is read, from the fold at the foot of Tasks
  await page.goto("/demo/tasks");
  await page.locator("details.log-fold > summary").filter({ hasText: /^All tasks/ }).click();

  // then
  const row = (title: string) => page.getByRole("row", { name: new RegExp(title) });
  await expect(row("Undone one")).toContainText("undone");
  await expect(row("Kept one")).toContainText("kept on this machine");
  await expect(row("Closed one")).toContainText("undone");
  await expect(row("Failed one")).toContainText("failed");
  for (const title of ["Undone one", "Kept one", "Closed one"]) await expect(row(title)).not.toContainText(/failed|needs review/);
});

test("given a task whose request was pushed to after its check and is held, when its page opens, then the request's line says it changed after the check and why", async ({ page }) => {
  // given
  const held = task({ status: "needs-review", phase: "review", result: "request", requestNumber: 3, request: { status: "open", provider: "local", branch: "b", url: "local://requests/payments-skills/3", heldReason: "b2 changes .claude/settings.json, which the team keeps to its owners" } });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: held, log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator(".forge-state")).toContainText("changed after the check B2 changes .claude/settings.json, which the team keeps to its owners. It merges once a later push passes the team's rules.");
});

test("given a running task whose agent reports its plan, reads, an edit and a failed test run, when its page opens, then the run is the page, and once the task fails with nothing to review it stays open under a head that says how long it went", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let n = 0;
  const line = (data: Record<string, unknown>) => ({ seq: ++n, at, text: "masked", kind: data.type, data });
  const events = [
    line({ type: "todos", items: [{ text: "Read the webhook code", state: "done" }, { text: "Write the runbook entry", state: "doing" }] }),
    line({ type: "message", text: "The retries live in deliver.ts; I will write them up." }),
    line({ type: "tool_call", id: "a", tool: "Read", target: "deliver.ts", status: "started" }),
    line({ type: "tool_call", id: "b", tool: "Read", target: "retry.ts", status: "started" }),
    line({ type: "tool_call", id: "c", tool: "Edit", target: "runbook.md", status: "started" }),
    line({ type: "edit", id: "c", path: "runbook.md", additions: 9, deletions: 2, patch: "@@ -1,2 +1,2 @@\n-Retries: none.\n+Retries: five." }),
    line({ type: "tool_call", id: "d", tool: "Bash", target: null, command: "npm test", status: "started" }),
    line({ type: "tool_output", id: "d", lines: ["1 failing", "retry.test.ts: expected 5"] }),
    line({ type: "tool_call", id: "d", tool: "Bash", status: "failed" }),
    line({ type: "usage", cost: { usd: 0.41, inputTokens: null, outputTokens: null } }),
    line({ type: "message", text: "Two things fail:\n\n- `retry.test.ts` expects **5** tries\n- <img src=x onerror=alert(1)> is not a tag" }),
  ];
  let status = "running";
  await page.route("**/api/tasks/t1?*", (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get("after") ?? "0");
    return route.fulfill({ json: { task: task({ status, startedAt: at, ...(status === "running" ? {} : { finishedAt: at, phase: "failed" }) }), log: after ? [] : events, outputCut: false } });
  });

  // when
  await page.goto("/demo/tasks/t1");

  // then the plan under the head, the agent's words and one line a call
  const plan = page.locator("header.page-head").getByRole("list", { name: "The agent's plan" });
  await expect(plan.locator("li")).toHaveText(["Read the webhook code", "Write the runbook entry"]);
  await expect(plan.locator("li").nth(1)).toHaveAttribute("data-state", "doing");
  await expect(page.locator("header.page-head").getByRole("button", { name: "1 more" })).toBeHidden();
  const atWork = page.getByRole("region", { name: "The agent at work" });
  await expect(atWork.getByRole("list", { name: "The agent's plan" })).toHaveCount(0);
  const stream = atWork.getByRole("list", { name: "What the agent did" });
  await expect(stream.locator(":scope > li")).toHaveText([
    "The retries live in deliver.ts; I will write them up.",
    "Read deliver.ts and retry.ts",
    /^Edited\s+runbook\.md[\s\S]*\+9 −2/,
    /^Ran\s+npm test\s+failed/,
    /^Two things fail:/,
    "Thinking…",
  ], { useInnerText: true });
  await expect(stream.locator(":scope > li[data-kind=tool] .run-mark")).toHaveCount(3);
  await expect(stream.locator(":scope > li").nth(3).locator(".run-mark")).toHaveAttribute("data-status", "failed");
  // the agent's words are read as Markdown, drawn from their parts: code and emphasis, never markup of its own
  const said = stream.locator(":scope > li").nth(4);
  await expect(said.getByRole("listitem")).toHaveText(["retry.test.ts expects 5 tries", "<img src=x onerror=alert(1)> is not a tag"]);
  await expect(said.locator("code")).toHaveText("retry.test.ts");
  await expect(said.locator("strong")).toHaveText("5");
  await expect(said.locator("img")).toHaveCount(0);
  // what a call showed is folded until opened
  const ran = stream.locator(":scope > li").nth(3);
  await expect(ran.getByText("retry.test.ts: expected 5")).toBeHidden();
  await ran.locator("summary").click();
  await expect(ran.getByText("retry.test.ts: expected 5")).toBeVisible();
  // the head counts the time and cost, and the rail grows with what changed
  await expect(page.locator("header.page-head .page-summary")).toHaveText(/^The agent has worked \d+s; \$0\.41 so far\.$/);
  await expect(page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Changed so far" })).toContainText("runbook.md");
  await expect(page.getByRole("group").filter({ hasText: /^Log/ })).not.toHaveAttribute("open", "");

  // when the task ends
  status = "failed";

  // then the run moves under the page as how the agent got here, open, since a failure with nothing to review leaves it the one thing to read
  await expect(page.getByRole("region", { name: "The agent at work" })).toHaveCount(0, { timeout: 15_000 });
  const how = page.locator("details.log-fold").filter({ has: page.locator("summary", { hasText: "How the agent got here" }) });
  await expect(how).toHaveAttribute("open", "");
  await expect(how.getByRole("list", { name: "The agent's plan" }).locator("li")).toHaveText(["Read the webhook code", "Write the runbook entry"]);
  await expect(page.locator("header.page-head").getByRole("list", { name: "The agent's plan" })).toHaveCount(0);
  await expect(page.locator("header.page-head .page-summary")).toHaveText(/^The agent stopped after \d+s\.$/);
});

test("given a running task whose plan has seven steps and whose run is long, when its page opens, then the head shows the step in progress and 6 more, which opens all seven as they stand, and the plan stays in view at the run's end", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const steps = ["Read the webhook code", "Find the retry setting", "Write the runbook entry", "Add a test", "Run the tests", "Fix what fails", "Say what changed"];
  const todos = { seq: 1, at, text: "masked", kind: "todos", data: { type: "todos", items: steps.map((text, i) => ({ text, state: i < 2 ? "done" : i === 2 ? "doing" : "todo" })) } };
  const said = Array.from({ length: 60 }, (_, i) => ({ seq: i + 2, at, text: "masked", kind: "message", data: { type: "message", text: `Step ${i + 1} of the work, said in a sentence long enough to take a line.` } }));
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at }), log: new URL(route.request().url()).searchParams.get("after") === "0" ? [todos, ...said] : [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const head = page.locator("header.page-head");
  const plan = head.getByRole("list", { name: "The agent's plan" });
  await expect(plan.locator("li:visible")).toHaveText(["Write the runbook entry"]);
  const more = head.getByRole("button", { name: "6 more" });
  await expect(more).toHaveAttribute("aria-expanded", "false");

  // when
  await more.click();

  // then
  await expect(plan.locator("li:visible")).toHaveText(steps);
  expect(await plan.locator("li").evaluateAll((items) => items.map((li) => li.getAttribute("data-state")))).toEqual(["done", "done", "doing", "todo", "todo", "todo", "todo"]);
  await expect(head.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");

  // when the person is at the run's end
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  // then the plan is still in view under the head
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const box = (await plan.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});


test("given a task in a folder of the starter's own that has not been asked, when they keep its settings off, then the answer is sent once and the question does not come back", async ({ page }) => {
  // given
  let trust = "unasked";
  let sent: unknown = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", folderTrust: trust }), log: [], outputCut: false } }));
  await page.route("**/api/projects/payments-skills/trust", (route) => {
    sent = route.request().postDataJSON();
    trust = "declined";
    return route.fulfill({ json: { trust } });
  });
  await page.goto("/demo/tasks/t1");
  const question = page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "This folder's settings" });
  await expect(question).toContainText("Use this folder's own Claude Code settings for the next tasks here?");

  // when
  await question.getByRole("button", { name: "Keep them off" }).click();

  // then
  await expect(question).toHaveCount(0);
  expect(sent).toEqual({ trusted: false });
});

test("given a teammate's task in a folder that has not been asked, when it is opened, then no one but the folder's person is asked", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ createdBy: "pat@example.invalid", folderTrust: "unasked" }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Retry a failed capture");
  await expect(page.getByRole("region", { name: "This folder's settings" })).toHaveCount(0);
});

test("given the starter's own task whose agent waits on a card, when its page opens, then the card is the one place to write and no box at the foot covers it", async ({ page }) => {
  // given
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ followUp: "steer", requests: [asked()] }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("listitem", { name: "The agent asks to run a command" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Tell the agent while it works" })).toHaveCount(0);
});

test("given the starter's own task, when they share it with an address that is not a member and then with a teammate, then the first is refused in words, the teammate is listed, and a picked row is removed", async ({ page }) => {
  // given
  let shares: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  let removed: string | null = null;
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review" }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/shares", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { shares } });
    const body = route.request().postDataJSON() as { email: string };
    sent.push(body);
    if (body.email === "outsider@example.invalid") return route.fulfill({ status: 409, json: { error: "outsider@example.invalid is not a member of this organization", code: "not-a-member" } });
    shares = [{ userId: "u-max", name: "Max", email: body.email, sharedBy: "u-ada", at: new Date().toISOString() }];
    return route.fulfill({ status: 201, json: { share: shares[0] } });
  });
  await page.route("**/api/tasks/t1/shares/u-max", (route) => {
    removed = "u-max";
    shares = [];
    return route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/demo/tasks/t1");

  // when an address outside the organization is given
  await page.locator("header.page-head").getByRole("button", { name: "Share…" }).click();
  const form = page.getByRole("form", { name: "Share this task" });
  await form.getByLabel("A teammate's email").fill("outsider@example.invalid");
  await form.getByRole("button", { name: "Share", exact: true }).click();

  // then
  await expect(form.getByRole("alert")).toContainText("is not a member of this organization.");

  // when a teammate's is
  await form.getByLabel("A teammate's email").fill("max@example.invalid");
  await form.getByRole("button", { name: "Share", exact: true }).click();

  // then
  const shared = page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Shared with" });
  await expect(shared.getByRole("option", { name: /Max/ })).toBeVisible();
  await expect(form).toHaveCount(0);

  // when the row is picked and removed
  await shared.getByRole("option", { name: /Max/ }).click();
  await shared.getByRole("button", { name: "Stop sharing with Max" }).click();
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();

  // then
  await expect.poll(() => removed).toBe("u-max");
  await expect(shared).toHaveCount(0);
  expect(sent).toEqual([{ email: "outsider@example.invalid" }, { email: "max@example.invalid" }]);
});

test("given a task's page open while it runs, when it comes to wait for review, then a screen reader is told once and the log itself stays quiet", async ({ page }) => {
  // given
  let status = "running";
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status, ...(status === "running" ? {} : { phase: "review" }) }), log: [], outputCut: false } }));
  await page.goto("/demo/tasks/t1");
  const told = page.locator("div.visually-hidden > span[aria-live='polite']");
  await expect(page.locator("[data-status]").first()).toHaveText("working");
  await expect(told).toHaveText(["", ""]);

  // when
  status = "needs-review";

  // then
  await expect(told.filter({ hasText: /^needs you/ })).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("[role='log']:not([aria-live='off'])")).toHaveCount(0);
});

test("given a finished task whose log comes in two pages, when its page opens, then the second page is read at once and the log holds every line", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const line = (seq: number) => ({ seq, at, text: `line ${seq}` });
  const asked: string[] = [];
  await page.route("**/api/tasks/t1?*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after") ?? "0";
    asked.push(after);
    const pageOf = after === "0" ? { log: [line(1), line(2)], next: 2 } : after === "2" ? { log: [line(3)], next: null } : { log: [], next: null };
    return route.fulfill({ json: { task: task({ status: "needs-review", phase: "review" }), outputCut: false, ...pageOf } });
  });

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.locator("details.log-fold > summary").filter({ hasText: /^Log/ })).toContainText("3");
  expect(asked.slice(0, 2)).toEqual(["0", "2"]);
});

test("given a finished task whose tests still fail after two repair rounds, when its page opens, then the rail's first section names each check and the head says it fails", async ({ page }) => {
  // given
  const run = (code: number, output = "") => ({ code, timedOut: false, ms: 1200, output, cut: 0 });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", finishedAt: new Date().toISOString() }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/verification", (route) => route.fulfill({ json: { verifications: [{ repoId: "payments-skills", verification: {
    checks: [
      { command: "npm test", runs: "vitest run", source: "package.json", before: run(0), after: [run(1), run(1), run(1, "1 failing: retry.test.ts expected 5")], verdict: "broken" },
      { command: "npm run lint", runs: "eslint .", source: "package.json", before: run(0), after: [run(0)], verdict: "passed" },
    ],
    setup: null, repairs: 2, verdict: "broken", reason: "Its tests still fail after 2 repair rounds.",
  } }] } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const checks = page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Checks" });
  await expect(checks.locator("li")).toHaveText([/^npm test passed before, failed after 2 repair rounds/, /^npm run lint passed before, passed after/]);
  await expect(checks.locator("li").first()).toHaveClass(/error/);
  await expect(page.locator("header.page-head .page-summary")).toHaveText("Its tests still fail after 2 repair rounds.");

  // when its output is opened
  await checks.locator("li").first().locator("summary").click();

  // then
  await expect(checks.locator("li").first()).toContainText("1 failing: retry.test.ts expected 5");
});

test("given checks a teammate's machine ran, when the task opens and when it ran on the orchestrator, then only the machine's checks say where they ran", async ({ page }) => {
  // given
  const run = (code: number) => ({ code, timedOut: false, ms: 1200, output: "", cut: 0 });
  let runner: "local" | undefined = "local";
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", finishedAt: new Date().toISOString(), createdBy: "pat@example.invalid", ...(runner ? { runner } : {}) }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/verification", (route) => route.fulfill({ json: { verifications: [{ repoId: "payments-skills", verification: {
    checks: [{ command: "npm test", runs: "vitest run", source: "package.json", before: run(0), after: [run(0)], verdict: "passed" }],
    setup: null, repairs: 0, verdict: "passed", reason: "",
  } }] } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const checks = page.getByRole("complementary", { name: "About this task" }).getByRole("region", { name: "Checks" });
  await expect(checks).toContainText("These checks ran on pat@example.invalid's machine, not on the orchestrator.");

  // when
  runner = undefined;
  await page.reload();

  // then
  await expect(checks.locator("li")).toHaveText([/^npm test passed before, passed after/]);
  await expect(checks).not.toContainText("ran on");
});

test("given a task in a folder without Git on its person's machine, when its review opens, then the changed files are listed from what the machine reported and the page says where they are read", async ({ page }) => {
  // given
  const file = { path: "runbooks/failed-webhooks.md", status: "modified", previousPath: null, additions: null, deletions: null, binary: false, test: false };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", result: "changes", requestNumber: null, request: null, changes: { files: [file], undone: null } }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/changes", (route) => route.fulfill({ status: 409, json: { error: "this task's change is in a folder of its person's machine; its files are read there, not here", code: "changes-on-machine" } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByText("runbooks/failed-webhooks.md")).toBeVisible();
  await expect(page.getByText("These files changed on the computer the task ran on; open the folder there to read them.")).toBeVisible();
  // a short list opens its files by itself, each saying where its patch is
  await expect(page.getByText("Its patch stays on the computer the task ran on; open the folder there to read it.")).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("given a task in review on a phone, when its page opens, then its main action sits at the foot of the main surface and sticks, Share stays in the head, and a card waiting for an answer takes the foot", async ({ page }) => {
    // given
    const at = new Date().toISOString();
    let requests: Record<string, unknown>[] = [];
    await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, requestNumber: 7, createdBy: "ada@example.invalid", request: { status: "open", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" }, requests }), log: [], outputCut: false } }));
    await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
    await page.goto("/demo/tasks/t1");
    const foot = page.locator(".foot-actions");

    // then
    await expect(foot.getByRole("link", { name: "Open the request" })).toBeVisible();
    await expect(foot).toHaveCSS("position", "sticky");
    await expect(page.locator("header.page-head").getByRole("link", { name: "Open the request" })).toHaveCount(0);

    // when a card waits
    requests = [{ id: "r1", kind: "command", payload: { tool: "Bash", summary: "npm test" }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: at }];
    await page.reload();

    // then
    await expect(page.locator(".foot-actions")).toHaveCSS("position", "static");
  });

  test("given a task in review on a phone with a follow-up box, when the box has the focus, then the foot row stops sticking over it, and sticks again once the focus leaves", async ({ page }) => {
    // given
    const at = new Date().toISOString();
    await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", startedAt: at, finishedAt: at, requestNumber: 7, followUp: "continue", createdBy: "ada@example.invalid", request: { status: "open", provider: "local", branch: "handbook/task-t1", url: "local://requests/payments-skills/7" }, requests: [] }), log: [], outputCut: false } }));
    await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
    await page.goto("/demo/tasks/t1");
    const foot = page.locator(".foot-actions");
    await expect(foot).toHaveCSS("position", "sticky");

    // when the person types in the follow-up box
    await page.locator("textarea.follow-text").focus();

    // then
    await expect(foot).toHaveCSS("position", "static");

    // when the focus leaves
    await page.locator("textarea.follow-text").blur();

    // then
    await expect(foot).toHaveCSS("position", "sticky");
  });
});

test("given a running task, when its starter stops the agent's step, then the task reads needs you with the sentence and the button is gone, and a refusal shows beside it", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let stopped = false;
  let refuse = true;
  await page.addInitScript(() => delete (window as unknown as { EventSource?: unknown }).EventSource);
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, followUp: "steer", ...(stopped ? { state: "needs-you", stage: "stopped" } : {}) }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/stop-step", (route) => {
    if (refuse) return route.fulfill({ status: 409, json: { error: "The agent's session has not opened yet", code: "no-session" } });
    stopped = true;
    return route.fulfill({ json: { task: task({ status: "running", startedAt: at, followUp: "steer", state: "needs-you", stage: "stopped" }) } });
  });
  await page.goto("/demo/tasks/t1");

  // when
  await page.getByRole("button", { name: "Stop this step" }).click();

  // then
  await expect(page.getByRole("alert").filter({ hasText: "has not opened yet" })).toBeVisible();

  // when
  refuse = false;
  await page.getByRole("button", { name: "Stop this step" }).click();

  // then
  await expect(page.getByText("You stopped the agent's step; tell it what to do next.")).toBeVisible();
  await expect(page.locator("header.page-head [data-status]").first()).toHaveText("needs you");
  await expect(page.getByRole("button", { name: "Stop this step" })).toHaveCount(0);
});

test("given the first task in a folder that found checks nobody approved, when its review opens, then one line names them and Review them opens the folder's settings", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", requestNumber: 7, request: { status: "open", provider: "local", branch: "handbook/t1", url: "" }, startedAt: at, finishedAt: at, checksFound: [{ command: "npm test", source: "package.json" }, { command: "npm run lint", source: "package.json" }] }), log: [], outputCut: false } }));
  await standInChanges(page, "payments-skills", 7, [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }]);

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByText("npm test and npm run lint were found for this folder; approve them to run after each task.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review them" })).toHaveAttribute("href", /\/settings\/code$/);
});

test("given a task started from a turn of another, when its page opens, then the stream's first line says where it started from and opens that task", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const started = { seq: 1, at, text: "Started from “Also return the window” in Retry a failed capture", kind: "started-from", data: { type: "started-from", taskId: "t0", n: 2 } };
  const said = { seq: 2, at, text: "masked", kind: "message", data: { type: "message", text: "Reading the files as that turn left them." } };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at }), log: new URL(route.request().url()).searchParams.get("after") === "0" ? [started, said] : [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const first = page.locator("li.run-line").first();
  await expect(first).toContainText("Started from “Also return the window” in Retry a failed capture");
  await expect(first.getByRole("link", { name: "Open it" })).toHaveAttribute("href", /\/tasks\/t0$/);
});

test("given a task held at the usage limit and a second sign-in named in the settings, when its starter presses Continue with your second sign-in, then the task goes on at once, and without the second sign-in no such button is offered", async ({ page }) => {
  // given
  const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
  let named: string | null = "/home/ada/.claude-second";
  let sent: Record<string, unknown> | null = null;
  const held = task({ status: "queued", phase: "working", waitingFor: "limit", resetAt, startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: held, log: [], outputCut: false } }));
  await page.route("**/api/settings/task-limits", (route) => route.fulfill({ json: { maxUsd: null, maxMinutes: null, secondSignIn: named } }));
  await page.route("**/api/tasks/t1/continue", (route) => {
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ json: { task: { ...held, status: "running", waitingFor: null, secondSignIn: true } } });
  });

  // when
  await page.goto("/demo/tasks/t1");
  await page.getByRole("button", { name: "Continue with your second sign-in" }).click();

  // then
  await expect.poll(() => sent).toMatchObject({ secondSignIn: true });

  // when no second sign-in is named
  named = null;
  await page.reload();

  // then
  await expect(page.locator(".waiting")).toContainText("Your plan's usage limit is reached");
  await expect(page.getByRole("button", { name: "Continue with your second sign-in" })).toHaveCount(0);

  // when someone who does not manage the limits is told only that one is named
  await page.unroute("**/api/settings/task-limits");
  await page.route("**/api/settings/task-limits", (route) => route.fulfill({ json: { maxUsd: null, maxMinutes: null, secondSignInSet: true } }));
  await page.reload();

  // then
  await expect(page.getByRole("button", { name: "Continue with your second sign-in" })).toBeVisible();
});

test("given the task limits page on one person's own orchestrator, when a second sign-in folder is named and saved, then the save carries it with the limits, an empty field clears it, and a save that leaves it alone does not send it", async ({ page }) => {
  // given
  const saved: Record<string, unknown>[] = [];
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  await page.route("**/api/settings/task-limits", (route) => {
    if (route.request().method() === "PUT") {
      saved.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({ json: saved.at(-1) });
    }
    return route.fulfill({ json: { maxUsd: 5, maxMinutes: 60, secondSignIn: null } });
  });
  await page.goto("/demo/settings/task-limits");

  // when
  await page.getByLabel("Another Claude Code sign-in").fill("/home/ada/.claude-second");
  await page.getByRole("button", { name: "Save" }).click();

  // then
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ maxUsd: 5, maxMinutes: 60, secondSignIn: "/home/ada/.claude-second" });
  await expect(page.getByRole("status").filter({ hasText: "A task now stops at" })).toBeVisible();

  // when
  await page.getByLabel("Another Claude Code sign-in").fill("");
  await page.getByRole("button", { name: "Save" }).click();

  // then
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1]).toMatchObject({ secondSignIn: null });
  await expect(page.getByRole("status").filter({ hasText: "A task now stops at" })).toBeVisible();

  // when
  await page.getByRole("button", { name: "Save" }).click();

  // then
  await expect.poll(() => saved.length).toBe(3);
  expect(saved[2]).toEqual({ maxUsd: 5, maxMinutes: 60 });
});

test("given a running task whose agent waits on a card, when its starter opens it, then Stop this step is not offered, since the agent is not in a step", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  await page.addInitScript(() => delete (window as unknown as { EventSource?: unknown }).EventSource);
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, followUp: "steer", requests: [asked()] }), log: [], outputCut: false } }));

  // when
  await page.goto("/demo/tasks/t1");

  // then
  await expect(page.getByRole("button", { name: "Stop…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop this step" })).toHaveCount(0);
});

test("given a finished task that kept its setup, turned a skill off and still called it, when its page opens, then one Started with block counts what loaded once, names what was used with a link to where, leads with the item loaded though off, and folds Loaded and Off for this task", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const setup = [
    { id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes" }, { name: "changelog" }, { name: "review-checklist" }, { name: "standup" }], commands: [], mcpServers: [{ name: "jira" }], hooks: [], claudeMd: true },
    { id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", version: "1.4.0", enabled: true, skills: [{ name: "add-endpoint" }], commands: [], mcpServers: [], hooks: [] },
  ];
  const off = { sources: [], skills: [{ source: "yours", name: "changelog" }, { source: "yours", name: "standup" }, { source: "yours", name: "review-checklist" }], commands: [], mcpServers: [] };
  await page.route("**/api/handbook/defaults", (route) => route.fulfill({ json: { off: { skills: [{ source: "yours", name: "standup" }] } } }));
  const used = { skills: [{ name: "release-notes", source: "yours", sourceLabel: "Yours", seq: 2 }, { name: "changelog", source: "yours", sourceLabel: "Yours" }, { name: "add-endpoint", source: "plugin:payments-skills@payments-market", sourceLabel: "payments-skills 1.4.0" }], mcpServers: [] };
  const log = [{ seq: 1, at, text: "Claude Code started." }, { seq: 2, at, text: "Skill release-notes" }];
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, setup, off, offChanges: 2, used, loaded: { commands: 3, plugins: 1, mcpServers: 1, claudeMd: true }, startedWith: { plugins: ["payments-skills@payments-market"], skills: null, mcpServers: [{ name: "jira", state: "failed" }] } }), log, outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");
  const block = page.getByRole("region", { name: "Started with" });
  const line = (name: string) => block.locator(".started-line").filter({ hasText: name });

  // then
  await expect(block.locator("p").first()).toHaveText("jira was on and did not load.");
  await expect(block.locator("p").nth(1)).toHaveText("2 skills, 1 plugin, 1 MCP server, CLAUDE.md");
  await expect(line("changelog")).toContainText("changelog from yours Loaded, though off");
  await expect(line("add-endpoint")).toHaveText("add-endpoint from payments-skills 1.4.0");
  await expect(page.getByRole("complementary", { name: "About this task" })).not.toContainText("skills or commands");

  // when
  await line("release-notes").getByRole("button", { name: "release-notes" }).click();

  // then
  await expect(page.locator("#log-line-2")).toBeInViewport();

  // when
  await block.getByText("Loaded (2)").click();
  await block.getByText("Off (1)", { exact: true }).click();
  await block.getByText("Off for this task (1)").click();

  // then
  await expect(line("jira")).toContainText("jira from yours Loaded");
  await expect(line("standup")).toContainText("standup from yours Off");
  await expect(line("standup")).not.toContainText("for this task");
  await expect(line("review-checklist")).toContainText("review-checklist from yours Off for this task");
});

test("given a lesson waiting in a finished task's review on one person's own orchestrator, when it is kept in this folder, then the keep says so, and The team keeps it as theirs and points to Team", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const kept: unknown[] = [];
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, routing: { path: "/home/ada/work/payments-api" } }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  const lesson = (slug: string) => ({ slug, description: `Lesson ${slug}`, status: "pending", createdAt: at, taskId: "t1" });
  await page.route("**/api/tasks/t1/lessons", (route) => route.fulfill({ json: { skills: { team: [], project: [] }, candidates: [lesson("retry-once"), { ...lesson("name-the-queue"), ...(kept.length > 1 ? { status: "approved" } : {}) }] } }));
  await page.route("**/api/skills/*/outcomes*", (route) => route.fulfill({ json: { pivot: null, minimum: 5, before: {}, with: {} } }));
  await page.route(/\/api\/tasks\/t1\/lessons\/[^/]+$/, (route) => route.fulfill({ json: { lesson: { ...lesson(route.request().url().split("/").pop()!), skillMd: "Retry once.", quote: null } } }));
  await page.route(/\/api\/tasks\/t1\/lessons\/[^/]+\/keep$/, (route) => {
    kept.push({ slug: route.request().url().split("/").at(-2), ...(route.request().postDataJSON() as object) });
    return route.fulfill({ json: { lesson: { status: "approved" } } });
  });
  await page.goto("/demo/tasks/t1");
  const learned = page.getByRole("region", { name: "Learned" });

  // when
  await learned.getByText("Lesson retry-once").click();
  await learned.getByRole("button", { name: "This folder (payments-api)" }).click();
  await learned.getByRole("button", { name: "Keep", exact: true }).first().click();

  // then
  await expect.poll(() => kept).toEqual([{ slug: "retry-once", target: "folder" }]);

  // when
  await learned.getByText("Lesson name-the-queue").click();
  const second = learned.locator("details").filter({ hasText: "Lesson name-the-queue" });
  await second.getByRole("button", { name: "The team" }).click();
  await second.getByRole("button", { name: "Keep", exact: true }).click();

  // then
  await expect.poll(() => kept.length).toBe(2);
  expect(kept[1]).toEqual({ slug: "name-the-queue", target: "yours" });
  await expect(learned.getByRole("link", { name: "share it with the team on Team" })).toBeVisible();
});

test("given a task whose agent used a team skill and a plugin's skill and had a request denied, when its page opens, then each skill is said once with its one way to improve: the team's starts an Improve a skill task asked first, and Copy to Yours writes the plugin's text as the person's own", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const written: unknown[] = [];
  let started: Record<string, unknown> | null = null;
  const used = { skills: [{ name: "add-endpoint", source: "team:payments-skills", sourceLabel: "the team's payments-skills" }, { name: "write-docs", source: "plugin:docs-kit@payments-market", sourceLabel: "docs-kit 2.0.0" }], mcpServers: [] };
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, used, requests: [asked({ status: "answered", answer: { decision: "deny" }, answeredBy: "ada@example.invalid" })] }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/tasks/t1/lessons", (route) => route.fulfill({ json: { skills: { team: [], project: [] }, candidates: [], improvable: ["add-endpoint"] } }));
  await page.route("**/api/handbook/skill?*", (route) => route.fulfill({ json: { content: "---\nname: write-docs\n---\nWrite the docs." } }));
  await page.route("**/api/handbook/file", (route) => {
    written.push(route.request().postDataJSON());
    return route.fulfill({ json: { digest: "d1" } });
  });
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    started = route.request().postDataJSON();
    return route.fulfill({ json: { task: task({ id: "t9", status: "queued" }) } });
  });

  // when
  await page.goto("/demo/tasks/t1");

  // then
  const lines = page.locator(".used-corrected li");
  await expect(lines.nth(0)).toContainText("add-endpoint was used, and a request it made was denied.");

  // when
  await lines.nth(1).getByRole("button", { name: "Copy to Yours" }).click();

  // then
  await expect(lines.nth(1)).toContainText("Copied to yours.");
  expect(written).toEqual([{ source: "yours", kind: "skill", name: "write-docs", content: "---\nname: write-docs\n---\nWrite the docs.", expectedDigest: null }]);

  // when
  await lines.nth(0).getByRole("button", { name: "Improve this skill…" }).click();
  await page.getByRole("button", { name: "Start the task" }).click();

  // then
  await expect.poll(() => started).toMatchObject({ repoId: "payments-skills", template: { kind: "skill.improve", skill: "add-endpoint" } });
  await expect(page).toHaveURL(/\/tasks\/t9$/);
});

test("given an ended task whose log runs to a second page, when its page opens with the log folded, then only the first page is read, and opening the log reads the rest", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const reads: string[] = [];
  const line = (seq: number) => ({ seq, at, text: `line ${seq}` });
  await page.route("**/api/tasks/t1?*", (route) => {
    const after = new URL(route.request().url()).searchParams.get("after") ?? "0";
    reads.push(after);
    const first = after === "0";
    return route.fulfill({ json: { task: task({ status: "needs-review", phase: "review", requestNumber: null, startedAt: at, finishedAt: at, changes: { files: [{ path: "a.md", status: "modified", previousPath: null, additions: 1, deletions: 0, binary: false, test: false }], undone: null } }), log: first ? [line(1), line(2)] : [line(3), line(4)], outputCut: false, ...(first ? { next: 2 } : {}) } });
  });
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // then
  await expect.poll(() => reads).toEqual(["0"]);

  // when
  await page.locator("details.log-fold > summary").filter({ hasText: /^Log/ }).click();

  // then
  await expect.poll(() => reads).toEqual(["0", "2"]);
  await expect(page.getByRole("log", { name: "Task log" })).toContainText("line 4");
});

test("given words sent to a running agent, when the stream shows them, then on one person's own orchestrator they read You even when the person has no name, and on a team's a teammate's keep their name", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let local = true;
  const steer = (seq: number, by: string, text: string) => ({ seq, at, text: `${by}: ${text}`, kind: "steer", data: { type: "steer", text, by } });
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, ...(local ? { mode: "local" } : {}) } } });
  });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "running", startedAt: at, followUp: "steer" }), log: new URL(route.request().url()).searchParams.get("after") === "0" ? [steer(1, "A teammate", "Expose the return-label endpoint to customers too."), steer(2, "Pat Payments", "Keep the old route.")] : [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");
  const said = page.locator('li.run-line[data-kind="you"]');

  // then
  await expect(said.nth(0)).toHaveText("You Expose the return-label endpoint to customers too.");
  await expect(said.nth(1)).toHaveText("You Keep the old route.");

  // when
  local = false;
  await page.reload();

  // then
  await expect(said.nth(1)).toHaveText("Pat Payments Keep the old route.");
});

test("given one person's own task whose agent works again on its open change, when its page opens, then neither Keep nor Discard is offered until the run ends", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  let status = "running";
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status, phase: status === "running" ? "working" : "review", startedAt: at, ...(status === "running" ? {} : { finishedAt: at }), followUp: status === "running" ? "steer" : "continue", requestNumber: 7, request: { status: "open", provider: "local", branch: "handbook/t1", url: "" } }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/api/repos/payments-skills/requests/7/on-forge", (route) => route.fulfill({ json: { forge: null, url: null, number: null } }));
  await standInChanges(page, "payments-skills", 7, [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }]);

  // when
  await page.goto("/demo/tasks/t1");
  const head = page.locator("header.page-head");

  // then
  await expect(head.locator("[data-status]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep these changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Discard these changes…" })).toHaveCount(0);

  // when the run ends
  status = "needs-review";
  await page.reload();

  // then
  await expect(head.getByRole("button", { name: "Keep these changes" })).toBeVisible();
});

test("given an agent's answer that holds a Markdown table, when the task page opens, then the table is drawn as a table and no bars show as text", async ({ page }) => {
  // given
  const at = new Date().toISOString();
  const lastSaid = "Changed files:\n\n| File | Change |\n|---|---|\n| src/a.ts | retry added |\n| src/b.ts | name fixed |";
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", state: "finished-nothing-changed", startedAt: at, finishedAt: at, lastSaid }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

  // when
  await page.goto("/demo/tasks/t1");
  const answer = page.getByRole("region", { name: "The agent's answer" });

  // then
  await expect(answer.getByRole("columnheader")).toHaveText(["File", "Change"]);
  await expect(answer.getByRole("cell").first()).toHaveText("src/a.ts");
  await expect(answer).not.toContainText("|---|");
});

test("given a task page at 1440, when the rail's edge is stepped by arrow, then the right rail changes width and a double press brings back its default of 420 pixels", async ({ page }) => {
  // given
  await page.setViewportSize({ width: 1440, height: 900 });
  const at = new Date().toISOString();
  await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: task({ status: "failed", phase: "failed", startedAt: at, finishedAt: at, description: "Add a retry to the webhook." }), log: [], outputCut: false } }));
  await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));
  await page.goto("/demo/tasks/t1");
  const rail = page.getByRole("complementary", { name: "About this task" });
  const handle = page.getByRole("separator", { name: "Width of the side panel" });
  const width = async () => Math.round((await rail.boundingBox())!.width);

  // then
  await expect.poll(width).toBe(420);

  // when
  await handle.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");

  // then
  await expect.poll(width).toBe(500);

  // when
  await handle.dblclick();

  // then
  await expect.poll(width).toBe(420);
});
