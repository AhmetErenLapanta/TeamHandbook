import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { overflows, THEMES } from "./layout.js";
import { standInWork } from "./work-fixtures.js";

// Screenshots of the main screens, when a run is asked for them, so a change to the look can be
// compared before and after in both themes at a phone's, a tablet's and a desktop's width.
const SHOTS = process.env.ORCHESTRATOR_DESIGN_SHOTS;
const WIDTHS = [1440, 768, 390] as const;

interface Screen { name: string; open: (page: Page) => Promise<void> }

async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/^Loading|^Working out|^Reading the forge|^Reading what reaches|^Checking the agents/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
}

/** The suite's orchestrator runs self-hosted; the welcome only shows to an orchestrator told it runs locally or in the cloud. */
async function inMode(page: Page, mode: "local" | "cloud"): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode, runners: mode === "cloud" } } });
  });
  if (mode === "cloud") {
    const unset = { connection: null, available: true, missing: [] };
    await page.route("**/api/forge/*/connection", (route) => route.fulfill({ json: unset }));
  }
}

/** A finished task read back as another state, with what the agent asked: the task page's other faces. */
async function taskAs(page: Page, change: Record<string, unknown>, log?: Record<string, unknown>[]): Promise<void> {
  const { csrf } = await (await page.request.get("/api/me")).json();
  const { task } = await (await page.request.post("/api/tasks", { data: { title: "Add a retry to the payments webhook", description: "Design.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json();
  await page.route(`**/api/tasks/${task.id}/events*`, (route) => route.fulfill({ status: 204 }));
  await page.route(`**/api/tasks/${task.id}?*`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    // A stand-in log is the page's first read only; a later read asks for what came after it, and there is none.
    const after = Number(new URL(route.request().url()).searchParams.get("after") ?? "0");
    await route.fulfill({ response: res, json: { ...body, task: { ...body.task, state: undefined, ...change }, ...(log ? { log: after ? [] : log, outputCut: false } : {}) } });
  });
  await page.goto(`/demo/tasks/${task.id}`);
}

/** The folders tasks work in on a Personal orchestrator, as its own Claude Code names them. */
async function workFolders(page: Page): Promise<void> {
  await page.route(/\/api\/work-folders$/, (route) => route.fulfill({ json: { folders: [
    { path: "/home/ada/code/payments-api", name: "payments-api", about: "Payments API", usedAt: new Date(Date.now() - 3_600_000).toISOString() },
    { path: "/home/ada/code/site", name: "site", about: null, usedAt: new Date(Date.now() - 86_400_000).toISOString() },
  ] } }));
}

/** A run as the live task draws it: the plan, the agent's words, reads joined, an edit and a failed test. */
const LIVE = (() => {
  const at = new Date().toISOString();
  let n = 0;
  const line = (data: Record<string, unknown>) => ({ seq: ++n, at, text: "masked", kind: data.type, data });
  return [
    line({ type: "todos", items: [{ text: "Read the webhook code", state: "done" }, { text: "Write the runbook entry", state: "doing" }, { text: "Run the webhook tests", state: "todo" }] }),
    line({ type: "message", text: "The retries live in `deliver.ts`; I will write them up for whoever is on call:\n\n- five attempts, **backing off** each time\n- the failed queue after that\n\n```\nnpm test -- webhooks --reporter=verbose --testNamePattern=\"retries five times before the failed queue\"\n```" }),
    line({ type: "steer", text: "Leave the failed queue as it is; only the retries change.", by: null }),
    line({ type: "tool_call", id: "a", tool: "Read", target: "src/webhooks/deliver.ts", status: "started" }),
    line({ type: "tool_call", id: "b", tool: "Read", target: "src/webhooks/retry.ts", status: "started" }),
    line({ type: "tool_call", id: "c", tool: "Edit", target: "runbooks/failed-webhooks.md", status: "started" }),
    line({ type: "edit", id: "c", path: "runbooks/failed-webhooks.md", additions: 9, deletions: 2, patch: "@@ -38,3 +38,4 @@\n-Retries: none. Each event is tried once.\n+Each event is tried five times before it lands there.\n+A provider outage shorter than that clears itself." }),
    line({ type: "tool_call", id: "d", tool: "Bash", target: null, command: "npm test -- webhooks", status: "started" }),
    line({ type: "tool_output", id: "d", lines: [...Array.from({ length: 58 }, (_, i) => `ok ${i + 1} - webhooks retry case ${i + 1}`), "1 failing", "retry.test.ts: expected 5 attempts, got 1"] }),
    line({ type: "tool_call", id: "d", tool: "Bash", status: "failed" }),
    line({ type: "tool_call", id: "e", tool: "mcp__tracker__addComment", target: "PAY-412", status: "refused", refusal: { kind: "tracker-write", reason: "Writing to the tracker is off for every task", repeats: 1 } }),
    line({ type: "tool_call", id: "f", tool: "mcp__tracker__addComment", target: "PAY-412", status: "refused", refusal: { kind: "tracker-write", reason: "Writing to the tracker is off for every task", repeats: 2 } }),
    line({ type: "tool_call", id: "g", tool: "Read", target: "src/webhooks/schedule.ts", status: "started" }),
    line({ type: "usage", cost: { usd: 0.41, inputTokens: null, outputTokens: null } }),
  ];
})();

/** A review in a folder without Git: a long path, a large file, a binary one, a deletion and a file kept no copy of. */
const IN_PLACE = (() => {
  const file = (path: string, status: string, additions: number | null, deletions: number | null, binary = false) => ({ path, status, previousPath: null, additions, deletions, binary, test: false });
  const runbook = file("runbooks/failed-webhooks.md", "modified", 9, 2);
  const windows = file("src/webhooks/retry/schedules/provider-outage-windows-for-the-payments-provider.ts", "added", 64, 0);
  const diagram = file("runbooks/diagrams/retry-flow.png", "added", null, null, true);
  const notes = file("runbooks/old-retry-notes.md", "deleted", 0, 12);
  const files = [runbook, windows, diagram, notes];
  const patches: Record<string, string> = {
    [runbook.path]: "@@ -38,3 +38,4 @@\n Failed webhooks land in the failed queue.\n-Retries: none. Each event is tried once.\n+Each event is tried five times before it lands there.\n+A provider outage shorter than that clears itself.",
    [windows.path]: `@@ -0,0 +1,64 @@\n${Array.from({ length: 64 }, (_, i) => `+export const WINDOW_${i + 1} = { startsAfterMinutes: ${i * 15}, lastsMinutes: 15, provider: "payments" };`).join("\n")}`,
    [notes.path]: `@@ -1,12 +0,0 @@\n${Array.from({ length: 12 }, (_, i) => `-Old note ${i + 1}: retried by hand from the provider's dashboard.`).join("\n")}`,
  };
  return { files, patches, untracked: [{ path: ".env.payments", status: "modified" }] };
})();

const ASKED = [
  { id: "r1", kind: "command", payload: { tool: "Bash", summary: "npm test -- --run webhook.retry" }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: "2026-11-03T09:00:00.000Z" },
  { id: "r2", kind: "file-change", payload: { tool: "Edit", summary: "skills/webhook-retry/SKILL.md" }, status: "answered", responseCapability: "live", answer: { decision: "allow_for_task" }, answeredBy: "ada@example.invalid", createdAt: "2026-11-03T08:59:00.000Z" },
];

const QUESTIONED = [
  { id: "q1", kind: "question", payload: { questions: [
    { key: "retry", title: "How often should the webhook retry?", description: "The payments provider resends for a day on its own.", choice: "one", options: [
      { value: "3", label: "Three times", description: "Then the event waits for a person in the failed queue." },
      { value: "5", label: "Five times, backing off", description: "One minute, then five, fifteen, an hour and four hours, which covers most provider outages without anyone stepping in." },
    ] },
    { key: "notify", title: "Who hears about a failure?", choice: "many", other: true, options: [
      { value: "oncall", label: "The on-call engineer" },
      { value: "channel", label: "The payments channel" },
    ] },
  ] }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: "2026-11-03T09:00:00.000Z" },
];

const MACHINES = { machines: [
  { id: "m1", name: "ada-laptop", platform: "macOS", runnerVersion: "1.4.0", lastSeenAt: "2026-11-03T09:00:00.000Z", online: true, paused: false, local: false, agents: [
    { id: "claude-code", label: "Claude Code", installed: true, version: "2.1.0", supported: "ok", signIn: "signed-in", signInCommand: null },
    { id: "opencode", label: "OpenCode", installed: true, version: "0.9.2", supported: "ok", signIn: "signed-out", signInCommand: "opencode auth login" },
  ] },
] };

/** A team's orchestrator whose tasks run on people's own computers, before this one is connected. */
async function onTheirComputers(page: Page, connected: boolean): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud", runners: true, tasksRunHere: false } } });
  });
  await page.route("**/api/forge/*/connection", (route) => route.fulfill({ json: { connection: null, available: true, missing: [] } }));
  await page.route("**/api/machines/pair", (route) => route.fulfill({ json: { code: "K7Q-42M", expiresAt: new Date(Date.now() + 600_000).toISOString(), command: "npx teamhandbook-orchestrator connect https://orchestrator.example.invalid K7Q-42M" } }));
  await page.route("**/api/machines", (route) => route.fulfill({ json: connected ? MACHINES : { machines: [] } }));
  await page.route(/\/api\/projects$/, (route) => route.fulfill({ json: { projects: [], last: null } }));
  await page.route(/\/api\/(local|machines\/[^/]+)\/folders/, (route) => route.fulfill({ json: { under: "/home/ada", parent: null, truncated: false, suggestions: [{ name: "payments-api", path: "/home/ada/code/payments-api", git: "origin", markers: [] }], folders: [{ name: "code", path: "/home/ada/code", git: "none", markers: [] }] } }));
}

