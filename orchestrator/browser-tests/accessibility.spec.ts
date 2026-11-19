import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { hostedPayments, openForgeCard } from "./hosted-forge.js";
import { manyPeople, manySkills } from "./large-lists.js";
import { monthOfUse, oneEvent, someEvents } from "./activity-data.js";
import { GUESSED_MOVES, sprintItems, standInStart, standInWork } from "./work-fixtures.js";
import { newTaskForm } from "./task-form.js";

// Every main screen, in both themes the stylesheet has, is checked against WCAG 2.1 A and AA
// and axe's best practices, as axe-core reads them. A screen is checked once it has finished loading, so a rule that
// fails only on a half-drawn page is not counted, and one that fails on the finished page is.
const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const THEMES = ["light", "dark"] as const;

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(RULES).analyze();
  return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
}

async function startedTask(page: Page): Promise<string> {
  const { csrf } = await (await page.request.get("/api/me")).json();
  const res = await page.request.post("/api/tasks", {
    data: { title: "Write the release checklist", description: "List what a release needs.", repoId: "payments-skills", agent: "fake" },
    headers: { "x-csrf-token": csrf },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).task.id;
}


const HANDBOOKS = [
  { id: "yours", kind: "yours", name: "Yours", enabled: true, skills: [{ name: "release-notes", description: "Write release notes" }], commands: [{ name: "standup" }], mcpServers: [{ name: "jira" }], hooks: [], claudeMd: true },
  { id: "plugin:payments-skills@payments-market", kind: "plugin", name: "payments-skills", version: "1.4.0", marketplace: "payments-market", enabled: true, skills: [{ name: "add-endpoint" }, { name: "review-checklist" }], commands: [], mcpServers: [], hooks: [{ name: "PreToolUse" }] },
  { id: "plugin:docs-kit@payments-market", kind: "plugin", name: "docs-kit", version: "2.0.0", marketplace: "payments-market", enabled: false, skills: [{ name: "write-docs" }], commands: [], mcpServers: [], hooks: [] },
];

async function standInHandbooks(page: Page, onThisMachine = false): Promise<void> {
  if (onThisMachine) {
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
    });
  }
  await page.route("**/api/handbook/sources*", (route) => route.fulfill({ json: { available: true, sources: HANDBOOKS, readAt: new Date().toISOString() } }));
  await page.route((url) => url.pathname === "/api/handbook/defaults", (route) => route.fulfill({ json: { off: { skills: [], commands: [], mcpServers: [] } } }));
}

async function standInLessons(page: Page): Promise<void> {
  const items = Array.from({ length: 4 }, (_, i) => ({ slug: `lesson-${i}`, description: `Use when ${i}`, origin: i % 2 ? "harvest" : "task", sessionId: `ses_${i}`, createdAt: "2026-11-05T09:00:00.000Z", firstLine: `First line ${i}` }));
  await page.route("**/api/lessons/review?*", (route) => route.fulfill({ json: { total: 4, items } }));
  await page.route("**/api/lessons/review/lesson-1", (route) => route.fulfill({ json: { lesson: { slug: "lesson-1", skillMd: "---\nname: lesson-1\n---\nRetry twice, then stop.", quote: null } } }));
}

