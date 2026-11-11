import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { folderField, folderRow, openFolder } from "./folder-picker.js";
import { newTaskForm } from "./task-form.js";

// The folder picker and the first task box on one person's own orchestrator, from stand-in answers
// for the folder list and the project the server opens: two decisions, a folder and the work.

async function asLocal(page: Page): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
}

const HOME = "/Users/you";
const entry = (name: string, path: string, git: "none" | "repo" | "origin" = "none") => ({ name, path, git, markers: git === "none" ? ["package.json"] : [".git"] });

/** Settings on where one person's code lives, with its folder picker opened by Add a folder. */
async function pickerScreen(page: Page, listed: unknown[] = []): Promise<void> {
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: listed } }));
  await page.goto("/demo/settings/code");
  await page.getByRole("button", { name: "Add a folder" }).click();
}

test("given one person's limits at 10 dollars and 60 minutes, when they open Task limits from Settings and turn the time limit off, then the dollars stay, the minutes go to no limit, and the page says what a task now stops at", async ({ page }) => {
  // given
  await asLocal(page);
  let limits: { maxUsd: number | null; maxMinutes: number | null } = { maxUsd: 10, maxMinutes: 60 };
  const sent: unknown[] = [];
  await page.route((url) => url.pathname === "/api/settings/task-limits", (route) => {
    if (route.request().method() === "PUT") {
      sent.push(route.request().postDataJSON());
      limits = route.request().postDataJSON();
    }
    return route.fulfill({ json: limits });
  });

  // when
  await page.goto("/demo/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Task limits" }).click();

  // then
  await expect(page).toHaveURL(/\/demo\/settings\/task-limits$/);
  await expect(page.getByText("A task stops at whichever comes first; the task form says both before Start.")).toBeVisible();
  const form = page.getByRole("form", { name: "Task limits" });
  await expect(form.getByLabel("Most a task spends, in dollars")).toHaveValue("10");
  await expect(form.getByLabel("Longest a task runs, in minutes")).toHaveValue("60");

  // when
  await form.locator(".task-limit").nth(1).getByLabel("No limit").check();
  await form.getByRole("button", { name: "Save" }).click();

  // then
  await expect(page.getByRole("status")).toHaveText("A task now stops at $10.00; how long it runs has no limit.");
  expect(sent).toEqual([{ maxUsd: 10, maxMinutes: null }]);
  await expect(form.getByLabel("Longest a task runs, in minutes")).toBeDisabled();
});

test("given a folder whose list is slow to come, when the person steps into it, then the foot offers no Open until that list is there, and never home's", async ({ page }) => {
  // given
  await asLocal(page);
  let release!: () => void;
  const held = new Promise<void>((done) => (release = done));
  await page.route((url) => url.pathname === "/api/local/folders", async (route) => {
    const under = new URL(route.request().url()).searchParams.get("under");
    if (under !== `${HOME}/notes`) return route.fulfill({ json: { under: HOME, parent: null, folders: [entry("notes", `${HOME}/notes`)], suggestions: [], truncated: false } });
    await held;
    return route.fulfill({ json: { under, parent: HOME, folders: [entry("drafts", `${HOME}/notes/drafts`)], suggestions: [], truncated: false } });
  });
  const opened: unknown[] = [];
  await page.route((url) => url.pathname === "/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    opened.push(route.request().postDataJSON());
    return route.fulfill({ status: 400, json: { error: "stopped by the test" } });
  });
  await pickerScreen(page);
  const picker = page.getByRole("group", { name: "Pick a folder" });

  // when
  await folderRow(picker, "notes").click();

  // then
  await expect(picker.getByRole("button", { name: /^Add / })).toHaveCount(0);

  // when the list comes
  release();

  // then
  await expect(picker.getByRole("button", { name: /^Add / })).toHaveText("Add notes");
  expect(opened).toEqual([]);
});

test("given folders none of which has Git, when the picker lists them and one is picked, then no Git, branch or request word shows and the change is said to land in place", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route((url) => url.pathname === "/api/local/folders", (route) => route.fulfill({ json: { under: HOME, parent: null, folders: [entry("notes", `${HOME}/notes`), entry("shop", `${HOME}/shop`)], suggestions: [entry("shop", `${HOME}/shop`)], truncated: false } }));
  await pickerScreen(page);
  const picker = page.getByRole("group", { name: "Pick a folder" });
  await expect(picker.locator(".folder-row").first()).toBeVisible();

  // when
  await picker.locator("button.folder-row").filter({ has: page.locator(".folder-name", { hasText: /^notes$/ }) }).focus();

  // then
  await expect(picker).toContainText("in place");
  await expect(picker).not.toContainText(/\bGit\b|branch|request/);
});