const SCREENS: Screen[] = [
  { name: "connect-computer", open: async (p) => { await onTheirComputers(p, false); await p.goto("/demo/welcome"); await expect(p.getByText("Waiting for this computer…")).toBeVisible(); } },
  { name: "connect-computer-done", open: async (p) => { await onTheirComputers(p, true); await p.goto("/demo/welcome"); await expect(p.locator(".folder-picker")).toBeVisible({ timeout: 15_000 }); } },
  { name: "project-settings", open: (p) => p.goto("/demo/repositories/payments-skills/settings").then(() => undefined) },
  { name: "folder-project", open: async (p) => {
    await inMode(p, "local");
    const { repos } = await (await p.request.get("/api/repos")).json();
    const folder = { ...repos[0], id: "on-call-notes", name: "on-call-notes", source: "local", kind: "code", url: "file:///home/ada/code/on-call-notes", facts: { git: "none", origin: null, name: "on-call-notes", kind: "code" } };
    await p.route(/\/api\/repos$/, (route) => route.request().method() === "GET" ? route.fulfill({ json: { repos: [folder] } }) : route.fallback());
    await p.route(/\/api\/projects$/, (route) => route.fulfill({ json: { projects: [folder], last: folder.id, home: "/home/ada" } }));
    await p.goto("/demo/repositories/on-call-notes");
    await expect(p.getByRole("heading", { name: "Project" })).toBeVisible();
  } },
  { name: "activity", open: (p) => p.goto("/demo/activity/usage").then(() => undefined) },
  { name: "welcome-local", open: async (p) => {
    await inMode(p, "local");
    // A made-up home, so the first screen is drawn with its folders rather than a refused read.
    const home = "/home/ada";
    const entry = (name: string, git: "none" | "repo" | "origin") => ({ name, path: `${home}/code/${name}`, git, markers: [] });
    await p.route(/\/api\/local\/folders/, (route) => route.fulfill({ json: { under: home, parent: null, truncated: false, suggestions: [entry("payments-api", "origin")], folders: [{ name: "code", path: `${home}/code`, git: "none", markers: [] }, { name: "notes", path: `${home}/notes`, git: "none", markers: [] }] } }));
    await p.goto("/demo/welcome");
    await expect(p.locator(".folder-row").first()).toBeVisible();
  } },
  { name: "first-task", open: async (p) => {
    await inMode(p, "local");
    const shop = { id: "shop", name: "shop", team: "Mine", url: "file:///home/ada/code/shop", kind: "code", facts: { git: "none", origin: null, name: "shop", kind: "code" } };
    await p.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
    await p.route(/\/api\/projects$/, (route) => route.fulfill({ json: { projects: [shop], last: "shop", home: "/home/ada" } }));
    await p.route("**/api/work/starters?*", (route) => route.fulfill({ json: { starters: [
      { kind: "todo", title: "Resolve the TODO in src/cart.ts:2", description: "Quoted from the file:\n> TODO: round the total", where: "src/cart.ts:2" },
      { kind: "tests", title: "Run the tests and fix the first one that fails", description: "Run npm test and fix the first failing test.", where: "package.json" },
    ] } }));
    await workFolders(p);
    await p.route(/\/api\/tasks(\?|$)/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { tasks: [], next: null } }) : route.fallback()));
    await p.route(/\/api\/tasks\/board(\?|$)/, (route) => route.fulfill({ json: { sections: { yours: [], agents: [], waiting: [], done: [] }, counts: { yours: 0, agents: 0, waiting: 0, done: 0 } } }));
    await p.goto("/demo/tasks");
    await expect(p.getByLabel("What needs doing?")).toBeVisible();
    await expect(p.getByRole("list", { name: "Or start with" })).toBeVisible();
  } },
  { name: "welcome-cloud", open: async (p) => { await inMode(p, "cloud"); await p.goto("/demo/welcome"); } },
  { name: "tasks", open: (p) => p.goto("/demo/tasks").then(() => undefined) },
  { name: "task", open: async (p) => {
    const { csrf } = await (await p.request.get("/api/me")).json();
    const { task } = await (await p.request.post("/api/tasks", { data: { title: "Add a retry to the payments webhook", description: "Design.", repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json();
    await p.goto(`/demo/tasks/${task.id}`);
    await expect(p.locator("[data-status]").first()).toHaveText(/needs you|failed/, { timeout: 60_000 });
  } },
  { name: "task-asks", open: async (p) => {
    await taskAs(p, { status: "running", requests: ASKED });
    await expect(p.getByRole("button", { name: "Allow once" })).toBeVisible();
  } },
  { name: "task-question", open: async (p) => {
    await taskAs(p, { status: "running", requests: QUESTIONED });
    await expect(p.getByText("How often should the webhook retry?")).toBeVisible();
  } },
  { name: "task-live", open: async (p) => {
    await taskAs(p, { status: "running", requests: [], queuePosition: null, followUp: "steer", startedAt: new Date(Date.now() - 86_000).toISOString(), messages: [{ id: "m1", text: "Name the provider's outage windows in the runbook too.", quotes: null, createdAt: new Date().toISOString() }, { id: "m2", text: "Keep it short.", quotes: [{ path: "runbooks/failed-webhooks.md", lines: "38-40", text: "Each event is tried five times" }], createdAt: new Date().toISOString() }] }, LIVE);
    await expect(p.getByRole("region", { name: "Messages waiting for the agent" })).toBeVisible();
    await expect(p.getByRole("region", { name: "The agent at work" }).getByRole("list", { name: "What the agent did" })).toBeVisible();
    await expect(p.locator("form.run-steer")).toBeVisible();
    await p.locator(".run-line[data-kind='tool']").filter({ hasText: "npm test" }).locator("summary").click();
    await p.evaluate(() => window.scrollTo(0, 0));
  } },
  { name: "task-in-place", open: async (p) => {
    await p.route(/\/api\/projects$/, async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({ json: { ...body, projects: body.projects.map((x: { facts?: Record<string, unknown> }) => ({ ...x, facts: { ...x.facts, git: "none", origin: null } })) } });
    });
    await p.route(/\/api\/tasks\/[^/]+\/changes(\/|\?|$)/, (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname.split("/changes")[1]?.slice(1) ?? "");
      if (!path) return route.fulfill({ json: { changes: { files: IN_PLACE.files, omitted: 0, untracked: IN_PLACE.untracked } } });
      return route.fulfill({ json: { file: { patch: IN_PLACE.patches[path] ?? null, truncated: false, note: null } } });
    });
    await taskAs(p, { status: "needs-review", result: "changes", queuePosition: null, requestNumber: null, request: null, requests: [], changes: { files: IN_PLACE.files, undone: null, kept: null } });
    await expect(p.getByRole("button", { name: "Keep these changes" })).toBeVisible();
    await expect(p.getByText("runbooks/old-retry-notes.md")).toBeVisible();
  } },
  { name: "task-on-branch", open: async (p) => {
    const kept = (path: string, reason: string) => ({ repoId: `payments-skills--${path}`, name: path, status: "local", reason, tests: null, error: null, request: null, path, branch: "task/add-retry" });
    await taskAs(p, { status: "needs-review", queuePosition: null, requestNumber: null, request: null, requests: [], runner: "local", ranOn: "ada-laptop", targets: [kept("delivery-service", "no-remote"), kept("payments-api", "unpushed"), kept("ledger", "not-connected")] });
    await expect(p.getByRole("button", { name: "Copy the command" }).first()).toBeVisible();
  } },
  { name: "task-forge-reach", open: async (p) => {
    await inMode(p, "local");
    const on: Record<string, { forge: string | null; url: string | null; number: number | null }> = {
      "payments-api": { forge: "gitlab", url: null, number: null },
      "payments-worker": { forge: "github", url: "https://github.example.invalid/team/payments-worker/pull/12", number: 12 },
      notes: { forge: null, url: null, number: null },
    };
    const asked = (path: string, number: number) => ({ repoId: `payments-skills--${path}`, name: path, status: "request", reason: `changed by the agent in ${path}`, path, branch: "task/add-retry", tests: null, error: null, request: { number, url: `local://requests/${number}`, status: "open" } });
    await p.route(/\/api\/repos\/payments-skills--[^/]+\/requests\/\d+\/on-forge$/, (route) => route.fulfill({ json: on[route.request().url().split("--")[1]!.split("/")[0]!] }));
    await p.route(/\/api\/repos\/payments-skills--[^/]+\/requests\/\d+\/changes/, (route) => route.request().url().endsWith("/changes")
      ? route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [{ path: "runbooks/failed-webhooks.md", status: "modified", previousPath: null, additions: 2, deletions: 1, binary: false, test: false }] } } })
      : route.fulfill({ json: { file: { patch: "@@ -38,2 +38,3 @@\n Failed webhooks land in the failed queue.\n-Retries: none.\n+Each event is tried five times.\n+A short outage clears itself.", truncated: false, note: null } } }));
    await taskAs(p, { status: "needs-review", queuePosition: null, requestNumber: null, request: null, requests: [], targets: [asked("payments-api", 1), asked("payments-worker", 2), asked("notes", 3)] });
    await expect(p.getByRole("button", { name: "Open a merge request" })).toBeVisible();
  } },
  { name: "task-local-git", open: async (p) => {
    await inMode(p, "local");
    await p.route(/\/api\/repos\/payments-skills\/requests\/3\/on-forge$/, (route) => route.fulfill({ json: { forge: "gitlab", url: null, number: null } }));
    await p.route(/\/api\/repos\/payments-skills\/requests\/3\/changes/, (route) => route.request().url().endsWith("/changes")
      ? route.fulfill({ json: { changes: { base: "a", head: "b", omitted: 0, files: [{ path: "runbooks/failed-webhooks.md", status: "modified", previousPath: null, additions: 2, deletions: 1, binary: false, test: false }] } } })
      : route.fulfill({ json: { file: { patch: "@@ -38,2 +38,3 @@\n Failed webhooks land in the failed queue.\n-Retries: none.\n+Each event is tried five times.\n+A short outage clears itself.", truncated: false, note: null } } }));
    await taskAs(p, { status: "needs-review", queuePosition: null, requestNumber: 3, request: { status: "open", provider: "local", branch: "task/add-retry", url: "local://requests/3" }, requests: [], targets: null, startedAt: new Date(Date.now() - 300_000).toISOString(), finishedAt: new Date(Date.now() - 214_000).toISOString(), cost: { usd: 0.41, inputTokens: 52_100, outputTokens: 1_840 }, context: { tokens: 48_213 }, loaded: { commands: 4, plugins: 2, mcpServers: 3, claudeMd: true } });
    await expect(p.getByRole("button", { name: "Keep these changes" })).toBeVisible();
  } },
  { name: "task-live-personal", open: async (p) => {
    await inMode(p, "local");
    await workFolders(p);
    await p.route(/\/api\/projects$/, async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), home: "/home/ada" } }));
    await taskAs(p, { status: "running", requests: [], queuePosition: null, followUp: "steer", startedAt: new Date(Date.now() - 86_000).toISOString(), routing: { path: "/home/ada/code/payments-api", reason: "stand-in", fallback: false } }, LIVE);
    await expect(p.getByText(/Working in/)).toBeVisible();
  } },
  { name: "task-stuck", open: async (p) => {
    await taskAs(p, { status: "failed", queuePosition: null, requestNumber: null, request: null, requests: [], question: { text: "I could not read PAY-412: reading the tracker is off for this task. Allow tracker reads, or paste the issue's text.", options: ["Allow tracker reads for this task", "Paste the issue text"] } }, LIVE);
    await expect(p.getByText("Paste the issue text")).toBeVisible();
  } },
  { name: "task-plan", open: async (p) => {
    const plan = "I read the webhook code; this is how I would add the retry:\n\n1. Add a backoff schedule to `deliver.ts`.\n2. Retry five times before the failed queue.\n3. Write the runbook entry.\n4. Add a test for each attempt.\n5. Run the webhook tests.";
    await taskAs(p, { status: "running", queuePosition: null, followUp: "steer", startedAt: new Date(Date.now() - 40_000).toISOString(), requests: [{ id: "p1", kind: "plan", payload: { plan }, status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: new Date().toISOString() }] });
    await expect(p.getByRole("button", { name: "Start with this plan" })).toBeVisible();
  } },
  { name: "task-limit", open: async (p) => {
    await taskAs(p, { status: "queued", queuePosition: null, requests: [], waitingFor: "limit", resetAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }, LIVE);
    await expect(p.getByText(/usage limit is reached/)).toBeVisible();
  } },
  { name: "task-failed", open: async (p) => {
    const started = new Date(Date.now() - 300_000).toISOString();
    await taskAs(p, { status: "failed", queuePosition: null, requestNumber: null, request: null, requests: [], startedAt: started, finishedAt: new Date(Date.now() - 214_000).toISOString(), error: "Claude Code exited with code 1 while it was running the webhook tests." }, LIVE);
    await expect(p.locator("[data-status]").first()).toHaveText("failed");
  } },
  { name: "task-interrupted", open: async (p) => {
    await taskAs(p, { status: "interrupted", requests: [] });
    await expect(p.getByRole("button", { name: "Pick up where it stopped" })).toBeVisible();
  } },
  { name: "machines", open: async (p) => {
    await inMode(p, "cloud");
    await p.route("**/api/machines", (route) => route.fulfill({ json: MACHINES }));
    await p.goto("/demo/settings/machines");
    await expect(p.getByText("ada-laptop").first()).toBeVisible();
  } },
  { name: "tasks of one repository", open: (p) => p.goto("/demo/tasks?repo=payments-skills").then(() => undefined) },
  { name: "repository", open: (p) => p.goto("/demo/repositories/payments-skills").then(() => undefined) },
  { name: "requests", open: (p) => p.goto("/demo/repositories/requests").then(() => undefined) },
  { name: "controls", open: (p) => p.goto("/demo/team").then(() => undefined) },
  { name: "team-personal", open: async (p) => { await inMode(p, "local"); await p.goto("/demo/team"); } },
  { name: "team-plugin", open: async (p) => {
    await inMode(p, "local");
    await p.route("**/api/tasks/options", async (route) => {
      const body = await (await route.fetch()).json();
      const personal = { commands: [], plugins: [], mcpServers: [], claudeMd: false, readAt: new Date().toISOString() };
      await route.fulfill({ json: { ...body, agents: [...body.agents.filter((a: { id: string }) => a.id !== "claude-code"), { id: "claude-code", label: "Claude Code", readiness: { ready: true, state: "ready" }, personal }] } });
    });
    await p.goto("/demo/team");
    await p.locator(".plugin-card").getByRole("button", { name: "Install the plugin…" }).click();
    await expect(p.locator(".plugin-card").getByRole("button", { name: "Install", exact: true })).toBeVisible();
  } },
  { name: "team-personal-alone", open: async (p) => {
    await inMode(p, "local");
    await p.route(/\/api\/(orgs\/demo\/)?repos$/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const body = await (await route.fetch()).json();
      await route.fulfill({ json: { ...body, repos: body.repos.filter((r: { kind?: string }) => r.kind !== "skills") } });
    });
    await p.goto("/demo/team");
    await expect(p.getByRole("button", { name: "Share with a team" })).toBeVisible();
  } },
  { name: "integrations", open: (p) => p.goto("/demo/integrations").then(() => undefined) },
  ...["members", "service-accounts", "api-keys", "access", "task-secrets", "agents", "security", "privacy", "organization", "account"].map((id) => ({
    name: `settings-${id}`, open: (p: Page) => p.goto(`/demo/settings/${id}`).then(() => undefined),
  })),
  { name: "settings-code", open: async (p) => {
    await inMode(p, "local");
    await p.route(/\/api\/projects$/, async (route) => {
      const body = await (await route.fetch()).json();
      const folder = { ...body.projects[0], name: "code", url: "file:///home/ada/code", facts: { ...body.projects[0].facts, git: "none", origin: null } };
      await route.fulfill({ json: { ...body, projects: [folder], home: "/home/ada" } });
    });
    await p.route(/\/api\/projects\/[^/]+\/repositories$/, (route) => route.fulfill({ json: { repositories: ["payments-api", "payments-worker", "infra/terraform-payments"].map((path) => ({ path, name: path.split("/").at(-1) })) } }));
    await workFolders(p);
    await p.goto("/demo/settings/code");
    await expect(p.getByRole("heading", { name: "Folders tasks work in" })).toBeVisible();
  } },
  // Last: the stand-in tracker it needs stays answering for the rest of the page's life.
  { name: "work", open: async (p) => { await standInWork(p); await p.goto("/demo/work"); } },
];

