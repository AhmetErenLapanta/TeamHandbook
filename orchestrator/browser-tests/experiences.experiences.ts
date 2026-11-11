import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { OPENED, PERSONAL_HOME, PERSONAL_URL, TEAM_URL } from "../playwright.experiences.config.js";
import { EXPERIENCE_DIFFERENCES } from "./experience-differences.js";
import type { ExperienceScreen } from "./experience-differences.js";
import { signInWithOpenedLink } from "./one-time-link.js";

// The main screens hold one layout in Personal and in Team: each screen's structure, read at the level of its
// sections, and every route either experience offers are compared, and only the differences the design names
// (experience-differences.ts) are expected. Counts and the task's own title are no structure. Until the list
// is kept, ORCHESTRATOR_EXPERIENCES_GATE unset writes the differences down without failing on them.

type Side = "personal" | "team";
const SCREENS: { screen: Exclude<ExperienceScreen, "route">; path: (task: string) => string }[] = [
  { screen: "work", path: () => "work" },
  { screen: "tasks", path: () => "tasks" },
  { screen: "task", path: (task) => `tasks/${task}` },
  { screen: "team", path: () => "team" },
  { screen: "integrations", path: () => "integrations" },
  { screen: "settings", path: () => "settings" },
];
const TASK_TITLE = "Add a skill to the repository";
// The ask is drawn only when it says more than the title, so both sides give it a second line.
const TASK_ASK = `${TASK_TITLE}\nKeep the tests green.`;
// Personal's demo agent works where its description says; Team's stand-in takes no such line.
const PERSONAL_ASK = `${TASK_ASK}\nstand-in: work in alpha`;
// Sections drawn only while there is something left to do, so the data of each side decides whether they show: the
// comparison leaves them out rather than make the two fixtures tell the same story.
const DATA_DEPENDENT = new Set(["section: Getting set up"]);
const MODE_WORDS = /\b(local|self-hosted|self hosted|cloud)\b/i;

interface Opened { context: BrowserContext; page: Page; org: string; task: string }

/** A screen's structure as the person meets it: its title, then each labelled section, region and menu with its links, in page order. */
async function structure(page: Page, isTask: boolean): Promise<string[]> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(page.getByText(/^Loading\b/)).toHaveCount(0, { timeout: 30_000 }).catch(() => undefined);
  return page.evaluate((task) => {
    const norm = (text: string | null | undefined) => (text ?? "").replace(/\d+/g, "").replace(/\s+/g, " ").trim();
    const main = document.querySelector("main") ?? document.body;
    const items = [`title: ${task ? "<task>" : norm(main.querySelector("h1")?.textContent)}`];
    for (const el of main.querySelectorAll("section[aria-labelledby], section[aria-label], [role=region][aria-label], nav[aria-label]")) {
      if (el.closest("li")) continue;
      const by = el.getAttribute("aria-labelledby");
      const label = norm(el.getAttribute("aria-label") ?? (by ? document.getElementById(by)?.textContent : ""));
      if (!label) continue;
      const nav = el.tagName === "NAV";
      items.push(`${nav ? "menu" : "section"}: ${label}`);
      if (nav) for (const a of el.querySelectorAll("a")) items.push(`menu link: ${norm(a.textContent)}`);
    }
    return items;
  }, isTask);
}