test("given a pasted path from home that the server refuses, when the person presses Enter, then home is filled in and the refusal shows with the list still there", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route((url) => url.pathname === "/api/local/folders", (route) => route.fulfill({ json: { under: HOME, parent: null, folders: [entry("code", `${HOME}/code`)], suggestions: [], truncated: false } }));
  let sent: Record<string, unknown> | null = null;
  await page.route((url) => url.pathname === "/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 400, json: { error: "a hidden folder is not a project", code: "hidden" } });
  });
  await pickerScreen(page);
  const picker = page.getByRole("group", { name: "Pick a folder" });
  await expect(picker.locator(".folder-row")).toHaveCount(1);

  // when
  await folderField(picker).fill("~/.ssh");
  await folderField(picker).press("Enter");

  // then
  await expect(picker.getByRole("alert")).toHaveText("A hidden folder is not a project.");
  expect(sent).toEqual({ path: `${HOME}/.ssh` });
  await expect(picker).toBeVisible();
});

test("given a repository address, when the person clones it from the picker, then it goes under ~/code by its name, opens as a project, and a place already taken is refused with the address kept", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route((url) => url.pathname === "/api/local/folders", (route) => route.fulfill({ json: { under: HOME, parent: null, folders: [entry("code", `${HOME}/code`)], suggestions: [], truncated: false } }));
  const sent: Record<string, unknown>[] = [];
  await page.route((url) => url.pathname === "/api/projects/clone", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (!body.into) return route.fulfill({ status: 409, json: { error: `${HOME}/code/shop already exists; choose another place` } });
    return route.fulfill({ json: { existing: false, project: { id: "shop-2", name: "shop", team: "Mine", url: `${HOME}/work/shop`, kind: "code", facts: { git: "origin", origin: { forge: "github", web: "https://github.com/team/shop" }, name: "shop", kind: "code" } } } });
  });
  await pickerScreen(page);
  const picker = page.getByRole("group", { name: "Pick a folder" });
  await expect(picker.locator(".folder-row")).toHaveCount(1);

  // when
  await picker.getByRole("button", { name: "Clone from GitHub or GitLab" }).click();
  const form = page.getByRole("form", { name: "Clone a repository" });
  await form.getByLabel("Address").fill("git@github.com:team/shop.git");

  // then
  await expect(form).toContainText("into ~/code/shop");

  // when the default place is taken
  await form.getByRole("button", { name: "Clone" }).click();

  // then
  await expect(form.getByRole("alert")).toHaveText(`${HOME}/code/shop already exists; choose another place.`);
  await expect(form.getByLabel("Address")).toHaveValue("git@github.com:team/shop.git");

  // when another place is named from home
  await form.getByLabel("Place (optional)").fill("~/work/shop");
  await form.getByRole("button", { name: "Clone" }).click();

  // then
  await expect(picker).toHaveCount(0);
  expect(sent.map((b) => [b.url, b.into ?? null])).toEqual([["git@github.com:team/shop.git", null], ["git@github.com:team/shop.git", `${HOME}/work/shop`]]);
  expect(new Set(sent.map((b) => b.commandId)).size).toBe(2);
});

