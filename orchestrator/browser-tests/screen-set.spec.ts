import { mkdirSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chooseAgent, newTaskForm } from "./task-form.js";
import { standInWork } from "./work-fixtures.js";

// A screen set for people who have not seen the orchestrator: the main screens with made-up data,
// in both themes at a desktop's and a phone's width. Opt-in, since it starts tasks on the demo.
// The suite's server runs from temporary folders, so a path on screen reads as a server's own,
// /srv/teamhandbook, and the picture is refused if any trace of this machine is left.
const OUT = process.env.ORCHESTRATOR_SCREEN_SET;
const SERVER = "/srv/teamhandbook";

test.skip(!OUT, "Set ORCHESTRATOR_SCREEN_SET to a directory to write the screen set.");

const TASKS = [
  { title: "Add a retry with backoff to the payments webhook", description: "Failed deliveries are lost today; retry five times with backoff." },
  { title: "Write the release checklist skill", description: "List what a release needs, from the changelog to the rollback note." },
  { title: "Round refunds half to even", description: "Refunds of odd cents round up today; round half to even as the ledger does." },
];

async function settled(page: Page): Promise<void> {
  await expect(page.getByText(/^Loading|^Working out|^Reading the forge|^Reading what reaches|^Checking the agents/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
}

/** The three tasks, started once for the whole set: each pass after the first finds them run. */
async function started(page: Page): Promise<string[]> {
  const { csrf } = await (await page.request.get("/api/me")).json();
  const { tasks } = await (await page.request.get("/api/tasks")).json() as { tasks: { id: string; title: string }[] };
  const ids: string[] = [];
  for (const t of TASKS) {
    const found = tasks.find((x) => x.title === t.title);
    if (found) ids.push(found.id);
    else ids.push((await (await page.request.post("/api/tasks", { data: { ...t, repoId: "payments-skills", agent: "fake" }, headers: { "x-csrf-token": csrf } })).json()).task.id);
  }
  // Every task has finished before a picture is taken, so each pass shows the same list.
  await expect.poll(async () => {
    const { tasks: now } = await (await page.request.get("/api/tasks")).json() as { tasks: { id: string; status: string }[] };
    return ids.every((id) => ["needs-review", "failed"].includes(now.find((x) => x.id === id)?.status ?? ""));
  }, { timeout: 120_000 }).toBe(true);
  return ids;
}

async function local(page: Page): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
}

/** The machine's own folders and account read as a server's, and nothing of them is left. */
async function asServer(page: Page): Promise<void> {
  const traces = [homedir(), tmpdir(), "/private" + tmpdir(), "/var/folders"].filter((t) => t.length >= 4).sort((a, b) => b.length - a.length);
  await page.evaluate(([found, to]) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      let text = n.nodeValue ?? "";
      for (const t of found) text = text.split(t).join(to);
      // The suite's own scratch folder under it is a name of this run, not of the server's.
      text = text.replace(new RegExp(`${to}/[\\w]+-e2e-[\\w]+`, "g"), to);
      n.nodeValue = text;
    }
  }, [traces, SERVER] as const);
  const shown = await page.evaluate(() => document.body.innerText);
  for (const t of [homedir(), tmpdir(), userInfo().username, "/var/folders"].filter((t) => t.length >= 4)) expect(shown, `the screen shows ${t}`).not.toContain(t);
}

/** A run task's page read back as another state: what it asks, or what it waits for. */
async function taskAs(page: Page, id: string, change: Record<string, unknown>, lines = Infinity): Promise<void> {
  await page.route(`**/api/tasks/${id}/events*`, (route) => route.fulfill({ status: 204 }));
  await page.route(`**/api/tasks/${id}?*`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, task: { ...body.task, ...change }, log: body.log.slice(0, lines) } });
  });
  await page.goto(`/demo/tasks/${id}`);
}

const QUESTION = { id: "q1", kind: "question", status: "pending", responseCapability: "live", answer: null, answeredBy: null, createdAt: "2026-11-03T09:00:00.000Z", payload: { questions: [
  { key: "retry", title: "How often should the webhook retry?", description: "The payments provider resends for a day on its own.", choice: "one", options: [
    { value: "3", label: "Three times", description: "Then the event waits for a person in the failed queue." },
    { value: "5", label: "Five times, backing off", description: "One minute, then five, fifteen, an hour and four hours." },
  ] },
  { key: "notify", title: "Who hears about a failure?", choice: "many", other: true, options: [
    { value: "oncall", label: "The on-call engineer" },
    { value: "channel", label: "The payments channel" },
  ] },
] } };

interface Shot { name: string; open: (page: Page, tasks: string[]) => Promise<void> }

