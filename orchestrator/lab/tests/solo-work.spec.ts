import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { freePort } from "../clean-machine.js";
import type { CleanMachine } from "../clean-machine.js";
import { GITHUB_ISSUES, GITHUB_MILESTONES } from "../cloud.js";
import { startFakeForge } from "../forge.js";
import { startJira } from "../jira.js";
import { BACKLOG_ISSUES, CUSTOMERS_BOARD, MULTI_REPO_ISSUE, SPRINT_ISSUES } from "../multi-repo.js";
import { ORCHESTRATOR_DIR, personsRepository, soloSession } from "../solo.js";
import { labDir } from "../state.js";

/**
 * The orchestrator alone on one machine, with the person's own Jira token on the issue tracker
 * card: Work draws the team's sprint board with no team to map it to, an issue picked on it starts
 * an agent in the person's repository, and the card follows that agent until its request waits in
 * review. Jira is the lab's stand-in, started here on a port of its own; the machine is the solo
 * scenarios' clean one (lab/clean-machine.ts), its agent the stand-in claude.
 */

const EMAIL = "solo-bot@person.example.invalid";
const SPRINT = "Customers Sprint 14";

/** The GitHub repository the person's project names as origin, with the lab's November milestone and its issues. */
const GITHUB_REPO = "acme/web-skills";
const MILESTONE = "Web, November";

/** gh on the clean machine, signed in to github.com and reading from the stand-in GitHub (lab/stand-in-gh.mjs); what it was asked is kept. */
function ghStandIn(root: string, forge: string, token: string): { more: (machine: CleanMachine) => NodeJS.ProcessEnv; asked: () => string[][] } {
  const bin = join(root, "gh-bin");
  const log = join(root, "gh.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nexec node '${join(ORCHESTRATOR_DIR, "lab", "stand-in-gh.mjs")}' "$@"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return {
    more: (machine) => ({ PATH: `${bin}:${machine.env.PATH}`, LAB_GH_FORGE: forge, LAB_GH_TOKEN: token, LAB_GH_LOG: log }),
    asked: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
  };
}

/** A project of the person's whose origin is the GitHub repository; its own config sends any git call to github.com to a closed port, so nothing reaches GitHub. */
function githubProject(machine: CleanMachine): string {
  const folder = join(machine.home, "work", "web-skills");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "README.md"), "# web-skills\n");
  for (const args of [["init", "--quiet", "-b", "main"], ["remote", "add", "origin", `https://github.com/${GITHUB_REPO}.git`], ["config", "url.http://127.0.0.1:9/.insteadOf", "https://github.com/"], ["add", "."], ["commit", "--quiet", "-m", "The web team's skills"]]) {
    const done = spawnSync("git", args, { cwd: folder, env: machine.env, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  }
  return folder;
}

/** The person enters their Jira's address, account and token on the issue tracker card, opened by its link. */
async function enterJiraToken(page: Page, org: string, port: number, token: string): Promise<void> {
  await page.goto(`${org}/integrations?open=tracker`);
  const card = page.getByRole("form", { name: "Issue tracker" });
  await card.getByLabel("Address").fill(`http://127.0.0.1:${port}`);
  await card.getByLabel("Account email").fill(EMAIL);
  await card.getByLabel("API token").fill(token);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("region", { name: "Issue tracker" })).toContainText("Issues are read with a token set by");
}

/** A folder of the person's with no Git, laid out as a service with an endpoint per call. */
function plainFolder(machine: CleanMachine): string {
  const folder = join(machine.home, "work", "returns-service");
  mkdirSync(join(folder, "src", "endpoints"), { recursive: true });
  writeFileSync(join(folder, "README.md"), "# returns-service\n\nAnswers the returns' calls, an endpoint per call under src/endpoints/.\n");
  writeFileSync(join(folder, "src", "endpoints", "returns.ts"), 'export const returns = { method: "GET", path: "/returns" };\n');
  return folder;
}

const stamp = (what: string) => join(labDir(), "solo-work", `${what}-${Date.now().toString(36)}`);