test("given one person's orchestrator with nothing started, when Tasks opens, then the page is the promise with one box and Start, no folder is asked, and Start sends the words with no project named", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
  await page.route((url) => url.pathname === "/api/settings/task-limits", (route) => route.fulfill({ json: { maxUsd: 10, maxMinutes: 60 } }));
  const none = { yours: 0, agents: 0, waiting: 0, done: 0 };
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ json: { sections: { yours: [], agents: [], waiting: [], done: [] }, counts: none } }));
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (body.path) return route.fulfill({ status: 400, json: { error: "stopped by the test" } });
    return route.fulfill({ status: 409, json: { error: "Which folder does this task work in? Pick one or type its path.", code: "pick-folder" } });
  });
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: [
    { path: `${HOME}/code/payments-api`, name: "payments-api", about: null, usedAt: new Date().toISOString(), from: "claude-code" },
    { path: `${HOME}/code/notes`, name: "notes", about: null, usedAt: new Date().toISOString(), from: "claude-code" },
  ] } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.request().method() === "GET" ? route.fulfill({ json: { projects: [], last: null, home: HOME } }) : route.fallback());

  // when
  await page.goto("/demo/tasks");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toContainText("any folder on this machine");
  const form = page.getByRole("form", { name: "New task" });
  await expect(form.getByLabel("What needs doing?")).toBeVisible();
  await expect(form.getByRole("group", { name: /^Repositories/ })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Pick a folder" })).toHaveCount(0);
  await expect(form).not.toContainText("Pick another folder");
  // the first task is the promise, one box and Start: no agent to pick, no kind of change, no more options, no empty queue below
  await expect(form.getByRole("combobox")).toHaveCount(0);
  await expect(form.getByRole("group", { name: "What changes" })).toHaveCount(0);
  await expect(form.getByText("More options")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your turn" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "All tasks" })).toHaveCount(0);
  // what a task stops at is said before Start, with the way to change it
  const limits = page.getByRole("complementary", { name: "Before it starts" }).getByRole("region", { name: "Limits" });
  await expect(limits).toContainText("A task stops at $10.00 or after 60 minutes, whichever comes first.");
  await expect(limits.getByRole("link", { name: "Change" })).toHaveAttribute("href", /\/settings\/task-limits$/);

  // when
  await form.getByLabel("What needs doing?").fill("Add retries to the capture call");
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty("repoId");
  expect(sent[0]).toMatchObject({ description: "Add retries to the capture call" });

  // then the orchestrator asks once which folder, with the ones Claude Code has worked in and a field for a path
  const which = form.getByRole("group", { name: "Which folder" });
  await expect(which).toContainText("Which folder does this task work in? Pick one or type its path.");
  await expect(which.getByRole("button")).toHaveText([/^payments-api\s+~\/code\/payments-api/, /^notes\s+~\/code\/notes/]);

  // when a folder is picked, the same start goes again with it
  await which.getByRole("button", { name: /^notes/ }).click();

  // then
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ description: "Add retries to the capture call", path: `${HOME}/code/notes` });

  // when a path is typed instead, with the home as a tilde
  await which.getByLabel("A folder's path").fill("~/code");
  await which.getByLabel("A folder's path").press("Enter");

  // then
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]).toMatchObject({ path: `${HOME}/code` });
});

test("given a team's orchestrator with two repositories connected, when its owner opens where the code lives, then the same two sections open in the same order, the repositories and what they declare, read only", async ({ page }) => {
  // given
  await page.route((url) => url.pathname === "/api/team/shared", (route) => route.fulfill({ json: {
    skills: [{ name: "release-notes", slug: "release-notes", repoName: "payments-skills", tasks: null }],
    mcpServers: [{ name: "docs", repoName: "payments-skills", tasks: null }],
  } }));

  await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [{ id: "payments-api", team: "Payments", name: "payments-api", url: "https://git.example.invalid/payments-api.git", head: null, syncedAt: null, error: null, kind: "code" }] } }) : route.fallback()));

  // when
  await page.goto("/demo/settings/code");

  // then
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Where your code lives");
  const sections = page.locator("main section.section h2");
  await expect(sections).toHaveText(["Repositories tasks work in", "Skills and MCP servers for tasks"]);
  await expect(page.getByRole("region", { name: "Repositories tasks work in" }).getByRole("link", { name: "Repository settings" }).first()).toHaveAttribute("href", /\/demo\/repositories\/[^/]+$/);
  const tools = page.getByRole("region", { name: "Skills and MCP servers for tasks" });
  await expect(tools).toContainText("They change through a request to the repository that declares them.");
  await expect(tools.getByRole("listitem")).toHaveText([/^release-notes\s+skill, payments-skills/, /^docs\s+MCP server, payments-skills/]);
  await expect(tools.getByRole("checkbox")).toHaveCount(0);
});