const SHOTS: Shot[] = [
  { name: "01-welcome", open: async (p) => { await local(p); await p.goto("/demo/welcome"); } },
  { name: "02-get-started", open: async (p) => { await p.goto("/demo/activity"); } },
  { name: "03-tasks", open: async (p) => { await p.goto("/demo/tasks"); } },
  { name: "04-new-task-agent-warning", open: async (p) => {
    await p.goto("/demo/tasks");
    await chooseAgent(await newTaskForm(p), /^Claude Code/);
  } },
  { name: "05-task", open: async (p, ids) => {
    await p.goto(`/demo/tasks/${ids[0]}`);
    await expect(p.locator("[data-status]").first()).toHaveText(/needs review/, { timeout: 60_000 });
  } },
  { name: "06-task-question", open: async (p, ids) => {
    await taskAs(p, ids[1]!, { status: "running", requests: [QUESTION], requestNumber: null, request: null, tests: null, finishedAt: null }, 6);
    await expect(p.getByText("How often should the webhook retry?")).toBeVisible();
  } },
  { name: "07-task-waiting-for-machine", open: async (p, ids) => {
    await taskAs(p, ids[2]!, { status: "queued", waitingFor: "machine", requests: [], requestNumber: null, request: null, tests: null, startedAt: null, finishedAt: null }, 0);
    await expect(p.getByText("This task waits for your machine to come online.")).toBeVisible();
  } },
  { name: "08-sprint-board", open: async (p) => { await standInWork(p); await p.goto("/demo/work"); } },
  { name: "09-repositories", open: async (p) => { await p.goto("/demo/repositories"); } },
  { name: "10-repository", open: async (p) => { await p.goto("/demo/repositories/payments-skills"); } },
  { name: "11-requests", open: async (p) => { await p.goto("/demo/repositories/requests"); } },
  { name: "12-controls", open: async (p) => { await p.goto("/demo/team"); } },
  { name: "13-integrations", open: async (p) => { await p.goto("/demo/integrations"); } },
  { name: "14-settings-members", open: async (p) => { await p.goto("/demo/settings/members"); } },
];

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390] as const) {
    test.describe(`in the ${theme} theme at ${width} pixels`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: width === 390 ? 844 : 900 } });

      test(`given the demo with three tasks run, when each main screen opens, then it is drawn for the screen set with no trace of this machine`, async ({ page }) => {
        test.setTimeout(300_000);
        const ids = await started(page);
        mkdirSync(OUT!, { recursive: true });
        for (const shot of SHOTS) {
          await shot.open(page, ids);
          await settled(page);
          await asServer(page);
          await page.screenshot({ path: `${OUT}/${shot.name}-${theme}-${width}.png`, fullPage: true });
          await page.unrouteAll({ behavior: "ignoreErrors" });
        }
      });
    });
  }
}

// The project-first set: one person's own orchestrator with a made-up home, from picking a folder
// to reviewing what a task changed in it without Git.
const HOME = "/home/ada";
const entry = (name: string, path: string, git: "none" | "repo" | "origin" = "none") => ({ name, path: `${HOME}/${path}`, git, markers: [] });
const FOLDERS = {
  under: HOME, parent: null, truncated: false,
  suggestions: [entry("payments-api", "code/payments-api", "origin"), entry("checkout-web", "code/checkout-web", "repo")],
  folders: [entry("code", "code"), entry("Documents", "Documents"), entry("notes", "notes")],
};
const IN_CODE = { under: `${HOME}/code`, parent: HOME, truncated: false, suggestions: [], folders: [entry("on-call-notes", "code/on-call-notes"), entry("payments-api", "code/payments-api", "origin")] };
const CHANGED = [
  { path: "runbook.md", status: "modified", previousPath: null, additions: 6, deletions: 2, binary: false, test: false },
  { path: "escalation.md", status: "added", previousPath: null, additions: 9, deletions: 0, binary: false, test: false },
];
const PATCHES: Record<string, string> = {
  "runbook.md": "@@ -1,6 +1,10 @@\n # On-call runbook\n-Page the lead when payments fail.\n+Page the on-call engineer first; the lead after 15 minutes.\n \n ## Refunds\n-Check the queue by hand.\n+Check the failed queue in the dashboard.\n+Retry from there; each retry is logged.\n+\n+See escalation.md for who is next.",
  "escalation.md": "@@ -0,0 +1,9 @@\n+# Escalation\n+\n+1. On-call engineer\n+2. Payments lead, after 15 minutes\n+3. Head of engineering, after an hour\n+\n+Every step is logged in the incident channel.",
};

async function oneMachine(page: Page, project: Record<string, unknown> | null): Promise<void> {
  await local(page);
  await page.route(/\/api\/local\/folders/, (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get("under") ? IN_CODE : FOLDERS }));
  await page.route(/\/api\/projects$/, (route) => route.request().method() === "GET" ? route.fulfill({ json: { projects: project ? [project] : [], last: project ? project.id : null, home: HOME } }) : route.fallback());
}