/** The names of the shown, enabled buttons on the page filled with the accent: the screen's main actions. */
async function mainActions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return [...document.querySelectorAll<HTMLElement>("main button:not(:disabled), main a.button")]
      .filter((el) => el.checkVisibility() && getComputedStyle(el).backgroundColor === accent)
      .map((el) => el.innerText.trim());
  });
}

/** Each text colour a screen sets on each background it sets it on, as the design tokens name them. */
const PAIRS: [string, string][] = [
  ["--text", "--canvas"], ["--text", "--surface"], ["--text", "--surface-sunken"],
  ["--text-muted", "--canvas"], ["--text-muted", "--surface"], ["--text-muted", "--surface-sunken"],
  ["--accent", "--canvas"], ["--accent", "--surface"], ["--accent", "--accent-soft"], ["--on-accent", "--accent"],
  ["--ok", "--ok-soft"], ["--warn", "--warn-soft"], ["--danger", "--danger-soft"], ["--danger", "--surface"],
  ["--text", "--ok-soft"], ["--text", "--danger-soft"], ["--text", "--warn-soft"], ["--accent", "--surface-sunken"],
  ["--working", "--surface"], ["--working", "--working-soft"], ["--hunk", "--surface-sunken"],
  // A field's edge is a control's boundary: 3 to 1 on what it sits on.
  ["--border-field", "--surface"], ["--border-field", "--canvas"],
];

