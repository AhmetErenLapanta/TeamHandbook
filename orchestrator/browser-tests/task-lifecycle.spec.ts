import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { choose, chooseAgent, moreOptions, newTaskForm, optionsOf, work as fillWork } from "./task-form.js";
import { taskLog } from "./task-page.js";

// The orchestrator the suite started itself, on this machine: its data directory and the demo's
// bare repositories can be looked at directly. Against an orchestrator run elsewhere they cannot.
const external = !!process.env.ORCHESTRATOR_E2E_BASE_URL;
const scratch = process.env.ORCHESTRATOR_E2E_SCRATCH!;
const taskDir = (id: string) => join(scratch, "data", "tasks", "demo", id);
const bare = (repo: string) => join(scratch, "demo", "repos", `${repo}.git`);

interface ApiTask { id: string; title: string; description: string; status: string; error: string | null; startedAt: string | null; requestNumber: number | null; queuePosition: number | null }

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  return { "x-csrf-token": (await (await request.get("/api/me")).json()).csrf };
}

async function startTask(request: APIRequestContext, title: string, description = "", repoId = "payments-skills"): Promise<ApiTask> {
  const res = await request.post("/api/tasks", { data: { title, description, repoId, agent: "fake" }, headers: await csrf(request) });
  expect(res.status()).toBe(201);
  return (await res.json()).task;
}