const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "repository overview",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills");
      await expect(page.getByRole("region", { name: /^Setup/ })).toBeVisible();
    },
  },
  {
    name: "repository requests",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/requests");
      await expect(page.getByRole("region", { name: /^Requests from the orchestrator/ })).toBeVisible();
    },
  },
  {
    name: "repository",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/skills");
      await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();
      await page.getByRole("cell", { name: "add-ledger-migration" }).click();
      await expect(page.getByRole("heading", { name: /History/ })).toContainText("skills/add-ledger-migration");
      await expect(page.locator(".history li").first()).toBeVisible();
    },
  },
  {
    name: "skill editor",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/skills");
      await page.getByRole("button", { name: "Add a skill" }).click();
      await expect(page.getByLabel("SKILL.md")).toBeVisible();
    },
  },
  {
    name: "MCP server form",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/mcp");
      await page.getByRole("button", { name: "Add a server" }).click();
      await expect(page.getByLabel("Server name")).toBeVisible();
    },
  },
  {
    name: "reviewers and labels form",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/settings");
      await page.getByRole("button", { name: "Edit reviewers and labels" }).click();
      await expect(page.getByLabel("Labels, separated by commas")).toBeVisible();
    },
  },
  {
    name: "MCP server edit form",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/mcp");
      await page.getByRole("row", { name: /^docs/ }).getByRole("button", { name: "Edit" }).click();
      await expect(page.getByLabel("URL")).toHaveValue("https://docs.example.com/mcp");
    },
  },
  {
    name: "command edit form",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/commands");
      await page.getByRole("button", { name: "Edit /deploy-check" }).click();
      await expect(page.getByLabel("Command text")).toHaveValue(/release-checklist/);
    },
  },
  {
    name: "naming form",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/settings");
      await page.getByRole("button", { name: "Edit naming" }).click();
      await expect(page.getByLabel(/^Example branch name/)).toBeVisible();
    },
  },
  {
    name: "commit message step",
    open: async (page) => {
      await page.goto("/demo/repositories/payments-skills/settings");
      await page.getByRole("button", { name: "Edit reviewers and labels" }).click();
      await page.getByLabel("Labels, separated by commas").fill("skills, payments");
      await page.getByRole("button", { name: "Review the change" }).click();
      await expect(page.getByLabel("Commit message")).toBeVisible();
    },
  },
  {
    name: "forge access form",
    open: async (page) => {
      await hostedPayments(page);
      await openForgeCard(page);
      await expect(page.getByRole("form", { name: "Forge access" }).getByLabel("Project")).toBeVisible();
    },
  },
  {
    name: "repository out of the configuration",
    open: async (page) => {
      await page.route("**/api/repos", async (route) => {
        const body = await (await route.fetch()).json();
        body.repos = body.repos.map((r: { id: string }) => (r.id === "platform-skills" ? { ...r, configured: false } : r));
        await route.fulfill({ json: body });
      });
      await page.route("**/api/repos/platform-skills/inventory", async (route) => {
        const body = await (await route.fetch()).json();
        await route.fulfill({ json: { ...body, repo: { ...body.repo, configured: false } } });
      });
      await page.goto("/demo/repositories/platform-skills");
      await page.getByRole("button", { name: "Disconnect project" }).click();
      await expect(page.getByRole("button", { name: "Disconnect platform-skills" })).toBeVisible();
    },
  },
  {
    name: "people, 300 of them",
    open: async (page) => {
      await manyPeople(page);
      await page.goto("/demo/settings/members");
      await expect(page.getByRole("navigation", { name: "Pages of members" })).toBeVisible();
    },
  },
  {
    name: "repository with 2000 skills",
    open: async (page) => {
      await manySkills(page);
      await page.goto("/demo/repositories/payments-skills/skills");
      await expect(page.getByRole("navigation", { name: "Pages of skills" })).toBeVisible();
    },
  },
  {
    name: "tasks of one repository",
    open: async (page) => {
      await page.goto("/demo/tasks?repo=payments-skills");
      await expect(page.locator(".day-sentence")).toHaveText(/^In payments-skills, /);
      await expect(page.getByText(/^Loading.*…$/).filter({ visible: true })).toHaveCount(0);
    },
  },
  {
    name: "members settings, with links just sent",
    open: async (page) => {
      await page.goto("/demo/settings/members");
      await page.getByRole("button", { name: "Invite members" }).click();
      await page.getByLabel("Emails").fill(`axe-${Date.now()}@example.invalid`);
      await page.getByRole("button", { name: "Create invitation links" }).click();
      await expect(page.getByRole("region", { name: "Links to send" })).toContainText("Send each person their link");
      await expect(page.getByRole("region", { name: /^Invitations/ })).toBeVisible();
    },
  },
  {
    name: "member page",
    open: async (page) => {
      const { users } = await (await page.request.get("/api/users")).json();
      await page.goto(`/demo/settings/members/${users.find((u: { email: string }) => u.email === "pat@example.invalid").id}`);
      await expect(page.getByRole("heading", { name: "Pat Payments" })).toBeVisible();
    },
  },
  {
    name: "API keys, with a secret just shown",
    open: async (page) => {
      await page.goto("/demo/settings/api-keys");
      await page.getByRole("form", { name: "New API key" }).getByLabel("Name").fill(`axe-${Date.now()}`);
      await page.getByRole("button", { name: "Create key" }).click();
      await expect(page.getByRole("region", { name: "New API key" })).toContainText("th_sk_");
    },
  },
  {
    name: "service accounts",
    open: async (page) => {
      await page.goto("/demo/settings/service-accounts");
      await expect(page.getByRole("heading", { name: "Add service account" })).toBeVisible();
    },
  },
  {
    name: "security settings",
    open: async (page) => {
      await page.goto("/demo/settings/security");
      await expect(page.getByRole("heading", { name: "Directory sync" })).toBeVisible();
      await expect(page.getByText(/^Loading.*…$/)).toHaveCount(0);
    },
  },
  {
    name: "privacy settings",
    open: async (page) => {
      await page.goto("/demo/settings/privacy");
      await expect(page.getByLabel("Days to keep task logs")).toBeVisible();
    },
  },
  {
    name: "task secrets",
    open: async (page) => {
      await page.goto("/demo/settings/task-secrets");
      await expect(page.getByRole("form", { name: "Add a secret" })).toBeVisible();
      await expect(page.getByText("Loading task secrets...")).toHaveCount(0);
    },
  },
  {
    name: "join page",
    open: async (page) => {
      const { csrf } = await (await page.request.get("/api/me")).json();
      const res = await page.request.post("/api/invites", { data: { emails: `join-${Date.now()}@example.invalid`, role: "member" }, headers: { "x-csrf-token": csrf } });
      const link: string = (await res.json()).invited[0].link;
      await page.goto(`/#/join/${link.split("/join/")[1]}`);
      await expect(page.getByLabel("Password")).toBeVisible();
    },
  },
  {
    name: "tasks",
    open: async (page) => {
      await page.goto("/demo/tasks");
      await expect(await newTaskForm(page)).toBeVisible();
      await expect(page.getByText(/^Loading.*…$/).filter({ visible: true })).toHaveCount(0);
    },
  },
  {
    name: "what's new",
    open: async (page) => {
      await page.goto("/demo/activity/news");
      await expect(page.getByRole("heading", { name: "Work, Tasks, Team and Integrations" })).toBeVisible();
    },
  },
  {
    name: "tasks with the dark theme picked",
    open: async (page) => {
      await page.addInitScript(() => window.localStorage.setItem("orchestrator.theme", "dark"));
      await page.goto("/demo/tasks");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
    },
  },
  {
    name: "account menu and search",
    open: async (page) => {
      await page.goto("/demo/tasks");
      await page.getByRole("button", { name: /^Search/ }).click();
      await page.getByRole("searchbox", { name: "Search pages, projects and tasks" }).fill("pay");
      await expect(page.getByRole("group", { name: "Repositories" }).getByRole("option", { name: /payments-skills/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: /^Account:/ }).click();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    },
  },
  {
    name: "usage over a month",
    open: async (page) => {
      await monthOfUse(page);
      await page.goto("/demo/activity/usage");
      await expect(page.getByRole("img", { name: /Skill use per day/ })).toBeVisible();
    },
  },
  {
    name: "leaderboard",
    open: async (page) => {
      await page.goto("/demo/activity/leaderboard");
      await expect(page.getByRole("group", { name: "Time range" })).toBeVisible();
      await expect(page.getByText(/^Loading.*…$/).filter({ visible: true })).toHaveCount(0);
    },
  },
  {
    name: "logs",
    open: async (page) => {
      await page.goto("/demo/activity/logs");
      await expect(page.getByRole("heading", { name: /^Tasks, last/ })).toBeVisible();
      await expect(page.getByText(/^Loading.*…$/).filter({ visible: true })).toHaveCount(0);
    },
  },
  {
    name: "audit",
    open: async (page) => {
      await someEvents(page);
      await page.goto("/demo/activity/audit");
      await expect(page.getByRole("cell", { name: "request.merged" })).toBeVisible();
    },
  },
  {
    name: "audit entry",
    open: async (page) => {
      await oneEvent(page);
      await page.goto("/demo/activity/audit/e1");
      await expect(page.getByRole("region", { name: /^Fields changed/ })).toBeVisible();
    },
  },
  {
    name: "integrations",
    open: async (page) => {
      await page.goto("/demo/integrations");
      await expect(page.getByRole("heading", { name: "GitLab", exact: true })).toBeVisible();
    },
  },
  {
    name: "sprint board",
    open: async (page) => {
      await standInWork(page, { moves: GUESSED_MOVES });
      await page.goto("/demo/work");
      await expect(page.getByRole("region", { name: "Sprint progress" })).toBeVisible();
    },
  },
  {
    name: "backlog with agents to start",
    open: async (page) => {
      await standInWork(page, { backlog: sprintItems });
      await standInStart(page);
      await page.goto("/demo/work/backlog");
      await page.getByRole("checkbox", { name: "Pick PAY-101" }).check();
      await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
      await expect(page.getByRole("form", { name: "Start agents" })).toBeVisible();
    },
  },
  {
    name: "new task with its setup panel",
    open: async (page) => {
      await standInHandbooks(page);
      await page.goto("/demo/tasks");
      await expect(page.locator("section.task-setup")).toBeVisible();
    },
  },
  {
    name: "team with lessons to review and one open in the rail",
    open: async (page) => {
      await standInLessons(page);
      await page.goto("/demo/team");
      await page.getByRole("region", { name: /^Lessons to review/ }).getByRole("button", { name: "First line 1", exact: true }).click();
      await expect(page.getByText("Retry twice, then stop.")).toBeVisible();
    },
  },
  {
    name: "team on one person's machine with Your handbooks",
    open: async (page) => {
      await standInHandbooks(page, true);
      await page.goto("/demo/team");
      await expect(page.getByRole("region", { name: /^Your handbooks/ }).locator("li.handbook").first()).toBeVisible();
      await page.getByRole("button", { name: /Add a skill, a command/ }).click();
    },
  },
  {
    name: "task",
    open: async (page) => {
      const id = await startedTask(page);
      await page.goto(`/demo/tasks/${id}`);
      await expect(page.locator("[data-status]").first()).toHaveText(/needs you|failed/, { timeout: 30_000 });
    },
  },
  {
    name: "task with a teammate's suggested follow-up",
    open: async (page) => {
      const id = await startedTask(page);
      await page.route(`**/api/tasks/${id}?*`, async (route) => {
        const body = await (await route.fetch()).json();
        const suggestions = [{ id: "fup_1", by: { name: "Pat Payments" }, text: "Retry only on a timeout, not on a 4xx.", quotes: [{ path: "src/capture.ts", lines: "11-12", text: "+retry()" }], createdAt: new Date().toISOString(), status: "waiting", canAnswer: true }];
        await route.fulfill({ json: { ...body, task: { ...body.task, suggestions, startedBy: { name: "Ada Admin" } } } });
      });
      // The stream's own task event tells the real, empty list and would replace this stand-in answer.
      await page.route(`**/api/tasks/${id}/events*`, (route) => route.fulfill({ status: 204 }));
      await page.goto(`/demo/tasks/${id}`);
      await expect(page.getByRole("listitem", { name: "Pat Payments suggests a follow-up" }).getByRole("button", { name: "Continue with it" })).toBeVisible({ timeout: 30_000 });
    },
  },
];