/** The contrast ratio of each pair, read from the tokens as the page resolves them now. */
async function contrasts(page: Page): Promise<{ pair: string; ratio: number }[]> {
  return page.evaluate((pairs) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    // A colour of any notation (OKLCH included) is painted once and read back as its pixel.
    const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgb = (token: string) => {
      probe.style.color = `var(${token})`;
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = getComputedStyle(probe).color;
      paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (c: number[]) => {
      const [r = 0, g = 0, b = 0] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out = pairs.map(([fg, bg]) => {
      const [a = 0, b = 0] = [luminance(rgb(fg)), luminance(rgb(bg))].sort((x, y) => y - x);
      return { pair: `${fg} on ${bg}`, ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 };
    });
    probe.remove();
    return out;
  }, PAIRS);
}

for (const theme of THEMES) {
  test.describe(`the design tokens in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test(`given the ${theme} theme, when each text colour is read on each background it is set on, then every text pair reaches 4.5 to 1 and a field's edge 3 to 1`, async ({ page }) => {
      // given
      await page.goto("/demo/tasks");

      // when
      const found = await contrasts(page);

      // then
      expect(found.filter((c) => c.ratio < (c.pair.startsWith("--border-field") ? 3 : 4.5))).toEqual([]);
    });
  });
}