/** The demo's first project, read back as a folder without Git on this made-up machine. */
async function notesProject(page: Page): Promise<Record<string, unknown>> {
  const { repos } = await (await page.request.get("/api/repos")).json();
  return { ...repos[0], id: "on-call-notes", name: "on-call-notes", url: `file://${HOME}/code/on-call-notes`, facts: { git: "none", origin: null, name: "on-call-notes", kind: "code" } };
}

/** A run task read back as having changed that folder in place, waiting for the person to review it. */
async function changedInPlace(page: Page, id: string, project: Record<string, unknown>): Promise<void> {
  const changes = { files: CHANGED, undone: null };
  await page.route(`**/api/tasks/${id}/events*`, (route) => route.fulfill({ status: 204 }));
  await page.route(new RegExp(`/api/tasks/${id}\\?`), async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    const at = body.task.createdAt ?? new Date().toISOString();
    const log = ["Started in ~/code/on-call-notes; the agent edits the files there directly.", "Starting the agent.", "reading the task: Tidy the on-call runbook", "edited runbook.md", "wrote escalation.md", "The agent changed 2 files; they wait for you to review."].map((text, i) => ({ seq: i + 1, at, text }));
    await route.fulfill({ response: res, json: { ...body, log, task: { ...body.task, title: "Tidy the on-call runbook", description: "Say who is paged first, in which order, and where refunds are retried.", repoId: project.id, team: "", result: "changes", status: "needs-review", requestNumber: null, request: null, tests: "skipped", changes } } });
  });
  await page.route(new RegExp(`/api/tasks/${id}/changes$`), (route) => route.fulfill({ json: { changes: { files: CHANGED, omitted: 0 } } }));
  await page.route(new RegExp(`/api/tasks/${id}/changes/.+`), (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.split("/changes/")[1] ?? "");
    return route.fulfill({ json: { file: { patch: PATCHES[path] ?? null, truncated: false, note: null } } });
  });
}

const PROJECT_SHOTS: Shot[] = [
  { name: "15-open-a-folder", open: async (p) => { await oneMachine(p, null); await p.goto("/demo/welcome"); await expect(p.locator(".folder-row").first()).toBeVisible(); } },
  { name: "16-look-inside-a-folder", open: async (p) => {
    await oneMachine(p, null);
    await p.goto("/demo/welcome");
    await p.locator("button.folder-row").filter({ has: p.locator(".folder-name", { hasText: /^code$/ }) }).first().click();
    await expect(p.locator(".folder-up")).toBeVisible();
  } },
  { name: "17-first-task", open: async (p) => { await oneMachine(p, await notesProject(p)); await p.goto("/demo/welcome"); await expect(p.locator(".task-box")).toBeVisible(); } },
  { name: "18-review-changes", open: async (p, ids) => {
    const project = await notesProject(p);
    await oneMachine(p, project);
    await changedInPlace(p, ids[0]!, project);
    await p.goto(`/demo/tasks/${ids[0]}`);
    await expect(p.getByRole("heading", { name: /^Changes/ })).toBeVisible();
    const runbook = p.locator(".diff-files details").filter({ has: p.locator("summary", { hasText: "runbook.md" }) }).first();
    if (!(await runbook.evaluate((d) => (d as HTMLDetailsElement).open))) await runbook.locator("summary").click();
    await expect(runbook.locator(".diff-patch")).toBeVisible();
  } },
  { name: "19-to-review", open: async (p, ids) => {
    const project = await notesProject(p);
    await oneMachine(p, project);
    await p.route(/\/api\/repos$/, async (route) => route.request().method() === "GET" ? route.fulfill({ json: { repos: [project] } }) : route.fallback());
    await p.route(/\/api\/tasks(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      const body = await res.json();
      const tasks = body.tasks.map((t: { id: string }) => (t.id === ids[0] ? { ...t, title: "Tidy the on-call runbook", repoId: project.id, result: "changes", status: "needs-review", changes: { files: CHANGED, undone: null } } : t));
      await route.fulfill({ response: res, json: { ...body, tasks } });
    });
    await p.goto("/demo/repositories/requests");
    await expect(p.getByRole("heading", { name: /Changes in folders/ })).toBeVisible();
  } },
];

for (const theme of ["light", "dark"] as const) {
  for (const width of [1440, 390] as const) {
    test.describe(`the project-first screens in the ${theme} theme at ${width} pixels`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: width === 390 ? 844 : 900 } });

      test(`given one person's orchestrator with a made-up home, when a folder is picked, a task given and its changes reviewed, then each screen is drawn for the screen set with no trace of this machine`, async ({ page }) => {
        test.setTimeout(300_000);
        const ids = await started(page);
        mkdirSync(OUT!, { recursive: true });
        for (const shot of PROJECT_SHOTS) {
          await shot.open(page, ids);
          await settled(page);
          await asServer(page);
          await page.screenshot({ path: `${OUT}/${shot.name}-${theme}-${width}.png`, fullPage: true });
          await page.unrouteAll({ behavior: "ignoreErrors" });
        }
      });
    });
  }
}