test("given a folder whose code holds a TODO and names its tests, when the first screen opens, then Or start with offers them as rows, a row fills the box in full and Start stays the person's", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ json: { sections: { yours: [], agents: [], waiting: [], done: [] }, counts: { yours: 0, agents: 0, waiting: 0, done: 0 } } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.request().method() === "GET" ? route.fulfill({ json: { projects: [{ id: "code", name: "code", team: "Mine", url: `file://${HOME}/code`, kind: "code", facts: null }], last: "code", home: HOME } }) : route.fallback());
  await page.route("**/api/work/starters?*", (route) => route.fulfill({ json: { starters: [
    { kind: "todo", title: "Resolve the TODO in src/cart.ts:2", description: "Quoted from the file:\n> TODO: round the total", where: "src/cart.ts:2" },
    { kind: "tests", title: "Run the tests and fix the first one that fails", description: "Run npm test and fix the first failing test.", where: "package.json" },
  ] } }));
  let started = false;
  await page.route("**/api/tasks", (route) => (route.request().method() === "POST" ? ((started = true), route.fulfill({ status: 400, json: { error: "stopped by the test" } })) : route.fallback()));

  // when
  await page.goto("/demo/tasks");
  const form = page.getByRole("form", { name: "New task" });
  const rows = form.getByRole("list", { name: "Or start with" }).getByRole("button");

  // then
  await expect(rows).toHaveCount(2);

  // when
  await rows.first().click();

  // then
  await expect(form.getByLabel("What needs doing?")).toHaveValue("Resolve the TODO in src/cart.ts:2\n\nQuoted from the file:\n> TODO: round the total");
  await expect(form.getByRole("list", { name: "Or start with" })).toHaveCount(0);
  expect(started).toBe(false);
});

test("given an issue link whose preview has no title, when it is started alone and then with a note, then the start carries the link and the note, never says to say what needs doing, and the folder question is the only thing that can stop it", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ json: { sections: { yours: [], agents: [], waiting: [], done: [] }, counts: { yours: 0, agents: 0, waiting: 0, done: 0 } } }));
  await page.route((url) => url.pathname === "/api/issues/preview", (route) => route.fulfill({ json: { url: "https://acme.atlassian.example/browse/PAY-239", key: "PAY-239", title: null, status: null, reach: "The agent reads the issue through atlassian as you." } }));
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: [{ path: `${HOME}/code`, name: "code", about: null, usedAt: new Date().toISOString(), from: "claude-code" }] } }));
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 409, json: { error: "Which folder does this task work in? Pick one or type its path.", code: "pick-folder" } });
  });
  await page.goto("/demo/tasks");
  const form = page.getByRole("form", { name: "New task" });
  const link = "https://acme.atlassian.example/browse/PAY-239";

  // when the link is started alone
  await form.getByLabel("What needs doing?").fill(link);
  await form.getByRole("button", { name: "Start task" }).click();

  // then it goes with the link and no words of its own, and what stops it is the question of which folder
  await expect(form.getByRole("group", { name: "Which folder" })).toBeVisible();
  expect(sent[0]).toMatchObject({ title: "", description: "", issueUrl: link });
  await expect(form.getByRole("alert")).toHaveCount(0);

  // when a note is written beside the link
  await form.getByLabel("What needs doing?").fill(`${link} Implement what the ticket describes.`);
  await form.getByRole("button", { name: "Start task" }).click();

  // then
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ title: "Implement what the ticket describes.", description: "Implement what the ticket describes.", issueUrl: link });
  await expect(page.getByText("Say what needs doing.")).toHaveCount(0);
});

test("given an issue nothing reads, when the person starts on its link, then the preview offers to sign in to the tracker, the refusal says the agent sees only the link, and Start on the link alone sends it without the issue text", async ({ page }) => {
  // given
  await asLocal(page);
  await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
  await page.route((url) => url.pathname === "/api/tasks/board", (route) => route.fulfill({ json: { sections: { yours: [], agents: [], waiting: [], done: [] }, counts: { yours: 0, agents: 0, waiting: 0, done: 0 } } }));
  await page.route((url) => url.pathname === "/api/issues/preview", (route) => route.fulfill({ json: { url: "https://acme.atlassian.example/browse/PAY-239", key: "PAY-239", title: null, status: null, reach: "The agent sees only the link; connect the issue tracker.", connect: { id: "jira", name: "Atlassian" } } }));
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/tasks", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    if (body.withoutIssueText) return route.fulfill({ status: 400, json: { error: "stopped by the test" } });
    return route.fulfill({ status: 409, json: { error: "The agent sees only the link; connect the issue tracker, or start on the link alone.", code: "issue-unread" } });
  });
  await page.goto("/demo/tasks");
  const form = page.getByRole("form", { name: "New task" });

  // when
  await form.getByLabel("What needs doing?").fill("https://acme.atlassian.example/browse/PAY-239");

  // then the preview already offers the one-step sign-in
  await expect(form.getByRole("button", { name: "Sign in with Atlassian" })).toBeVisible();

  // when it is started anyway
  await form.getByRole("button", { name: "Start task" }).click();

  // then the refusal is a card with both ways forward
  const card = form.getByRole("group", { name: "The issue is not read" });
  await expect(card).toContainText("The agent sees only the link");
  await expect(card.getByRole("button", { name: "Sign in with Atlassian" })).toBeVisible();
  expect(sent[0]).not.toHaveProperty("withoutIssueText");

  // when
  await card.getByRole("button", { name: "Start on the link alone" }).click();

  // then
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toMatchObject({ issueUrl: "https://acme.atlassian.example/browse/PAY-239", withoutIssueText: true });
});