test.describe("the shared buttons", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("given a button of every kind, when they are drawn side by side, then each size shares one height and the main one alone is filled with the accent", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);

    // when
    const drawn = await page.evaluate(() => {
      const row = document.createElement("div");
      row.innerHTML = [
        '<button data-kind="main">Main</button>', '<button class="secondary" data-kind="secondary">Secondary</button>',
        '<button class="ghost" data-kind="ghost">Ghost</button>', '<button class="secondary danger" data-kind="danger">Danger</button>',
        '<a class="button" href="#" data-kind="main link">Link</a>', '<a class="button secondary" href="#" data-kind="secondary link">Link</a>',
        '<button class="small" data-kind="small main">Small</button>', '<button class="secondary small" data-kind="small secondary">Small</button>',
        '<a class="button secondary small" href="#" data-kind="small link">Small</a>',
      ].join("");
      document.querySelector("main")!.append(row);
      const accent = getComputedStyle(document.querySelector("[data-kind='main']")!).borderTopColor;
      return [...row.children].map((el) => ({
        kind: (el as HTMLElement).dataset.kind!,
        height: Math.round(el.getBoundingClientRect().height),
        filled: getComputedStyle(el).backgroundColor === accent,
      }));
    });

    // then
    const regular = drawn.filter((b) => !b.kind.startsWith("small"));
    const small = drawn.filter((b) => b.kind.startsWith("small"));
    expect(new Set(regular.map((b) => b.height)).size).toBe(1);
    expect(new Set(small.map((b) => b.height)).size).toBe(1);
    expect(small[0]?.height).toBeLessThan(regular[0]?.height ?? 0);
    expect(drawn.filter((b) => b.filled).map((b) => b.kind)).toEqual(["main", "main link", "small main"]);
  });

  test("given a button a screen draws in its own colours, when it is pointed at, then it keeps them rather than turning into the main action", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.addStyleTag({ content: ".own-colours { background: rgb(1, 2, 3); color: rgb(250, 250, 250); }" });
    await page.evaluate(() => {
      const row = document.createElement("div");
      row.innerHTML = '<button class="own-colours">Own</button> <button>Main</button>';
      document.querySelector("main")!.append(row);
    });

    // when
    await page.getByRole("button", { name: "Own" }).hover();
    const own = await page.getByRole("button", { name: "Own" }).evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.getByRole("button", { name: "Main", exact: true }).hover();
    const main = await page.getByRole("button", { name: "Main", exact: true }).evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).borderTopColor]);

    // then
    expect(own).toBe("rgb(1, 2, 3)");
    expect(main[0]).toBe(main[1]);
  });

  test("given a page, when a button is reached with the Tab key, then a ring of at least two pixels shows around it", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.evaluate(() => {
      const row = document.createElement("div");
      row.innerHTML = '<input aria-label="Before"><button class="secondary">Reached</button>';
      document.querySelector("main")!.append(row);
    });
    await page.getByRole("textbox", { name: "Before" }).focus();

    // when
    await page.keyboard.press("Tab");

    // then
    const ring = await page.getByRole("button", { name: "Reached" }).evaluate((el) => {
      const s = getComputedStyle(el);
      return { focused: el.matches(":focus-visible"), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
    });
    expect(ring).toEqual({ focused: true, style: "solid", width: expect.any(Number) });
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });
});