async function taskOf(request: APIRequestContext, id: string): Promise<{ task: ApiTask; log: { text: string }[] }> {
  return (await request.get(`/api/tasks/${id}`)).json();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(page: Page): Promise<number> {
  const line = (await taskLog(page)).getByText(/waiting \d+ seconds \(pid \d+\)/);
  await expect(line).toBeVisible({ timeout: 30_000 });
  return Number((await line.textContent())!.match(/pid (\d+)/)![1]);
}

// One orchestrator runs the whole suite one task at a time: a slow task a test leaves behind would
// hold every later test's task in line.
test.afterEach(async ({ request }) => {
  const tasks = (await (await request.get("/api/tasks")).json()).tasks as ApiTask[];
  const headers = await csrf(request);
  for (const task of tasks.filter((t) => t.status === "queued" || t.status === "running")) {
    await request.post(`/api/tasks/${task.id}/cancel`, { headers });
  }
});

test("given one task at a time and five started in a row, when a waiting one and then the running one are cancelled, then the list shows each one's place, the cancelled ones stop and leave nothing behind, and the rest run in the order they were asked for", async ({ page, request }) => {
  // given
  const slow = await startTask(request, "Hold the line", "stand-in: wait 60 seconds");
  const waiting = [];
  for (const n of [1, 2, 3, 4]) waiting.push(await startTask(request, `Wait in line ${n}`));
  await page.goto("/demo/tasks");
  const row = (title: string) => page.getByRole("row").filter({ hasText: title }).first();
  await expect(row("Hold the line")).toContainText("working");
  for (const n of [1, 2, 3, 4]) await expect(row(`Wait in line ${n}`)).toContainText("waiting its turn");
  // The list says only that a task waits; its place in line is on its page.
  const place = async (id: string) => {
    await page.goto(`/demo/tasks/${id}`);
    return page.locator("[data-status]").first();
  };
  for (const [i, t] of waiting.entries()) await expect(await place(t.id)).toHaveText(`waiting its turn, #${i + 1} in line`);

  // when a waiting one is cancelled, through the question that says what cancelling loses
  await page.goto(`/demo/tasks/${waiting[1]!.id}`);
  await page.getByRole("button", { name: "Stop…", exact: true }).click();
  const question = page.getByRole("group", { name: "Stop task" });
  await expect(question).toContainText("The task leaves the line before it starts. This cannot be undone");
  await expect(question.getByRole("button", { name: "Keep it in line" })).toBeFocused();
  await question.getByRole("button", { name: "Stop task", exact: true }).click();

  // then it stops before it starts, and the ones behind it move up
  await expect(page.locator("[data-status]").first()).toHaveText("stopped");
  await expect((await taskLog(page))).toHaveText(/Cancelled before it started\./);
  await expect(await place(waiting[2]!.id)).toHaveText("waiting its turn, #2 in line");
  await expect(await place(waiting[3]!.id)).toHaveText("waiting its turn, #3 in line");

  // when the running one is cancelled
  await page.goto(`/demo/tasks/${slow.id}`);
  const pid = await pidOf(page);
  if (!external) expect(existsSync(taskDir(slow.id))).toBe(true);
  await page.getByRole("button", { name: "Stop…", exact: true }).click();
  const running = page.getByRole("group", { name: "Stop task" });
  await expect(running).toContainText("The agent stops now; what it changed so far waits for your review.");
  // keeping it closes the question and leaves the task as it was
  await running.getByRole("button", { name: "Keep it running" }).click();
  await expect(page.getByRole("group", { name: "Stop task" })).toHaveCount(0);
  await expect(page.locator("[data-status]").first()).toHaveText("working");
  await page.getByRole("button", { name: "Stop…", exact: true }).click();
  await page.getByRole("group", { name: "Stop task" }).getByRole("button", { name: "Stop task", exact: true }).click();

  // then its agent, its directory and any branch are gone, and the line moves on in order
  await expect(page.locator("[data-status]").first()).toHaveText("stopped", { timeout: 15_000 });
  await expect((await taskLog(page))).toContainText("Cancelled.");
  if (!external) {
    await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
    expect(existsSync(taskDir(slow.id))).toBe(false);
    expect(execFileSync("git", ["for-each-ref", "--format=%(refname)", `refs/heads/task/${slow.id}`], { cwd: bare("payments-skills"), encoding: "utf8" }).trim()).toBe("");
  }
  const ran = [waiting[0]!, waiting[2]!, waiting[3]!];
  await expect.poll(async () => Promise.all(ran.map(async (t) => (await taskOf(request, t.id)).task.status)), { timeout: 60_000 }).toEqual(["needs-review", "needs-review", "needs-review"]);
  const started = await Promise.all(ran.map(async (t) => (await taskOf(request, t.id)).task.startedAt!));
  expect([...started].sort()).toEqual(started);
  expect((await taskOf(request, waiting[1]!.id)).task.startedAt).toBeNull();
});

test("given a failed task, when a person runs it again, then a new task starts with the same inputs and the failed one stays as it was", async ({ page, request }) => {
  // given
  const failed = await startTask(request, "Fail on purpose", "Show the retry.\nstand-in: fail");
  await page.goto(`/demo/tasks/${failed.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 30_000 });
  const before = await taskOf(request, failed.id);
  const count = (await (await request.get("/api/tasks")).json()).tasks.length;

  // when
  await page.getByRole("button", { name: "Run again" }).dblclick();

  // then
  await expect(page).not.toHaveURL(new RegExp(`${failed.id}$`));
  const again = page.url().split("/").pop()!;
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fail on purpose");
  await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 30_000 });
  const fresh = (await taskOf(request, again)).task;
  expect([fresh.title, fresh.description]).toEqual([failed.title, failed.description]);
  expect((await (await request.get("/api/tasks")).json()).tasks.length).toBe(count + 1);
  expect(await taskOf(request, failed.id)).toEqual(before);
});

test("given a task waiting for review, when its request is merged, then the task shows it kept rather than waiting", async ({ page, request }) => {
  // given
  const task = await startTask(request, "Note a decision", "", "platform-skills");
  await page.goto(`/demo/tasks/${task.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  await expect(page.getByRole("region", { name: /^Changes/ })).toContainText("waits for a person to review and merge it");
  const { requestNumber } = (await taskOf(request, task.id)).task;

  // when
  const merged = await request.post(`/api/repos/platform-skills/requests/${requestNumber}/merge`, { headers: await csrf(request) });
  expect(merged.status()).toBe(200);
  await page.reload();

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("kept on this machine");
  await expect(page.getByRole("region", { name: /^Changes/ })).toContainText("The change was merged");
  await page.goto("/demo/tasks");
  await expect(page.getByRole("row").filter({ hasText: "Note a decision" }).first().locator(".rc-status")).toHaveText("kept on this machine");
});

test("given an agent that prints ten thousand lines, when its task runs and is opened, then the page keeps answering, the log keeps its limit and says so, and the orchestrator's own lines are kept", async ({ page, request }) => {
  // given
  // How late a 10 ms timer fires is how long the page could not answer. Headless Chromium
  // reports no "longtask" entries, so the observer for those would always read zero.
  await page.addInitScript(() => {
    const w = window as unknown as { longest: number };
    w.longest = 0;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      w.longest = Math.max(w.longest, now - last - 10);
      last = now;
    }, 10);
  });
  const task = await startTask(request, "Talk a great deal", "stand-in: print 10000 lines");

  // when
  await page.goto(`/demo/tasks/${task.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 60_000 });

  // then
  const log = (await taskLog(page));
  await expect(page.getByRole("note")).toContainText("Part of the output was left out; the log marks where.");
  await expect(log.locator("li").last()).toContainText(`It waits for a person to review and merge it.`);
  // Ten thousand lines and the few the stand-in writes around them, less the first 4000 and the last 1000 kept.
  await expect(log).toContainText(/\b50\d\d lines of output were left out here/);
  await expect(log).toContainText("line 10000 of 10000");
  const lines = await log.locator("li").count();
  expect(lines).toBeLessThan(5100);
  const clicked = Date.now();
  await page.getByRole("link", { name: "Tasks", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  const answered = Date.now() - clicked;
  const longest = await page.evaluate(() => (window as unknown as { longest: number }).longest);
  console.log(`ten thousand printed lines: ${lines} log lines shown, longest the page could not answer ${Math.round(longest)} ms, back to the list in ${answered} ms`);
  expect(longest).toBeLessThan(1000);
  expect(answered).toBeLessThan(2000);
});

test("given a failed task whose repository has left the orchestrator's configuration, when its page and the task form open, then Run again is not offered and the form does not list the repository", async ({ page, request }) => {
  // given
  const failed = await startTask(request, "Fail before the repository leaves", "stand-in: fail");
  await expect.poll(async () => (await taskOf(request, failed.id)).task.status, { timeout: 30_000 }).toBe("failed");
  // The suite's orchestrator lists every repository; the form's options are answered as an orchestrator
  // whose configuration dropped payments-skills would answer them.
  await page.route("**/api/tasks/options", async (route) => {
    const answer = await (await route.fetch()).json();
    await route.fulfill({ json: { ...answer, repos: answer.repos.filter((r: { id: string }) => r.id !== "payments-skills") } });
  });

  // when
  await page.goto(`/demo/tasks/${failed.id}`);

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("failed");
  await expect(page.getByRole("button", { name: "Run again" })).toHaveCount(0);

  // when the form is opened
  await page.goto("/demo/tasks");

  // then
  const form = await newTaskForm(page);
  await expect(form.getByRole("combobox", { name: "Kind of task" })).toHaveCount(0);
  await expect(form.getByRole("combobox", { name: "Repository" })).toHaveCount(0);
  await expect(form).not.toContainText("payments-skills");
  // The routed answer is still fetching when the page has what it needs; the next test must not inherit it.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("given the stand-in told to leave its skill without frontmatter, when the task ends, then it fails naming the plugin's rule and opens no request", async ({ page, request }) => {
  // given
  const task = await startTask(request, "Break the skill rule", "stand-in: leave the skill without frontmatter");

  // when
  await page.goto(`/demo/tasks/${task.id}`);

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 30_000 });
  await expect(page.locator("header.page-head .page-summary")).toHaveText(
    /^The agent stopped after \d+s: The agent's skills\/break-the-skill-rule\/SKILL\.md cannot travel: SKILL\.md needs frontmatter with a name and a description; no request was opened\.$/,
  );
  await expect(page.getByRole("alert").filter({ hasText: "cannot travel" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^Changes/ })).toHaveCount(0);
});

test("given the stand-in told to change a hook, when its request opens, then the log and the request's description name the hook first", async ({ page, request }) => {
  // given
  const task = await startTask(request, "Touch the hook", "stand-in: change a hook");

  // when
  await page.goto(`/demo/tasks/${task.id}`);

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  const warning = "hooks/notice.mjs is changed: a hook runs on every teammate's machine at the event it names.";
  await expect((await taskLog(page))).toContainText(`Look at this before merging: ${warning}`);
  const { requestNumber } = (await taskOf(request, task.id)).task;
  const { description } = await (await request.get(`/api/repos/payments-skills/requests/${requestNumber}/description`)).json();
  expect(description.indexOf(`- ${warning}`)).toBeGreaterThan(-1);
  expect(description.indexOf("## Look at these before merging")).toBeLessThan(description.indexOf("## Task"));
});

test("given a team repository whose plugin carries a version, when a task's request opens, then it raises the version and its description says so", async ({ page, request }) => {
  test.skip(external, "the version line is written straight into the suite's own demo repository");
  // given
  const bare = join(scratch, "demo", "repos", "platform-skills.git");
  const work = mkdtempSync(join(scratch, "versioned-"));
  execFileSync("git", ["clone", "--quiet", bare, work]);
  const manifest = join(work, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.3.4" }, null, 2) + "\n");
  execFileSync("git", ["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "chore: version 0.3.4"], { cwd: work });
  execFileSync("git", ["fetch", "--quiet", work, "main:main"], { cwd: bare });
  expect((await request.post("/api/repos/platform-skills/sync", { headers: await csrf(request) })).status()).toBe(200);
  const task = await startTask(request, "Add a rotation note", "", "platform-skills");

  // when
  await page.goto(`/demo/tasks/${task.id}`);

  // then
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  await expect((await taskLog(page))).toContainText("Raises the plugin to version 0.3.5, so teammates fetch it once this is merged.");
  const { requestNumber } = (await taskOf(request, task.id)).task;
  const { description } = await (await request.get(`/api/repos/platform-skills/requests/${requestNumber}/description`)).json();
  expect(description).toContain("Raises the plugin to version 0.3.5");
  expect(JSON.parse(execFileSync("git", ["show", `task/${task.id}:.claude-plugin/plugin.json`], { cwd: bare, encoding: "utf8" })).version).toBe("0.3.5");
});

test("given the task form, when a person picks the template to write a new skill and names it, then the task is named after it, the stand-in writes that skill, and Run again of a failed one keeps the template", async ({ page, request }) => {
  // given
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await moreOptions(form);
  await choose(form, "Kind of task", "Write a new skill");
  await form.getByLabel("Skill name").fill("pager-notes");
  await moreOptions(form);
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", "Write the skill pager-notes");
  await chooseAgent(form);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Write the skill pager-notes");
  await expect(page.getByText("writes the skill pager-notes")).toBeVisible();
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  await expect((await taskLog(page))).toContainText("wrote skills/pager-notes/SKILL.md");

  // when a task from the template to improve a skill fails and is run again
  const { csrf: token } = await (await request.get("/api/me")).json();
  const failed = await request.post("/api/tasks", {
    data: { title: "", description: "stand-in: fail", repoId: "payments-skills", agent: "fake", template: { kind: "skill.improve", skill: "release-checklist" } },
    headers: { "x-csrf-token": token },
  });
  const failedTask = (await failed.json()).task;
  await page.goto(`/demo/tasks/${failedTask.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 30_000 });
  await page.getByRole("button", { name: "Run again" }).click();

  // then
  await expect(page).not.toHaveURL(new RegExp(`${failedTask.id}$`));
  await expect(page.getByText("improves the skill release-checklist")).toBeVisible();
  const again = (await taskOf(request, page.url().split("/").pop()!)).task as unknown as { template: unknown };
  expect(again.template).toEqual({ kind: "skill.improve", skill: "release-checklist" });
});

test("given the template to improve a skill, when the form shows the skill list, then it offers the repository's own skills", async ({ page }) => {
  // given
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await choose(form, "Repository", /^payments-skills/);
  await moreOptions(form);
  await choose(form, "Kind of task", "Improve a skill");

  // then
  await expect(form.getByRole("combobox", { name: "Skill", exact: true })).toBeEnabled();
  expect(await optionsOf(form, "Skill")).toContain("release-checklist");
  await moreOptions(form);
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", /^Improve the skill /);
});

test("given a team repository whose plugin carries a version, when an admin asks from the form to switch it to versioning by commit, then the orchestrator does it with no agent and the request says what teammates need first", async ({ page, request }) => {
  test.skip(external, "the version line is written straight into the suite's own demo repository");
  // given
  const bare = join(scratch, "demo", "repos", "platform-skills.git");
  const work = mkdtempSync(join(scratch, "switch-"));
  execFileSync("git", ["clone", "--quiet", bare, work]);
  const manifest = join(work, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.5.0" }, null, 2) + "\n");
  execFileSync("git", ["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", "chore: version 0.5.0"], { cwd: work });
  execFileSync("git", ["fetch", "--quiet", work, "main:main"], { cwd: bare });
  expect((await request.post("/api/repos/platform-skills/sync", { headers: await csrf(request) })).status()).toBe(200);
  await page.goto("/demo/tasks");
  const form = await newTaskForm(page);

  // when
  await choose(form, "Repository", /^platform-skills/);
  await moreOptions(form);
  await choose(form, "Kind of task", "Switch the plugin to versioning by commit");

  // then the form asks no agent
  await moreOptions(form);
  await expect(form.getByRole("combobox", { name: "Agent" })).toHaveCount(0);
  await expect(form).toContainText("no agent runs");
  await expect(form.getByLabel("Title")).toHaveAttribute("placeholder", "chore: switch the plugin to versioning by commit");

  // when
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect(page.getByText("refreshes the scaffold and switches to versioning by commit")).toBeVisible();
  await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
  await expect((await taskLog(page))).toContainText("no agent runs");
  const id = page.url().split("/").pop()!;
  const { requestNumber } = (await taskOf(request, id)).task;
  const { description } = await (await request.get(`/api/repos/platform-skills/requests/${requestNumber}/description`)).json();
  expect(description).toContain('This request switches the repository to versioning by commit: it takes "version": "0.5.0" out of');
  expect(description).toContain("0.31.0 or later");
  expect(description).toContain("## What the orchestrator did");
  expect(JSON.parse(execFileSync("git", ["show", `task/${id}:.claude-plugin/plugin.json`], { cwd: bare, encoding: "utf8" }))).not.toHaveProperty("version");
});

test("given a team repository whose branch rule starts with a ticket, when the task form picks it, then the issue link is asked for, and the task's branch takes the issue's key", async ({ page, request }) => {
  test.skip(external, "the branch rule is written straight into the suite's own demo repository");
  // given
  const bare = join(scratch, "demo", "repos", "platform-skills.git");
  const work = mkdtempSync(join(scratch, "keyed-"));
  execFileSync("git", ["clone", "--quiet", bare, work]);
  const teamFile = join(work, ".teamhandbook.json");
  const before = readFileSync(teamFile, "utf8");
  const commit = async (text: string, message: string) => {
    writeFileSync(teamFile, text);
    execFileSync("git", ["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-am", message], { cwd: work });
    execFileSync("git", ["fetch", "--quiet", work, "main:main"], { cwd: bare });
    expect((await request.post("/api/repos/platform-skills/sync", { headers: await csrf(request) })).status()).toBe(200);
  };
  await commit(JSON.stringify({ ...JSON.parse(before), branchExample: "PLAT-12-fix-certs" }, null, 2) + "\n", "chore: name branches by ticket");
  try {
    await page.goto("/demo/tasks");
    const form = await newTaskForm(page);

    // when
    await choose(form, "Repository", /^platform-skills/);
    await fillWork(form, "Rotate the certificates");

    // then
    await expect(form).toContainText("platform-skills names branches after a ticket (its example is PLAT-12-fix-certs); paste its issue link.");
    await expect(form.getByRole("button", { name: "Start task" })).toBeDisabled();

    // when the issue is given
    await fillWork(form, "https://tracker.example.com/browse/PLAT-77");
    await moreOptions(form);
    await form.getByLabel("Title").fill("Rotate the certificates");
    await chooseAgent(form);
    await form.getByRole("button", { name: "Start task" }).click();

    // then
    await expect(page.locator("[data-status]").first()).toHaveText("needs you", { timeout: 30_000 });
    await expect((await taskLog(page))).toContainText(/on PLAT-77-rotate-the-certificates-[0-9a-z]{6}\./);

    // and a start without an issue, past the form, is refused with the rule
    const refused = await request.post("/api/tasks", { data: { title: "No ticket", description: "", repoId: "platform-skills", agent: "fake" }, headers: await csrf(request) });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe("platform-skills names branches with a ticket first (its example is PLAT-12-fix-certs), and this task names none: start it with an issue link whose key fills it");
  } finally {
    await commit(before, "chore: name branches as before");
  }
});

test("given a failed task started with team skills, when its page opens and it runs again, then the page names the skills and the new start carries them", async ({ page, request }) => {
  // given
  const { skills } = (await (await request.get("/api/repos/payments-skills/inventory")).json()).inventory;
  const slug: string = skills[0].slug;
  const res = await request.post("/api/tasks", { data: { title: "Fail with a skill", description: "stand-in: fail", repoId: "payments-skills", agent: "fake", skills: [slug] }, headers: await csrf(request) });
  expect(res.status()).toBe(201);
  const failed: ApiTask = (await res.json()).task;
  await page.goto(`/demo/tasks/${failed.id}`);
  await expect(page.locator("[data-status]").first()).toHaveText("failed", { timeout: 60_000 });

  // then
  await expect(page.getByRole("complementary", { name: "About this task" })).toContainText(`Reads first${slug}`);

  // when
  let again: Record<string, unknown> | null = null;
  await page.route(/\/api\/tasks$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    again = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: "stopped by the test before a task starts" } });
  });
  await page.getByRole("button", { name: "Run again" }).click();

  // then
  await expect.poll(() => again).not.toBeNull();
  expect((again as { skills?: string[] } | null)?.skills).toEqual([slug]);
});