test("given the newest task found two MCP servers that need sign-in, when the task form opens, then it says so before Start, and a newest task with none says nothing", async ({ page }) => {
  // given
  await asLocal(page);
  const at = new Date().toISOString();
  const record = (needs: string[]) => ({ id: "t9", title: "Earlier work", status: "failed", phase: "failed", repoId: "code", team: "Mine", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: at, startedAt: at, finishedAt: at, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null, mcpNeedsSignIn: needs });
  let needs = ["gitlab", "notion"];
  await page.route((url) => url.pathname === "/api/tasks", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { tasks: [record(needs)], next: null } }) : route.fallback()));

  // when
  await page.goto("/demo/tasks");
  await newTaskForm(page);

  // then
  const form = page.getByRole("form", { name: "New task" });
  const signIn = form.getByRole("note").filter({ hasText: "sign-in" });
  await expect(signIn.locator("summary")).toHaveText("2 MCP servers need sign-in");
  await signIn.locator("summary").click();
  await expect(signIn).toContainText("GitLab, Notion.");

  // when
  needs = [];
  await page.reload();
  await newTaskForm(page);

  // then
  await expect(page.getByRole("form", { name: "New task" })).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "need sign-in" })).toHaveCount(0);
});

test("given Settings on where one person's code lives, when a path is typed into Add a folder and Enter is pressed, then the folder is added to the list and the picker closes", async ({ page }) => {
  // given
  await asLocal(page);
  const added: string[] = [];
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: added.map((path) => ({ path, name: path.split("/").pop(), about: null, usedAt: new Date().toISOString(), from: "added" })) } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { projects: [], last: null, home: HOME } });
    added.push(`${HOME}/code`);
    return route.fulfill({ json: { existing: false, project: { id: "code", name: "code", team: "Mine", url: `${HOME}/code`, kind: "code", facts: { git: "none", origin: null, name: "code", kind: "code" } } } });
  });
  await page.route((url) => url.pathname === "/api/local/folders", (route) => route.fulfill({ json: { under: HOME, parent: null, folders: [entry("code", `${HOME}/code`)], suggestions: [], truncated: false } }));
  await page.goto("/demo/settings/code");
  await page.getByRole("button", { name: "Add a folder" }).click();

  const picker = page.getByRole("group", { name: "Pick a folder" });

  // when
  await folderField(picker).fill("~/code");

  // then
  await expect(picker.getByText("Enter adds it")).toBeVisible();

  // when
  await folderField(picker).press("Enter");

  // then
  await expect(page.getByRole("group", { name: "Pick a folder" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Folders tasks work in" }).getByRole("listitem")).toHaveText([/^code\s+~\/code/]);
});

test("given folders Claude Code has worked in, when Settings opens on where one person's code lives, then they are listed most recent first by name and path, and Add a folder brings the picker", async ({ page }) => {
  // given
  await asLocal(page);
  const at = new Date().toISOString();
  await page.route((url) => url.pathname === "/api/work-folders", (route) => route.fulfill({ json: { folders: [
    { path: `${HOME}/code/payments-api`, name: "payments-api", about: "Payments API", usedAt: at, from: "claude-code" },
    { path: `${HOME}/code/notes`, name: "notes", about: null, usedAt: at, from: "claude-md" },
  ] } }));
  await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [], last: null, home: HOME } }));
  await page.route((url) => url.pathname === "/api/local/folders", (route) => route.fulfill({ json: { under: HOME, parent: null, folders: [entry("code", `${HOME}/code`)], suggestions: [], truncated: false } }));

  // when
  await page.goto("/demo/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: "Where your code lives" }).click();

  // then
  const list = page.getByRole("region", { name: "Folders tasks work in" });
  await expect(list.getByRole("listitem")).toHaveText([/^payments-api\s+~\/code\/payments-api/, /^notes\s+~\/code\/notes/]);
  await expect(list.getByRole("link")).toHaveCount(0);
  await expect(page.locator("main section.section h2")).toHaveText(["Folders tasks work in", "Skills and MCP servers for tasks"]);

  // when
  await list.getByRole("button", { name: "Add a folder" }).click();

  // then
  await expect(page.getByRole("group", { name: "Pick a folder" })).toBeVisible();
});