/** How far the page's content moved by itself since the last call, as the browser scores a layout shift. */
async function shifted(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __shift: number };
    const sum = w.__shift;
    w.__shift = 0;
    return Math.round(sum * 1000) / 1000;
  });
}

test.describe("moving between sections", () => {
  for (const width of [1440, 390] as const) {
    test.describe(`at ${width} pixels`, () => {
      test.use({ viewport: { width, height: 900 } });

      test(`given each top tab in turn, when it is opened by its link and its data lands, then the page does not jump (${width} pixels)`, async ({ page }) => {
        // given
        await page.addInitScript(() => {
          const w = window as unknown as { __shift: number };
          w.__shift = 0;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__shift += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        });
        await page.goto("/demo/tasks");
        await settled(page);
        const moved: Record<string, number> = { tasks: await shifted(page) };

        // when
        const tabs = page.getByRole("navigation", { name: "Orchestrator" }).getByRole("link");
        for (const name of await tabs.allInnerTexts()) {
          await tabs.filter({ hasText: name }).click();
          await settled(page);
          await page.waitForTimeout(300);
          moved[name] = await shifted(page);
        }

        // then
        expect(Object.entries(moved).filter(([, v]) => v > 0.1)).toEqual([]);
      });
    });
  }
});

test.describe("the keyboard shortcuts", () => {
  test("given any page, when ? is pressed, then the shortcut list opens naming each top tab's keys, and Escape closes it", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);

    // when
    await page.keyboard.press("?");

    // then
    const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(list).toBeVisible();
    await expect(list.getByText("Go to Tasks")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
  });

  test("given any page, when g then t is pressed, then Tasks opens, and / opens the search", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);

    // when
    await page.keyboard.press("g");
    await page.keyboard.press("t");

    // then
    await expect(page).toHaveURL(/\/demo\/tasks$/);
    await page.keyboard.press("/");
    await expect(page.getByRole("searchbox", { name: "Search pages, projects and tasks" })).toBeFocused();
  });

  test("given the cursor in a field, when g then t is typed, then the letters land in the field and the page stays", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Elsewhere");
      document.querySelector("main")!.append(field);
    });
    await page.getByRole("textbox", { name: "Elsewhere" }).focus();

    // when
    await page.keyboard.type("gt");

    // then
    await expect(page.getByRole("textbox", { name: "Elsewhere" })).toHaveValue("gt");
    await expect(page).toHaveURL(/\/demo\/tasks$/);
  });

  test("given the cursor in another field, when Cmd or Ctrl and K are pressed, then the search opens with the cursor in it", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.setAttribute("aria-label", "Elsewhere");
      document.querySelector("main")!.append(field);
    });
    await page.getByRole("textbox", { name: "Elsewhere" }).focus();

    // when
    await page.keyboard.press("ControlOrMeta+K");

    // then
    await expect(page.getByRole("searchbox", { name: "Search pages, projects and tasks" })).toBeFocused();
  });
  test("given the search open, when a word is typed and the arrow keys move down to a repository, then Enter opens Tasks with it picked and the search closes", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.keyboard.press("ControlOrMeta+K");
    const search = page.getByRole("searchbox", { name: "Search pages, projects and tasks" });

    // when
    await search.fill("-skills");
    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    const second = await options.nth(1).locator(".palette-label").textContent();
    await search.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await search.press("Enter");

    // then
    await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
    await expect(page.locator(".day-sentence")).toHaveText(new RegExp(`^In ${second!}, `));
  });

  test("given the search open, when 'new task' is typed and Enter pressed, then the Actions group leads and Enter opens the new task page", async ({ page }) => {
    // given
    await page.goto("/demo/work");
    await settled(page);
    await page.keyboard.press("ControlOrMeta+K");
    const search = page.getByRole("searchbox", { name: "Search pages, projects and tasks" });

    // when
    await search.fill("new task");

    // then
    await expect(page.getByRole("group", { name: "Actions" }).getByRole("option", { name: /New task/ })).toBeVisible();
    await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

    // when
    await search.press("Enter");

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\/new$/);
    await expect(page.getByRole("form", { name: "New task" })).toBeVisible();
  });

  test("given a word only a task's log holds, when it is typed in the search, then the orchestrator's answer lists the task as found in its log and Enter opens it", async ({ page }) => {
    // given
    await page.route("**/api/search?*", (route) => route.fulfill({ json: { tasks: [], inLog: [{ id: "tsk_found", title: "Add the retry", repoId: "payments-skills", status: "needs-review" }], projects: [], folders: [] } }));
    await page.goto("/demo/tasks");
    await settled(page);
    await page.keyboard.press("ControlOrMeta+K");
    const search = page.getByRole("searchbox", { name: "Search pages, projects and tasks" });

    // when
    await search.fill("migration");

    // then
    const option = page.getByRole("group", { name: "Tasks" }).getByRole("option", { name: /Add the retry/ });
    await expect(option).toContainText("in its log");

    // when
    await search.press("Enter");

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\/tsk_found$/);
  });

  test("given a page with a search of its own, when / is pressed, then the cursor goes to that search and no second one opens", async ({ page }) => {
    // given
    await page.goto("/demo/tasks");
    await settled(page);
    await page.evaluate(() => {
      const field = document.createElement("input");
      field.type = "search";
      field.setAttribute("aria-label", "This page's own search");
      field.setAttribute("data-page-search", "");
      document.querySelector("main")!.append(field);
    });

    // when
    await page.keyboard.press("/");

    // then
    await expect(page.getByRole("searchbox", { name: "This page's own search" })).toBeFocused();
    await expect(page.getByRole("dialog", { name: "Search" })).toBeHidden();
  });
});