/** Every path below the organization that one side's Settings menu, account menu and Activity menu offer. */
async function routes(page: Page, org: string): Promise<string[]> {
  const found = new Set<string>();
  const below = (href: string | null) => (href && href.startsWith(`/${org}/`) ? href.slice(org.length + 2).split(/[?#]/)[0]! : null);
  await page.goto(`/${org}/settings`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
  for (const href of await page.getByRole("navigation", { name: "Settings" }).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    const path = below(href);
    if (path) found.add(path);
  }
  await page.getByRole("button", { name: /^Account:/ }).click();
  for (const href of await page.getByRole("navigation", { name: "Account" }).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) {
    const path = below(href);
    if (path) found.add(path);
  }
  return [...found].sort();
}

/** The differences between two structures: what only one side holds, and whether what both hold comes in the same order. */
function compare(personalAll: string[], teamAll: string[]) {
  const personal = personalAll.filter((item) => !DATA_DEPENDENT.has(item));
  const team = teamAll.filter((item) => !DATA_DEPENDENT.has(item));
  const onlyIn = (a: string[], b: string[]) => {
    const left = [...b];
    return a.filter((item) => {
      const at = left.indexOf(item);
      if (at === -1) return true;
      left.splice(at, 1);
      return false;
    });
  };
  const both = personal.filter((item) => team.includes(item));
  const teamOrder = team.filter((item) => personal.includes(item));
  return { onlyPersonal: onlyIn(personal, team), onlyTeam: onlyIn(team, personal), sameOrder: JSON.stringify([...new Set(both)]) === JSON.stringify([...new Set(teamOrder)]) };
}

const allowed = (screen: ExperienceScreen, only: Side, entry: string) =>
  EXPERIENCE_DIFFERENCES.some((d) => d.screen === screen && d.only === only && (entry === d.item || entry.endsWith(`: ${d.item}`)));

async function csrfOf(request: APIRequestContext): Promise<string> {
  return ((await (await request.get("/api/me")).json()) as { csrf: string }).csrf;
}

test("given one person's orchestrator and a team's, when each main screen and every route opens in both, then their structure differs only where the design says", async ({ browser }, testInfo) => {
  // given: Personal with a working folder of one repository and one finished task, asked the same as Team's task, so the task page holds the same data on both sides
  const code = join(PERSONAL_HOME, "code");
  for (const name of ["alpha"]) {
    const repo = join(code, name);
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "README.md"), `${name}\n`);
    const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd: repo, stdio: "pipe" });
    git(["init", "--quiet"]);
    git(["add", "README.md"]);
    git(["commit", "--quiet", "-m", "First commit"]);
  }
  await expect.poll(() => { try { return readFileSync(OPENED, "utf8"); } catch { return ""; } }, { timeout: 60_000 }).not.toBe("");
  const personalContext = await browser.newContext({ baseURL: PERSONAL_URL });
  const personalPage = await personalContext.newPage();
  await signInWithOpenedLink(personalPage, OPENED);
  const personalCsrf = await csrfOf(personalContext.request);
  const headers = { "x-csrf-token": personalCsrf };
  const project = ((await (await personalContext.request.post("/api/projects", { data: { path: code }, headers })).json()) as { project: { id: string } }).project.id;
  const started = (await (await personalContext.request.post("/api/tasks/batch", { data: { agent: "fake", items: [{ title: TASK_TITLE, description: PERSONAL_ASK, repoId: project }] }, headers })).json()) as { started: { id: string }[] };
  const personalTask = started.started[0]!.id;
  await expect.poll(async () => ((await (await personalContext.request.get(`/api/tasks/${personalTask}`)).json()) as { task: { status: string } }).task.status, { timeout: 120_000 }).toBe("needs-review");
  const personalOrg = ((await (await personalContext.request.get("/api/orgs")).json()) as { default: string }).default;

  // given: Team, the demo organization as its admin, with a task of its own that waits for review
  const teamContext = await browser.newContext({ baseURL: TEAM_URL });
  const teamPage = await teamContext.newPage();
  const teamOrg = ((await (await teamContext.request.get("/api/orgs")).json()) as { default: string }).default;
  const teamHeaders = { "x-csrf-token": await csrfOf(teamContext.request) };
  const teamStarted = (await (await teamContext.request.post("/api/tasks/batch", { data: { agent: "fake", items: [{ title: TASK_TITLE, description: TASK_ASK, repoId: "payments-skills" }] }, headers: teamHeaders })).json()) as { started: { id: string }[]; refused?: unknown };
  const teamTask = teamStarted.started[0]!.id;
  await expect.poll(async () => ((await (await teamContext.request.get(`/api/tasks/${teamTask}`)).json()) as { task: { status: string } }).task.status, { timeout: 120_000 }).toBe("needs-review");
  const sides: Record<Side, Opened> = {
    personal: { context: personalContext, page: personalPage, org: personalOrg, task: personalTask },
    team: { context: teamContext, page: teamPage, org: teamOrg, task: teamTask },
  };

  // when each main screen opens in both
  const screens: Record<string, { personal: string[]; team: string[]; differences: ReturnType<typeof compare>; modeWords: Record<Side, string[]> }> = {};
  for (const { screen, path } of SCREENS) {
    const read = {} as Record<Side, string[]>;
    const words = {} as Record<Side, string[]>;
    for (const side of ["personal", "team"] as Side[]) {
      const { page, org, task } = sides[side];
      await page.goto(`/${org}/${path(task)}`);
      read[side] = await structure(page, screen === "task");
      words[side] = ((await page.locator("body").innerText()).split(/\n+/).filter((line) => MODE_WORDS.test(line))).map((line) => line.trim().slice(0, 160));
    }
    screens[screen] = { personal: read.personal, team: read.team, differences: compare(read.personal, read.team), modeWords: words };
  }

  // when every route either side offers opens in the other
  const offered = { personal: await routes(personalPage, personalOrg), team: await routes(teamPage, teamOrg) };
  const missing: { path: string; only: Side }[] = [];
  for (const path of [...new Set([...offered.personal, ...offered.team])]) {
    for (const side of ["personal", "team"] as Side[]) {
      const { page, org } = sides[side];
      await page.goto(`/${org}/${path}`);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 30_000 });
      if ((await page.getByRole("heading", { level: 1 }).first().innerText()) === "Page not found") missing.push({ path, only: side === "personal" ? "team" : "personal" });
    }
  }

  // then: written down whole, and with the list kept, nothing outside it
  const unlisted = [
    ...Object.entries(screens).flatMap(([screen, s]) => [
      ...s.differences.onlyPersonal.filter((entry) => !allowed(screen as ExperienceScreen, "personal", entry)).map((entry) => `${screen}: only Personal has ${entry}`),
      ...s.differences.onlyTeam.filter((entry) => !allowed(screen as ExperienceScreen, "team", entry)).map((entry) => `${screen}: only Team has ${entry}`),
      ...(s.differences.sameOrder ? [] : [`${screen}: the sections both have come in another order`]),
    ]),
    ...missing.filter((m) => !allowed("route", m.only, m.path)).map((m) => `route ${m.path}: only ${m.only === "personal" ? "Personal" : "Team"} has it`),
  ];
  const report = { screens, routes: { offered, missing }, unlisted };
  writeFileSync(testInfo.outputPath("experiences.json"), JSON.stringify(report, null, 2) + "\n");
  await testInfo.attach("experiences.json", { path: testInfo.outputPath("experiences.json"), contentType: "application/json" });
  console.log(unlisted.length ? `differences outside the list (${unlisted.length}):\n${unlisted.join("\n")}` : "no difference outside the list");
  if (process.env.ORCHESTRATOR_EXPERIENCES_GATE === "1") expect(unlisted).toEqual([]);
  await personalContext.close();
  await teamContext.close();
});