for (const theme of THEMES) {
  test.describe(`in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test("given the sign-in screen, when it is checked, then axe finds no violation", async ({ browser }) => {
      // given
      const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, colorScheme: theme });
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

      // when
      const found = await violations(page);

      // then
      expect(found).toEqual([]);
      await context.close();
    });

    for (const screen of SCREENS) {
      test(`given the ${screen.name} screen, when it is checked, then axe finds no violation`, async ({ page }) => {
        // given
        await screen.open(page);

        // when
        const found = await violations(page);

        // then
        expect(found).toEqual([]);
      });
    }
  });
}

test.describe("at 390 pixels wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("given the sign-in screen, when it is read on a phone, then the page does not scroll sideways", async ({ browser }) => {
    // given
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // when
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));

    // then
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await context.close();
  });

  for (const screen of SCREENS) {
    test(`given the ${screen.name} screen, when it is read on a phone, then the page does not scroll sideways`, async ({ page }) => {
      // given
      await screen.open(page);

      // when
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));

      // then
      expect(widths.page).toBeLessThanOrEqual(widths.view);
    });
  }
});

for (const theme of THEMES) {
  test(`given the agent's answer holds highlighted code, when the task page is read in the ${theme} theme, then the colours of comments, strings, numbers and keywords pass the contrast rules`, async ({ page }) => {
    // given
    await page.emulateMedia({ colorScheme: theme });
    const at = new Date().toISOString();
    const lastSaid = ["Use this:", "", "```ts", "// total of the lines", "const total = lines.length + 42;", "return \"done\";", "```"].join("\n");
    await page.route("**/api/tasks/t1?*", (route) => route.fulfill({ json: { task: { id: "t1", title: "Retry a failed capture", status: "failed", phase: "failed", state: "finished-nothing-changed", repoId: "payments-skills", team: "Payments", description: "", issueUrl: null, issueKey: null, agent: "fake", createdBy: "ada@example.invalid", createdAt: at, startedAt: at, finishedAt: at, baseSha: null, tests: null, cost: { usd: null }, requestNumber: null, error: null, template: null, queuePosition: null, request: null, lastSaid }, log: [], outputCut: false } }));
    await page.route("**/api/tasks/t1/events*", (route) => route.fulfill({ status: 204 }));

    // when
    await page.goto("/demo/tasks/t1");
    await expect(page.locator(".markdown .tok-keyword").first()).toBeVisible();

    // then
    expect(await violations(page)).toEqual([]);
  });
}