/** A section's read held, emptied or refused, as a slow, new or failing orchestrator answers it. */
type State = "loading" | "empty" | "error";
interface Read { name: string; url: string; api: RegExp; empty?: unknown }

const READS: Read[] = [
  { name: "tasks", url: "/demo/tasks", api: /\/api\/tasks(\?|$)/, empty: { tasks: [], next: null } },
  { name: "requests", url: "/demo/repositories/requests", api: /\/api\/requests\?/, empty: { requests: [], total: 0, counts: { open: 0, merged: 0, closed: 0 }, pageSize: 25, next: null } },
  { name: "activity", url: "/demo/activity/usage", api: /\/api\/activity\/usage\?/ },
  { name: "integrations", url: "/demo/integrations", api: /\/api\/integrations$/ },
  { name: "members", url: "/demo/settings/members", api: /\/api\/users$/, empty: { users: [] } },
];

async function inState(page: Page, read: Read, state: State): Promise<void> {
  await page.route(read.api, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (state === "loading") return new Promise<void>(() => undefined);
    if (state === "empty") return route.fulfill({ json: read.empty });
    return route.fulfill({ status: 500, json: { error: "The store did not answer.", code: "store" } });
  });
  await page.goto(read.url);
  if (state === "loading") await page.waitForTimeout(600);
  else await settled(page);
}