test.describe("the orchestrator alone works a sprint from the person's Jira or GitHub", () => {
  test("given a clean machine with a repository of the person's and a Jira that answers to their token, when they enter the token on the issue tracker card, open Work, pick an issue and start its agent, then the board is their sprint in its workflow's columns, the card shows its agent working and then its request in review, and the token and the person's own tools stay out of it", async ({ page }) => {
    test.setTimeout(600_000);
    // given a Jira of the person's on this machine, read with their token
    const root = stamp("jira");
    const token = `jira-${randomBytes(12).toString("hex")}`;
    const port = await freePort();
    mkdirSync(root, { recursive: true });
    await startJira({ port, email: EMAIL, token, issues: [MULTI_REPO_ISSUE, ...SPRINT_ISSUES, ...BACKLOG_ISSUES], boards: [CUSTOMERS_BOARD], log: join(root, "jira.log") });
    const solo = await soloSession(page, root);
    try {
      const repo = personsRepository(solo.machine);
      await solo.call("POST", "/api/projects", { path: repo });
      await page.goto(solo.base);
      await page.waitForURL(/\/activity$/);
      const org = new URL(page.url()).pathname.split("/")[1]!;

      // when they enter their token on the issue tracker card
      await enterJiraToken(page, `${solo.base}/${org}`, port, token);

      // then the card reads issues and never shows the token
      await expect(page.getByRole("region", { name: "Issue tracker" })).toContainText("Issues are read with a token set by");
      expect(await page.content()).not.toContain(token);
      expect((await solo.call<{ tracker: boolean }>("GET", "/api/activity/summary")).tracker).toBe(true);

      // when they open Work
      await page.goto(`${solo.base}/${org}/work`);

      // then the board is the sprint in the team's workflow, with no team asked for
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(SPRINT);
      const board = page.getByRole("group", { name: `${SPRINT} board` });
      await expect(board.getByRole("heading", { level: 2 })).toHaveText([/^Ready for Dev 3/, /^In Dev 0/, /^Code Review 0/, /^Ready for Test 0/, /^In Test 0/, /^Test Passed 0/, /^Done 0/]);
      await expect(page.getByRole("group", { name: "Who works on this board" })).toHaveCount(0);

      // when they pick an issue and start its agent
      await page.getByRole("checkbox", { name: "Pick HOO-413" }).check();
      await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
      const form = page.getByRole("form", { name: "Start agents" });
      await form.getByRole("button", { name: "Start 1 agent" }).click();

      // then the card follows the agent until its request waits in review
      await expect(page.getByRole("status").filter({ hasText: /started\./ })).toHaveText(/^1 agent started\./);
      await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();
      const issue = board.getByRole("listitem", { name: /^HOO-413 / });
      await expect(issue.getByRole("link", { name: /Agent (queued|working)|Request in review/ })).toBeVisible({ timeout: 60_000 });
      await expect(issue.getByRole("link", { name: "Request in review" })).toBeVisible({ timeout: 180_000 });

      // and the token reached neither the page nor the orchestrator's output, and nothing of the person's own ran but agent readiness asking a version
      expect(await page.content()).not.toContain(token);
      expect(solo.run.said()).not.toContain(token);
      expect(existsSync(join(root, "jira.log")) ? readFileSync(join(root, "jira.log"), "utf8") : "").not.toMatch(/ WRITE/);
      expect(solo.machine.trapped().filter((call) => call.args !== "--version")).toEqual([]);
    } finally {
      await solo.stop();
    }
  });

  test("given a clean machine with the person's gh signed in to GitHub and a project whose origin is a GitHub repository, when they open Work, pick an issue of its milestone and start its agent in another project of theirs, then the board is the milestone's issues as Open and Closed, the card shows its agent working and then its request in review, and gh was only asked to read", async ({ page }) => {
    test.setTimeout(600_000);
    // given a GitHub of the person's, reached through their gh alone
    const root = stamp("github");
    mkdirSync(root, { recursive: true });
    const port = await freePort();
    const forge = `http://127.0.0.1:${port}`;
    const token = `ghp_${randomBytes(12).toString("hex")}`;
    const server = await startFakeForge({
      kind: "github", port, token, root: join(root, "forge"), path: process.env.PATH ?? "", projects: [GITHUB_REPO], users: ["solo-person", "kai", "lee"], log: join(root, "forge.log"), scratch: root,
      issues: { [GITHUB_REPO]: GITHUB_ISSUES["initech/web-skills"]! }, milestones: { [GITHUB_REPO]: GITHUB_MILESTONES["initech/web-skills"]! },
    });
    const gh = ghStandIn(root, forge, token);
    const solo = await soloSession(page, root, gh.more);
    try {
      await solo.call("POST", "/api/projects", { path: githubProject(solo.machine) });
      const { project } = await solo.call<{ project: { id: string } }>("POST", "/api/projects", { path: personsRepository(solo.machine) });
      await page.goto(solo.base);
      await page.waitForURL(/\/activity$/);
      const org = new URL(page.url()).pathname.split("/")[1]!;

      // when they open Work
      await page.goto(`${solo.base}/${org}/work`);

      // then the board is the repository's open milestone, its issues Open or Closed
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(MILESTONE);
      const board = page.getByRole("group", { name: `${MILESTONE} board` });
      await expect(board.getByRole("heading", { level: 2 })).toHaveText([/^Open 3/, /^Closed 0/]);

      // when they pick an issue and start its agent in their other project
      await page.getByRole("checkbox", { name: `Pick ${GITHUB_REPO}#101` }).check();
      await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
      const form = page.getByRole("form", { name: "Start agents" });
      await form.getByRole("radio", { name: "Work in one repository" }).check();
      await form.getByRole("combobox", { name: "Repository" }).click();
      await page.getByRole("option", { name: "delivery-service" }).click();
      await form.getByRole("button", { name: "Start 1 agent" }).click();

      // then the card follows the agent until its request waits in review, in the project picked
      await expect(page.getByRole("status").filter({ hasText: /started\./ })).toHaveText(/^1 agent started\./);
      await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();
      const issue = board.getByRole("listitem", { name: new RegExp(`^${GITHUB_REPO}#101 `) });
      await expect(issue.getByRole("link", { name: /Agent (queued|working)|Request in review/ })).toBeVisible({ timeout: 60_000 });
      const { tasks } = await solo.call<{ tasks: { repoId: string; issueKey: string | null }[] }>("GET", "/api/tasks");
      expect(tasks.map((t) => [t.repoId, t.issueKey])).toEqual([[project.id, `${GITHUB_REPO}#101`]]);
      await expect(issue.getByRole("link", { name: "Request in review" })).toBeVisible({ timeout: 180_000 });

      // and gh was asked only whether it is signed in and to read, the lab's token reached nothing it shows, and nothing else of the person's ran
      expect(gh.asked().filter(([verb, what]) => !(verb === "auth" && what === "status") && verb !== "api")).toEqual([]);
      expect(await page.content()).not.toContain(token);
      expect(solo.run.said()).not.toContain(token);
      expect(solo.machine.trapped().filter((call) => call.args !== "--version")).toEqual([]);
    } finally {
      await solo.stop();
      server.close();
    }
  });

  test("given a clean machine with a folder of the person's that has no Git and their Jira, when they start an agent on an issue from the board and keep its changes, then the card says its changes wait for review and then that they are kept, never a request, and the folder still has no Git", async ({ page }) => {
    test.setTimeout(600_000);
    // given a folder with no Git as the person's one project, and their Jira read with their token
    const root = stamp("plain");
    const token = `jira-${randomBytes(12).toString("hex")}`;
    const port = await freePort();
    mkdirSync(root, { recursive: true });
    await startJira({ port, email: EMAIL, token, issues: [MULTI_REPO_ISSUE, ...SPRINT_ISSUES, ...BACKLOG_ISSUES], boards: [CUSTOMERS_BOARD], log: join(root, "jira.log") });
    const solo = await soloSession(page, root);
    try {
      const folder = plainFolder(solo.machine);
      await solo.call("POST", "/api/projects", { path: folder });
      await page.goto(solo.base);
      await page.waitForURL(/\/activity$/);
      const org = `${solo.base}/${new URL(page.url()).pathname.split("/")[1]!}`;
      await enterJiraToken(page, org, port, token);

      // when they start an agent on an issue from the board
      await page.goto(`${org}/work`);
      const board = page.getByRole("group", { name: `${SPRINT} board` });
      await page.getByRole("checkbox", { name: "Pick HOO-414" }).check();
      await page.getByRole("region", { name: "Picked issues" }).getByRole("button", { name: "Start agents" }).click();
      await page.getByRole("form", { name: "Start agents" }).getByRole("button", { name: "Start 1 agent" }).click();
      await expect(page.getByRole("status").filter({ hasText: /started\./ })).toHaveText(/^1 agent started\./);
      await page.getByRole("region", { name: /^Start agents/ }).getByRole("button", { name: /^Done( picking)?$/ }).click();

      // then the card says its changes wait for review, with no request
      const issue = board.getByRole("listitem", { name: /^HOO-414 / });
      await expect(issue.getByRole("link", { name: "Changes to review" })).toBeVisible({ timeout: 180_000 });
      await expect(issue.getByRole("link", { name: "Request in review" })).toHaveCount(0);
      const taskId = (await issue.getByRole("link", { name: "Changes to review" }).getAttribute("href"))!.split("/").pop()!;
      expect(existsSync(join(folder, "src", "endpoints", "return-label.ts"))).toBe(true);

      // when they keep the changes
      await solo.call("POST", `/api/tasks/${taskId}/keep`, { commandId: "keep-the-label-1" });
      await page.reload();

      // then the card says they are kept, and the folder still has no Git
      await expect(board.getByRole("listitem", { name: /^HOO-414 / }).getByRole("link", { name: "Changes kept" })).toBeVisible({ timeout: 60_000 });
      expect(existsSync(join(folder, ".git"))).toBe(false);
      expect(solo.machine.trapped().filter((call) => call.args !== "--version")).toEqual([]);
    } finally {
      await solo.stop();
    }
  });
});