test.describe("each main section loading, empty and failing, drawn for a look over", () => {
  test.skip(!SHOTS, "Set ORCHESTRATOR_DESIGN_SHOTS to a directory to take the screenshots.");
  for (const theme of THEMES) {
    for (const width of [1440, 390] as const) {
      test.describe(`at ${width} pixels in the ${theme} theme`, () => {
        test.use({ colorScheme: theme, viewport: { width, height: 900 } });

        test(`given each section's read held, emptied or refused, when it is drawn ${width} pixels wide in the ${theme} theme, then it is saved for a look over and nothing sticks out of its box`, async ({ page }) => {
          test.setTimeout(300_000);
          const dir = `${SHOTS}/states/${theme}`;
          mkdirSync(dir, { recursive: true });
          const found: string[] = [];
          for (const read of READS) {
            for (const state of ["loading", "empty", "error"] as const) {
              if (state === "empty" && !read.empty) continue;
              await inState(page, read, state);
              for (const o of await overflows(page)) found.push(`${read.name} ${state}: ${o.where} ${o.why}`);
              await page.screenshot({ path: `${dir}/${width}-${read.name}-${state}.png`, fullPage: true });
              await page.unrouteAll({ behavior: "ignoreErrors" });
            }
          }
          expect(found).toEqual([]);
        });
      });
    }
  }
});

test.describe("the main screens drawn for a look over", () => {
  test.skip(!SHOTS, "Set ORCHESTRATOR_DESIGN_SHOTS to a directory to take the screenshots.");
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test.describe(`at ${width} pixels in the ${theme} theme`, () => {
        test.use({ colorScheme: theme, viewport: { width, height: 900 } });

        // One test a screen: a screen that hangs under load fails alone, and every other screen is still drawn and checked.
        for (const screen of SCREENS) {
          test(`given the ${screen.name} screen, when it is drawn ${width} pixels wide in the ${theme} theme, then it is saved for a look over, nothing sticks out of its box and one action at most is filled`, async ({ page }) => {
            const dir = `${SHOTS}/${theme}`;
            mkdirSync(dir, { recursive: true });
            await screen.open(page);
            await settled(page);
            const found = (await overflows(page)).map((o) => `${o.where} ${o.why}`);
            const filled = await mainActions(page);
            if (filled.length > 1) found.push(`${filled.length} filled buttons (${filled.join(", ")})`);
            await page.screenshot({ path: `${dir}/${width}-${screen.name}.png`, fullPage: true });
            expect(found).toEqual([]);
          });
        }
      });
    }
  }
});
