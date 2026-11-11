import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { folderRow, openFolder } from "./folder-picker.js";
import { overflows, THEMES } from "./layout.js";
import { stateFor } from "./roles.js";
import { PROMISE, PROMISE_CONNECTED } from "../web/src/words.js";

const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** The suite's orchestrator runs self-hosted; the welcome is what changes in the cloud, so the screen is told it runs there. */
async function inTheCloud(page: Page): Promise<void> {
  await page.route("**/api/me", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "cloud" } } });
  });
}

async function resetGuide(page: Page): Promise<void> {
  const { csrf } = await (await page.request.get("/api/me")).json();
  await page.request.put("/api/activity/onboarding", { data: { dismissed: false, marked: [], skipped: [] }, headers: { "x-csrf-token": csrf } });
}

type Connection = { connection: { via: "app"; account: string; by: string; at: string; repos: number; problem: string | null; manageUrl?: string } | null; available: boolean; missing: string[] };

/** The organization's forge connections as the forge endpoints answer them; GitLab is left unset up. */
async function forgeAnswers(page: Page, github: Connection): Promise<void> {
  await page.route("**/api/forge/gitlab/connection", (route) => route.fulfill({ json: { connection: null, available: false, missing: ["Set ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID."] } }));
  await page.route("**/api/forge/github/connection", (route) => route.fulfill({ json: github }));
}

const CONNECTED: Connection = { connection: { via: "app", account: "acme-builds", by: "ada@example.invalid", at: "2026-11-02T09:00:00.000Z", repos: 0, problem: null }, available: true, missing: [] };

test.describe("the welcome steps in the cloud", () => {
  test.afterEach(async ({ page }) => resetGuide(page));

  test("given the demo organization with a repository and teammates, when its owner goes through the welcome skipping the forge, then each step says what it does, a new repository's first commit is explained, and Team's setup shows what was left", async ({ page }) => {
    // given
    await inTheCloud(page);
    await page.goto("/demo/welcome");
    const step = page.getByRole("region", { name: /^Connect GitLab or GitHub/ });

    // then
    await expect(page.getByRole("heading", { level: 1, name: "Welcome to demo" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button")).toHaveText([/Connect GitLab or GitHub/, /Pick your team's skills repository.*done/, /Invite your team.*done/, /Start a task or connect Jira/]);
    await expect(page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Connect GitLab or GitHub/ })).toHaveAttribute("aria-current", "step");
    await expect(page.getByText(/Step \d of \d/)).toHaveCount(0);
    await expect(step).toContainText("Connect your team's repository with a token instead.");
    await expect(step.getByRole("form", { name: "Add a project" }).or(step.locator("form")).first()).toBeVisible();

    // when
    await step.getByRole("button", { name: "Skip for now" }).click();
    const repo = page.getByRole("region", { name: /^Pick your team's skills repository/ });
    await repo.getByLabel(/Create a new one/).check();

    // then
    await expect(page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Pick your team's skills repository/ })).toHaveAttribute("aria-current", "step");
    await expect(repo).toContainText("writes its first commit straight to it, because the repository is new and you asked for it");

    // when
    await repo.getByRole("button", { name: "Invite your team" }).click();
    await page.getByRole("region", { name: /^Invite your team/ }).getByRole("button", { name: /^Start a task or connect Jira$/ }).click();
    const start = page.getByRole("region", { name: /^Start a task or connect Jira/ });
    await expect(start.getByRole("link", { name: "Open Work" })).toHaveAttribute("href", "/demo/work");
    await expect(start.getByRole("link", { name: "Connect Jira" })).toHaveAttribute("href", "/demo/integrations?open=jira");
    // Whether the demo has run a task yet depends on the specs before this one; the step is done or left either way.
    await start.getByRole("button", { name: /^(Skip for now|Finish)$/ }).click();

    // then
    const done = page.getByRole("region", { name: "You are set up" });
    await expect(done.getByRole("listitem").nth(0)).toHaveText("Connect GitLab or GitHub");

    await expect(done.getByRole("link", { name: "Open Tasks" })).toHaveAttribute("href", "/demo/tasks");

    // when
    await page.goto("/demo/team");

    // then
    const guide = page.getByRole("region", { name: /^Getting set up/ });
    await expect(guide).toContainText(/Connect GitLab or GitHub\s+skipped/);
    await expect(guide).not.toContainText(/model key/i);
    const { events } = await (await page.request.get("/api/events?kind=onboarding")).json();
    expect(events.map((e: { detail: string }) => e.detail)).toContain("skipped forge");
  });

  test("given an owner on Tasks with no repository yet and every step done or left, when the welcome's last button is used, then the task list opens in place and the welcome does not come back", async ({ page }) => {
    // given
    await inTheCloud(page);
    const { csrf } = await (await page.request.get("/api/me")).json();
    await page.request.put("/api/activity/onboarding", { data: { skipped: ["forge", "repo", "members", "start"] }, headers: { "x-csrf-token": csrf } });
    await page.route(/\/api\/(orgs\/demo\/)?repos$/, (route) => (route.request().method() === "GET" ? route.fulfill({ json: { repos: [] } }) : route.fallback()));
    await page.goto("/demo/tasks");

    // when
    await page.getByRole("region", { name: "You are set up" }).getByRole("link", { name: "Open Tasks" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/tasks$/);
    await expect(page.getByRole("heading", { level: 1, name: "Tasks" })).toBeVisible();
    await expect(page.getByText("No repository is connected yet.")).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("ORCHESTRATOR_CONFIG");
    await expect(page.getByRole("link", { name: "welcome steps" })).toHaveAttribute("href", "/demo/welcome");
    await expect(page.getByRole("navigation", { name: "Welcome steps" })).toHaveCount(0);
  });

  test("given every step done or left, when the welcome opens again, then it opens on You are set up and its step list goes back to any step", async ({ page }) => {
    // given
    await inTheCloud(page);
    const { csrf } = await (await page.request.get("/api/me")).json();
    await page.request.put("/api/activity/onboarding", { data: { skipped: ["forge", "start"] }, headers: { "x-csrf-token": csrf } });

    // when
    await page.goto("/demo/welcome");

    // then
    const done = page.getByRole("region", { name: "You are set up" });
    await expect(done).toBeVisible();

    // when
    await page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Connect GitLab or GitHub/ }).click();

    // then
    await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ })).toBeVisible();
  });

  test("given GitHub's app set up and not yet connected, when the owner connects it, then the orchestrator asks GitHub to bring them back to the welcome", async ({ page }) => {
    // given
    await inTheCloud(page);
    await forgeAnswers(page, { connection: null, available: true, missing: [] });
    let asked: unknown = null;
    await page.route("**/api/forge/github/connect", async (route) => {
      asked = route.request().postDataJSON();
      await route.fulfill({ json: { authorizeUrl: "/demo/welcome?forge_problem=the%20installation%20was%20cancelled" } });
    });
    await page.goto("/demo/welcome");
    const step = page.getByRole("region", { name: /^Connect GitLab or GitHub/ });

    // when
    await step.getByRole("button", { name: "Connect GitHub" }).click();

    // then
    expect(asked).toEqual({ return: "welcome" });
    await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ }).getByRole("alert")).toHaveText("GitLab or GitHub did not connect: the installation was cancelled.");
    await expect(step.getByRole("button", { name: "Connect GitLab" })).toHaveCount(0);
  });

  test("given GitHub connected, when the owner picks repositories, then a repository with commits is connected, an empty one gets the scaffold, and the request names the team", async ({ page }) => {
    // given
    await inTheCloud(page);
    await forgeAnswers(page, CONNECTED);
    await page.route("**/api/forge/github/repos", (route) => route.fulfill({ json: { repos: [
      { fullName: "acme-builds/payments-skills", url: "https://github.com/acme-builds/payments-skills.git", connected: "payments-skills", empty: false },
      { fullName: "acme-builds/platform-skills", url: "https://github.com/acme-builds/platform-skills.git", connected: null, empty: false },
      { fullName: "acme-builds/fresh-skills", url: "https://github.com/acme-builds/fresh-skills.git", connected: null, empty: true },
    ] } }));
    const sent: { path: string; body: unknown }[] = [];
    for (const path of ["repos/connect", "team-repo"]) {
      await page.route(`**/api/forge/github/${path}`, async (route) => {
        const body = route.request().postDataJSON();
        sent.push({ path, body });
        await route.fulfill({ json: { repo: { id: "fresh", name: body.existing ? "fresh-skills" : "platform-skills", team: body.team, url: "https://github.com/x.git" }, webhook: "installed" } });
      });
    }
    await page.goto("/demo/welcome");
    await page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Pick your team's skills repository/ }).click();
    const step = page.getByRole("region", { name: /^Pick your team's skills repository/ });

    // then
    await expect(step.getByRole("radio", { name: /payments-skills/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ })).toHaveCount(0);

    // when
    await step.getByRole("radio", { name: "acme-builds/platform-skills" }).check();
    await step.getByLabel("Team").fill("Platform");
    await step.getByRole("button", { name: "Connect it" }).click();

    // then
    await expect(step.getByRole("status")).toHaveText("platform-skills is connected; every change to it opens as a request.");

    // when
    await step.getByRole("radio", { name: /acme-builds\/fresh-skills/ }).check();

    // then
    await expect(step).toContainText("This repository has no commits, so the orchestrator writes the scaffold straight to it as its first commit.");
    await expect(step).toContainText("A repository with even one commit is only ever changed through requests.");

    // when
    await step.getByRole("button", { name: "Set it up" }).click();

    // then
    await expect(step.getByRole("status")).toHaveText("fresh-skills had no commits, so the orchestrator wrote the scaffold as its first commit and connected it.");
    expect(sent).toEqual([
      { path: "repos/connect", body: { fullName: "acme-builds/platform-skills", team: "Platform" } },
      { path: "team-repo", body: { existing: "acme-builds/fresh-skills", team: "Platform" } },
    ]);
  });

  test("given GitHub connected to chosen repositories only and none listed, when the owner picks an existing one, then the screen says how to add one and offers reading the list again or creating one", async ({ page }) => {
    // given
    await inTheCloud(page);
    await forgeAnswers(page, { ...CONNECTED, connection: { ...CONNECTED.connection!, manageUrl: "https://github.com/settings/installations/7001" } });
    let reads = 0;
    await page.route("**/api/forge/github/repos", (route) => {
      reads += 1;
      return route.fulfill({ json: { repos: [] } });
    });
    await page.goto("/demo/welcome");
    await page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Pick your team's skills repository/ }).click();
    const step = page.getByRole("region", { name: /^Pick your team's skills repository/ });

    // then
    await expect(step).toContainText("GitHub lists no repository this connection reaches that is not connected already.");
    await expect(step).toContainText("add the team's repository to its installation on GitHub, then read the list again.");
    await expect(step.getByRole("link", { name: "Choose the repositories the GitHub app reaches" })).toHaveAttribute("href", "https://github.com/settings/installations/7001");

    // when
    await step.getByRole("button", { name: "Read the list again" }).click();
    await expect.poll(() => reads).toBe(2);
    await step.getByRole("button", { name: "Create a new one" }).click();

    // then
    await expect(step.getByLabel("Create a new one")).toBeChecked();
    await expect(step.getByLabel("Repository name")).toBeVisible();
  });

  test("given GitHub connected on a personal account, when the owner creates a new repository, then it is asked for as private and GitHub's refusal is shown as three steps", async ({ page }) => {
    // given
    await inTheCloud(page);
    await forgeAnswers(page, CONNECTED);
    let body: unknown = null;
    await page.route("**/api/forge/github/team-repo", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 409, json: { code: "team-repo", error: "the app is installed on acme-builds, a personal account, where GitHub lets only its owner create repositories: create an empty repository named payments-skills on GitHub without a README, add it to the app's installation, then pick it here as an existing empty repository" } });
    });
    await page.goto("/demo/welcome");
    await page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button", { name: /Pick your team's skills repository/ }).click();
    const step = page.getByRole("region", { name: /^Pick your team's skills repository/ });
    await step.getByLabel("Create a new one").check();

    // then
    await expect(step).toContainText("The orchestrator creates this repository on GitHub and writes its first commit straight to it.");
    await expect(step.getByLabel("Group (optional)")).toHaveCount(0);

    // when
    await step.getByLabel("Repository name").fill("payments-skills");
    await step.getByLabel("Team").fill("Payments");
    await step.getByRole("button", { name: "Create the repository" }).click();

    // then
    expect(body).toEqual({ name: "payments-skills", team: "Payments", visibility: "private" });
    await expect(step.getByRole("alert").getByRole("listitem")).toHaveText([
      "On GitHub, create an empty repository named payments-skills, without a README.",
      "Add it to the TeamHandbook Orchestrator app's installation on that account.",
      "Come back and pick it under Pick an existing repository; the orchestrator writes the scaffold as its first commit.",
    ]);
  });

  test("given a self-managed GitLab with no application from the operator, when the owner enters their own, then the screen gives the redirect address, sends the secret once and says which GitLab signs in", async ({ page }) => {
    // given
    await inTheCloud(page);
    let saved: { url: string; clientId: string; clientSecret: string } | null = null;
    await page.route("**/api/forge/gitlab/app", async (route) => {
      if (route.request().method() === "PUT") {
        saved = route.request().postDataJSON();
        return route.fulfill({ json: { app: { webUrl: "https://gitlab.acme.example.invalid", clientId: saved!.clientId, by: "Ada Admin", at: "2026-11-02T10:00:00.000Z" } } });
      }
      return route.fulfill({ json: saved
        ? { app: { webUrl: "https://gitlab.acme.example.invalid", clientId: saved.clientId, by: "Ada Admin", at: "2026-11-02T10:00:00.000Z" }, redirectUri: "http://127.0.0.1/integrations/forge/callback", operator: false }
        : { app: null, redirectUri: "http://127.0.0.1/integrations/forge/callback", operator: false } });
    });
    await page.goto("/demo/welcome");
    const step = page.getByRole("region", { name: /^Connect GitLab or GitHub/ });

    // when
    await step.getByText("Use your own GitLab").click();

    // then
    await expect(step.locator("code")).toHaveText("http://127.0.0.1/integrations/forge/callback");

    // when
    await step.getByLabel("GitLab address").fill("https://gitlab.acme.example.invalid");
    await step.getByLabel("Application ID").fill("app-id-0001");
    await step.getByLabel("Secret").fill("gloas-secret-for-tests");
    await step.getByRole("button", { name: "Save the application" }).click();

    // then
    expect(saved).toEqual({ url: "https://gitlab.acme.example.invalid", clientId: "app-id-0001", clientSecret: "gloas-secret-for-tests" });
    await expect(step).toContainText("GitLab signs in through your organization's own application at gitlab.acme.example.invalid, entered by Ada Admin.");
    await expect(step.getByLabel("Secret")).toHaveCount(0);
  });

  test.describe("for a member", () => {
    test.use({ storageState: stateFor("member") });

    test("given a member, when they open the welcome, then setting the organization up is left to an owner or an admin", async ({ page }) => {
      // given
      await inTheCloud(page);

      // when
      await page.goto("/demo/welcome");

      // then
      await expect(page.getByText("An owner or an admin sets the organization up; your first task starts on Tasks.")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Welcome steps" })).toHaveCount(0);
    });
  });

  for (const theme of THEMES) {
    for (const width of [1280, 390]) {
      test(`given the welcome at ${width} pixels in the ${theme} theme, when it is checked, then axe finds no violation and nothing spills or scrolls sideways`, async ({ page }) => {
        // given
        await page.emulateMedia({ colorScheme: theme });
        await page.setViewportSize({ width, height: 900 });
        await inTheCloud(page);
        await page.goto("/demo/welcome");
        await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ })).toBeVisible();

        // when
        const found = await new AxeBuilder({ page }).withTags(RULES).analyze();
        const spills = (await overflows(page)).map((o) => `${o.where} ${o.why}`);

        // then
        expect(found.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
        expect(spills).toEqual([]);
      });
    }
  }
});

test("given a team repository with skills, MCP servers and commands, when Team opens, then the handbook lists each tab's rows with their source, a picked row opens its text in the rail, and Update opens the editor", async ({ page }) => {
  // when
  await page.goto("/demo/team");

  // then
  const handbook = page.getByRole("region", { name: /^Team handbook/ });
  const tabs = handbook.getByRole("tablist", { name: "Team handbook" });
  await expect(tabs.getByRole("tab")).toHaveText(["Skills", "MCP servers", "Commands"]);
  await expect(tabs.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
  const first = handbook.getByRole("listitem").first();
  await expect(first).toContainText("from payments-skills");

  // when
  await tabs.getByRole("tab", { name: "MCP servers" }).click();

  // then
  await expect(tabs.getByRole("tab", { name: "MCP servers" })).toHaveAttribute("aria-selected", "true");

  // when
  await tabs.getByRole("tab", { name: "Skills" }).click();
  const name = (await first.getByRole("button").first().innerText()).trim();
  await first.getByRole("button").first().click();

  // then
  const rail = page.getByRole("complementary", { name: "The picked row" });
  await expect(rail.getByRole("heading", { name })).toBeVisible();
  await expect(rail.locator("pre.handbook-text")).not.toBeEmpty();

  // when
  await rail.getByRole("button", { name: "Update…" }).click();

  // then
  await expect(rail.getByLabel("SKILL.md")).toBeVisible();
});

test.describe("adding to the team handbook from one's own Claude Code", () => {
  const own = {
    available: true,
    skills: [{ name: "deploy-notes", description: "How a release goes out", inTeam: false, addable: true }, { name: "review-style", description: "", inTeam: true, addable: true }],
    mcpServers: [{ name: "gitlab", description: "", inTeam: false, addable: true }, { name: "vault", description: "", inTeam: false, addable: false, why: "holds a secret in its settings" }],
    commands: [],
  };

  test("given own items across the three tabs, when two are ticked and proposed, then the message is confirmed first, one request opens with them, and their rows say they are proposed", async ({ page }) => {
    // given
    const sent: Record<string, unknown>[] = [];
    await page.route((url) => url.pathname === "/api/handbook/own", (route) => route.fulfill({ json: own }));
    await page.route((url) => url.pathname.endsWith("/handbook/proposal"), (route) => {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { proposal: "Add deploy-notes and gitlab to the handbook", branch: "handbook/deploy-notes" } });
    });
    await page.route((url) => url.pathname.endsWith("/handbook") && url.pathname.startsWith("/api/repos/"), (route) => {
      sent.push(route.request().postDataJSON());
      return route.fulfill({ json: { request: { number: 12, url: "https://forge.example.invalid/team/payments-skills/-/merge_requests/12" } } });
    });
    await page.goto("/demo/team");
    const handbook = page.getByRole("region", { name: /^Team handbook/ });

    // when
    await handbook.getByRole("button", { name: "Add from your Claude Code" }).click();
    const tabs = handbook.getByRole("tablist", { name: "Your Claude Code" });

    // then
    await expect(handbook.getByRole("checkbox", { name: "deploy-notes" })).toBeVisible();
    await expect(handbook.getByText("in the team; ticking updates it from yours")).toBeVisible();
    await expect(handbook.getByRole("button", { name: "Tick what to propose" })).toBeDisabled();

    // when
    await handbook.getByRole("checkbox", { name: "deploy-notes" }).check();
    await tabs.getByRole("tab", { name: "MCP servers" }).click();

    // then
    await expect(handbook.getByRole("checkbox", { name: "vault" })).toBeDisabled();
    await expect(handbook.getByText("holds a secret in its settings")).toBeVisible();

    // when
    await handbook.getByRole("checkbox", { name: "gitlab" }).check();
    await handbook.getByRole("button", { name: "Propose 2 to the team" }).click();

    // then
    await expect(handbook.getByLabel("Commit message")).toHaveValue("Add deploy-notes and gitlab to the handbook");
    expect(sent[0]).toEqual({ skills: ["deploy-notes"], mcpServers: ["gitlab"], commands: [] });

    // when
    await handbook.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(handbook.getByRole("link", { name: "Proposed in !12" })).toBeVisible();
    expect(sent[1]).toMatchObject({ skills: ["deploy-notes"], mcpServers: ["gitlab"], message: "Add deploy-notes and gitlab to the handbook", branch: "handbook/deploy-notes" });
    expect(typeof sent[1]!.baseSha).toBe("string");
  });

  test("given a request that opened on a local copy with no web address, when the handbook lists its rows, then the row says it is proposed without a link", async ({ page }) => {
    // given
    await page.route((url) => url.pathname === "/api/handbook/own", (route) => route.fulfill({ json: { available: true, skills: [{ name: "on-call", description: "", inTeam: false, addable: true }], mcpServers: [], commands: [] } }));
    await page.route((url) => url.pathname.endsWith("/handbook/proposal"), (route) => route.fulfill({ json: { proposal: "Add on-call", branch: "handbook/on-call" } }));
    await page.route((url) => url.pathname.endsWith("/handbook") && url.pathname.startsWith("/api/repos/"), (route) => route.fulfill({ json: { request: { number: 1, url: "local://requests/payments-skills/1" } } }));
    await page.goto("/demo/team");
    const handbook = page.getByRole("region", { name: /^Team handbook/ });

    // when
    await handbook.getByRole("button", { name: "Add from your Claude Code" }).click();
    await handbook.getByRole("checkbox", { name: "on-call" }).check();
    await handbook.getByRole("button", { name: "Propose 1 to the team" }).click();
    await handbook.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(handbook.getByText("Proposed in !1, lands once merged")).toBeVisible();
    await expect(handbook.getByRole("link", { name: /Proposed in/ })).toHaveCount(0);
  });

  test("given an orchestrator that does not read the person's Claude Code, when Add is opened, then it says why and the list comes back on Close", async ({ page }) => {
    // given
    await page.goto("/demo/team");
    const handbook = page.getByRole("region", { name: /^Team handbook/ });

    // when
    await handbook.getByRole("button", { name: "Add from your Claude Code" }).click();

    // then
    await expect(handbook).toContainText("/handbook:share");

    // when
    await handbook.getByRole("button", { name: "Close" }).click();

    // then
    await expect(handbook.getByRole("tablist", { name: "Team handbook" })).toBeVisible();
  });
});

test("given a self-hosted orchestrator, when the welcome address is opened, then it walks the same steps a team's orchestrator in the cloud does", async ({ page }) => {
  // when
  await page.goto("/demo/welcome");

  // then
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to demo" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Welcome steps" }).getByRole("button")).toHaveText([/Connect GitLab or GitHub/, /Pick your team's skills repository/, /Invite your team/, /Start a task or connect Jira/]);
});

test.describe("the welcome on one person's machine", () => {
  async function onThisMachine(page: Page, ready: boolean): Promise<void> {
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
    });
    await page.route("**/api/tasks/options", async (route) => {
      // The page asks again while the check runs; a read still on its way when the test ends is dropped.
      const real = await route.fetch().then((r) => r.json()).catch(() => null);
      if (!real) return;
      await route.fulfill({ json: { ...real, agents: [{ id: "claude-code", label: "Claude Code", readiness: { ready, state: ready ? "ready" : "not-ready" } }] } }).catch(() => undefined);
    });
  }

  const HOME = "/Users/you";
  const shop = { id: "shop", name: "shop", team: "Mine", url: `${HOME}/code/shop`, kind: "code", facts: { git: "none", origin: null, name: "shop", kind: "code" } };

  async function projects(page: Page, listed: { projects: unknown[]; last: string | null; home?: string | null }): Promise<void> {
    await page.route((url) => url.pathname === "/api/projects", (route) =>
      route.request().method() === "POST" ? route.fulfill({ json: { existing: false, project: shop } }) : route.fulfill({ json: listed }));
    await page.route((url) => url.pathname === "/api/local/folders", (route) =>
      route.fulfill({ json: { under: HOME, parent: null, folders: [{ name: "shop", path: `${HOME}/code/shop`, git: "none", markers: ["package.json"] }], suggestions: [], truncated: false } }));
  }

  test("given a local orchestrator with no project yet, when the welcome opens, then it says what the orchestrator does over a folder picker with no steps, and a picked folder asks for the work on the same screen and Start opens the task", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await projects(page, { projects: [], last: null });
    let started: Record<string, unknown> | null = null;
    await page.route((url) => url.pathname === "/api/tasks", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      started = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { task: { id: "task-1" } } });
    });

    // when
    await page.goto("/demo/welcome");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROMISE);
    await expect(page.getByRole("navigation", { name: "Welcome steps" })).toHaveCount(0);
    await expect(page.getByText(/Step \d of \d|Invite your team|Connect GitLab or GitHub|Jira/)).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText(/repositor|request|branch/i);

    // when
    await openFolder(page.getByRole("group", { name: "Pick a folder" }), "shop");
    const box = page.getByRole("form", { name: "First task" });
    await box.getByLabel("What should the agent do here?").fill("Add a README that says how to run the shop");
    await box.getByRole("button", { name: "Start" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\/task-1$/);
    expect(started).toMatchObject({ repoId: "shop", agent: "claude-code", description: "Add a README that says how to run the shop" });
  });

  test("given a folder picked inside code, when Change is pressed in the task box, then the picker comes back in code, not at home", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await page.route((url) => url.pathname === "/api/projects", (route) =>
      route.request().method() === "POST" ? route.fulfill({ json: { existing: false, project: shop } }) : route.fulfill({ json: { projects: [], last: null, home: HOME } }));
    await page.route((url) => url.pathname === "/api/local/folders", (route) => {
      const under = new URL(route.request().url()).searchParams.get("under");
      return route.fulfill({ json: under === `${HOME}/code`
        ? { under, parent: HOME, folders: [{ name: "shop", path: `${HOME}/code/shop`, git: "none", markers: ["package.json"] }], suggestions: [], truncated: false }
        : { under: HOME, parent: null, folders: [{ name: "code", path: `${HOME}/code`, git: "none", markers: [] }], suggestions: [], truncated: false } });
    });
    await page.goto("/demo/welcome");
    const picker = page.getByRole("group", { name: "Pick a folder" });
    await picker.locator("button.folder-row").filter({ hasText: "code" }).click();
    await openFolder(picker, "shop");

    // when
    await page.getByRole("form", { name: "First task" }).getByRole("button", { name: "Pick another folder" }).click();

    // then
    await expect(picker.locator(".folder-at")).toHaveText("~/code");
    await expect(folderRow(picker, "shop")).toBeVisible();
  });

  test("given a local orchestrator with a project opened before, when the welcome opens, then that project is picked with the task box open, its folder shown from home, and Change goes back to the picker", async ({ page }) => {
    // given
    await onThisMachine(page, false);
    await projects(page, { projects: [shop], last: "shop", home: HOME });

    // when
    await page.goto("/demo/welcome");

    // then
    const box = page.getByRole("form", { name: "First task" });
    await expect(box).toContainText("~/code/shop");
    await expect(box).not.toContainText(HOME);
    await expect(box.getByRole("status")).toContainText(/^Claude Code is not (ready yet|signed in)[.;]/);
    await expect(box.getByRole("button", { name: "Check again" })).toHaveClass(/secondary/);
    await expect(page.getByRole("group", { name: "Pick a folder" })).toHaveCount(0);

    // when
    await box.getByRole("button", { name: "Pick another folder" }).click();

    // then
    await expect(page.getByRole("group", { name: "Pick a folder" })).toBeVisible();
  });

  test("given a folder that is no repository but holds some, when the welcome lists it, then its row counts them and, once it is focused, the picker's foot says each one a task changes gets its own branch", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await page.route((url) => url.pathname === "/api/projects", (route) => route.fulfill({ json: { projects: [], last: null } }));
    await page.route((url) => url.pathname === "/api/local/folders", (route) =>
      route.fulfill({ json: { under: HOME, parent: null, folders: [{ name: "code", path: `${HOME}/code`, git: "none", markers: [], repos: 3 }, { name: "notes", path: `${HOME}/notes`, git: "none", markers: [] }], suggestions: [], truncated: false } }));

    // when
    await page.goto("/demo/welcome");

    // then
    const picker = page.getByRole("group", { name: "Pick a folder" });
    await expect(folderRow(picker, "code")).toContainText("3 repositories");
    await expect(folderRow(picker, "notes")).toContainText("No Git");
    await folderRow(picker, "code").focus();
    await expect(picker.locator(".folder-picker-foot")).toContainText("A folder of 3 repositories: each task works on its own branch of each one it changes");
  });

  test("given a project folder that holds repositories, when its first task box opens, then it does not say the files are edited in place", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await projects(page, { projects: [{ ...shop, facts: { ...shop.facts, repos: 3 } }], last: "shop", home: HOME });

    // when
    await page.goto("/demo/welcome");

    // then
    const box = page.getByRole("form", { name: "First task" });
    await expect(box).toBeVisible();
    await expect(box).not.toContainText("edits these files in place");
  });

  test("given a local orchestrator with no team repository, when Team opens, then the handbook is the person's own setup in one sentence with the list folded, and Share with a team offers the two commands, and no section without rows is drawn", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    const personal = { commands: [{ name: "deploy", description: "" }, { name: "review", description: "" }], plugins: [], mcpServers: [{ name: "gitlab", kind: "stdio", asksForValue: false }], claudeMd: true, readAt: new Date().toISOString() };
    await page.route("**/api/tasks/options", (route) => route.fulfill({ json: { agents: [{ id: "claude-code", label: "Claude Code", readiness: { ready: true, state: "ready" }, personal }], repos: [], readinessReport: true, profile: { personal: false } } }));
    await page.route("**/api/lessons", (route) => route.fulfill({ json: { candidates: [] } }));
    await page.route((url) => url.pathname === "/api/repos", (route) => route.fulfill({ json: { repos: [] } }));
    await page.route("**/api/activity/summary", async (route) => {
      const real = await route.fetch().then((r) => r.json()).catch(() => null);
      if (!real) return;
      await route.fulfill({ json: { ...real, repos: 1, tasks: { ...real.tasks, total: 1 } } }).catch(() => undefined);
    });

    // when
    await page.goto("/demo/team");

    // then
    const handbook = page.getByRole("region", { name: /^Team handbook/ });
    await expect(handbook).toContainText("Your Claude Code loads 2 skills, 1 MCP server, a CLAUDE.md; tasks here use them.");
    await expect(handbook.getByRole("listitem").first()).toBeHidden();
    await expect(page.getByRole("region", { name: /^Lessons to review/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Getting set up/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /Control templates/ })).toBeVisible();
    await expect(page.getByText("To work with others, run the orchestrator on a server for the team")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Tasks by person/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Invite members" })).toHaveCount(0);

    // when
    await handbook.getByText("Show them").click();

    // then
    await expect(handbook.getByText("gitlab")).toBeVisible();

    // when
    await handbook.getByRole("button", { name: "Share with a team" }).click();

    // then
    await expect(handbook).toContainText("/handbook:init");
    await expect(handbook).toContainText("/handbook:join");
  });

  test("given a local orchestrator whose Claude Code was not read and no team repository, when Team opens, then the handbook is still there, says it loads nothing yet and offers Share with a team", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await page.route("**/api/tasks/options", (route) => route.fulfill({ json: { agents: [{ id: "claude-code", label: "Claude Code", readiness: { ready: true, state: "ready" } }], repos: [], readinessReport: true, profile: { personal: false } } }));
    await page.route((url) => url.pathname === "/api/repos", (route) => route.fulfill({ json: { repos: [] } }));

    // when
    await page.goto("/demo/team");

    // then
    const handbook = page.getByRole("region", { name: /^Team handbook/ });
    await expect(handbook).toContainText("Your Claude Code loads nothing of its own yet");

    // when
    await handbook.getByRole("button", { name: "Share with a team" }).click();

    // then
    await expect(handbook).toContainText("/handbook:init");
    await expect(handbook).toContainText("/handbook:join");
  });

  test("given a local orchestrator with everything set up, when Team opens, then Getting set up is not drawn", async ({ page }) => {
    // given
    await onThisMachine(page, true);
    await page.route("**/api/activity/summary", async (route) => {
      const real = await route.fetch().then((r) => r.json()).catch(() => null);
      if (!real) return;
      await route.fulfill({ json: { ...real, repos: 1, tasks: { ...real.tasks, total: 1 } } }).catch(() => undefined);
    });

    // when
    await page.goto("/demo/team");
    await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();

    // then
    await expect(page.getByRole("region", { name: /^Getting set up/ })).toHaveCount(0);
  });

  test("given a local orchestrator, when a new policy is opened, then the page is there and offers the rules on the tasks it runs and none that reach teammates", async ({ page }) => {
    // given
    await onThisMachine(page, true);

    // when
    await page.goto("/demo/team/policies/new");

    // then
    const blocks = page.getByRole("navigation", { name: "Add a rule" });
    await expect(blocks.getByRole("button", { name: "Task budget", exact: true })).toBeVisible();
    for (const name of ["Skills", "MCP servers", "Tools"]) await expect(blocks.getByRole("button", { name, exact: true })).toHaveCount(0);
  });
});

test.describe("the welcome where tasks run on people's own machines", () => {
  async function machineFirst(page: Page, tasksRunHere: boolean, mode: "cloud" | "self-hosted" = "cloud"): Promise<void> {
    await page.route("**/api/me", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode, runners: true, tasksRunHere } } });
    });
  }
  const command = (code: string) => `handbook-orchestrator runner connect https://orchestrator.example.invalid ${code}`;

  async function noProjects(page: Page): Promise<void> {
    await page.route((url) => url.pathname === "/api/projects", (route) =>
      route.request().method() === "POST" ? route.fallback() : route.fulfill({ json: { projects: [], last: null, home: null } }));
  }

  test("given no computer of theirs connected, when the welcome opens, then it shows the one command to copy, and once the computer comes online the same screen lists that computer's folders and a picked one asks for the work", async ({ page }) => {
    // given
    await machineFirst(page, false);
    await noProjects(page);
    let reads = 0;
    await page.route("**/api/machines", (route) => {
      reads += 1;
      return route.fulfill({ json: { machines: reads < 3 ? [] : [{ id: "m1", name: "ada-laptop", online: true }] } });
    });
    let pairs = 0;
    await page.route("**/api/machines/pair", (route) => {
      pairs += 1;
      return route.fulfill({ json: { code: "K7Q-2M4", expiresAt: new Date(Date.now() + 600_000).toISOString(), command: command("K7Q-2M4") } });
    });
    await page.route((url) => url.pathname === "/api/machines/m1/folders", (route) =>
      route.fulfill({ json: { under: "~", parent: null, folders: [{ name: "shop", path: "~/code/shop", git: "repo", markers: [".git"] }], suggestions: [], truncated: false } }));
    let opened: Record<string, unknown> | null = null;
    await page.route((url) => url.pathname === "/api/projects", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      opened = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { existing: false, project: { id: "shop", name: "shop", team: "Mine", url: "~/code/shop", kind: "code", facts: { git: "repo", origin: null, name: "shop", kind: "code" }, machine: { id: "m1", path: "~/code/shop" } } } });
    });

    // when
    await page.goto("/demo/welcome");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROMISE_CONNECTED);
    const panel = page.getByRole("region", { name: "Connect this computer" });
    await expect(panel).toContainText(command("K7Q-2M4"));
    await expect(panel.getByRole("button", { name: "Copy the command" })).toBeVisible();
    const picker = page.getByRole("group", { name: "Pick a folder" });
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("status").filter({ hasText: "ada-laptop is connected; pick a folder on it." })).toBeVisible();
    await expect(picker).toContainText("On ada-laptop");
    await expect(panel).toHaveCount(0);
    expect(pairs).toBe(1);

    // when
    await openFolder(picker, "shop");

    // then
    expect(opened).toEqual({ path: "~/code/shop", machineId: "m1" });
    await expect(page.getByRole("form", { name: "First task" })).toContainText("shop");
  });

  test("given a computer that reports its agents only after it comes online, when its first task starts, then the box waits for them and the task goes to the agent that computer runs", async ({ page }) => {
    // given
    await machineFirst(page, false);
    await noProjects(page);
    let reads = 0;
    const opencode = { id: "opencode", label: "OpenCode", installed: true, version: "1.0.0", supported: "ok", signIn: "signed-in", signInCommand: null };
    await page.route("**/api/machines", (route) => {
      reads += 1;
      return route.fulfill({ json: { machines: [{ id: "m1", name: "ada-laptop", online: true, agents: reads < 3 ? [] : [opencode] }] } });
    });
    await page.route((url) => url.pathname === "/api/machines/m1/folders", (route) =>
      route.fulfill({ json: { under: "~", parent: null, folders: [{ name: "shop", path: "~/code/shop", git: "repo", markers: [".git"] }], suggestions: [], truncated: false } }));
    await page.route((url) => url.pathname === "/api/projects", (route) =>
      route.request().method() === "POST" ? route.fulfill({ json: { existing: false, project: { id: "shop", name: "shop", team: "Mine", url: "~/code/shop", kind: "code", facts: { git: "repo", origin: null, name: "shop", kind: "code" }, machine: { id: "m1", path: "~/code/shop" } } } }) : route.fallback());
    let started: Record<string, unknown> | null = null;
    await page.route((url) => url.pathname === "/api/tasks", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      started = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({ json: { task: { id: "task-1" } } });
    });
    await page.goto("/demo/welcome");
    await openFolder(page.getByRole("group", { name: "Pick a folder" }), "shop");
    const box = page.getByRole("form", { name: "First task" });

    // then
    await expect(box.getByRole("status").filter({ hasText: "Your computer runs no agent for tasks yet" })).toBeVisible();

    // when
    await box.getByLabel("What should the agent do here?").fill("Add a README that says how to run the shop");
    await box.getByRole("button", { name: "Start" }).click({ timeout: 15_000 });

    // then
    await expect(page).toHaveURL(/\/demo\/tasks\/task-1$/);
    expect(started).toMatchObject({ repoId: "shop", agent: "opencode" });
  });

  test("given a computer that has gone offline, when its folders are read, then the picker says so in the server's words", async ({ page }) => {
    // given
    await machineFirst(page, false);
    await noProjects(page);
    await page.route("**/api/machines", (route) => route.fulfill({ json: { machines: [{ id: "m1", name: "ada-laptop", online: true }] } }));
    await page.route((url) => url.pathname === "/api/machines/m1/folders", (route) =>
      route.fulfill({ status: 409, json: { error: "ada-laptop is offline; start it again with the command on this page", code: "machine-offline" } }));

    // when
    await page.goto("/demo/welcome");

    // then
    await expect(page.getByRole("group", { name: "Pick a folder" }).getByRole("alert")).toContainText("ada-laptop is offline");
  });

  test("given a command shown and no computer coming online, when half a minute passes, then the screen says where to look instead of only waiting", async ({ page }) => {
    // given
    await page.clock.install();
    await machineFirst(page, false);
    await noProjects(page);
    await page.route("**/api/machines", (route) => route.fulfill({ json: { machines: [] } }));
    await page.route("**/api/machines/pair", (route) => route.fulfill({ json: { code: "K7Q-2M4", expiresAt: new Date(Date.now() + 600_000).toISOString(), command: command("K7Q-2M4") } }));
    await page.goto("/demo/welcome");
    const panel = page.getByRole("region", { name: "Connect this computer" });
    await expect(panel.getByRole("status")).toHaveText("Waiting for this computer…");

    // when
    await page.clock.fastForward(31_000);

    // then
    await expect(panel.getByRole("status")).toHaveText("This computer has not connected yet; the terminal where you ran the command says why.");
  });

  test("given a code that has run out, when the screen reads the machines again, then it asks for a new one with no click", async ({ page }) => {
    // given
    await machineFirst(page, false);
    await page.route("**/api/machines", (route) => route.fulfill({ json: { machines: [] } }));
    let pairs = 0;
    await page.route("**/api/machines/pair", (route) => {
      pairs += 1;
      const code = pairs === 1 ? "OLD-0001" : "NEW-0002";
      return route.fulfill({ json: { code, expiresAt: new Date(Date.now() + (pairs === 1 ? -1_000 : 600_000)).toISOString(), command: command(code) } });
    });

    // when
    await page.goto("/demo/welcome");

    // then
    const panel = page.getByRole("region", { name: "Connect this computer" });
    await expect(panel).toContainText(command("NEW-0002"), { timeout: 15_000 });
    expect(pairs).toBe(2);
  });

  test("given a self-hosted orchestrator whose tasks run on people's machines, when the welcome opens, then it is the same first screen asking for this computer", async ({ page }) => {
    // given
    await machineFirst(page, false, "self-hosted");
    await noProjects(page);
    await page.route("**/api/machines", (route) => route.fulfill({ json: { machines: [] } }));
    await page.route("**/api/machines/pair", (route) => route.fulfill({ json: { code: "K7Q-2M4", expiresAt: new Date(Date.now() + 600_000).toISOString(), command: command("K7Q-2M4") } }));

    // when
    await page.goto("/demo/welcome");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(PROMISE_CONNECTED);
    await expect(page.getByRole("region", { name: "Connect this computer" })).toContainText(command("K7Q-2M4"));
  });

  test("given an owner whose first screen is this computer, when Get started sends them to set up GitLab or GitHub, or the forge brings them back, then they get that step instead of this computer", async ({ page }) => {
    // given
    await machineFirst(page, false);

    // when
    await page.goto("/demo/welcome?step=forge");

    // then
    await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "Connect this computer" })).toHaveCount(0);

    // when
    await page.goto("/demo/welcome?forge_problem=the%20sign-in%20was%20cancelled");

    // then
    await expect(page.getByRole("region", { name: /^Connect GitLab or GitHub/ })).toContainText("the sign-in was cancelled");
  });

  test("given a team's server that runs tasks itself, when the welcome opens, then no computer is asked for", async ({ page }) => {
    // given
    await machineFirst(page, true);
    let pairs = 0;
    await page.route("**/api/machines/pair", (route) => {
      pairs += 1;
      return route.fulfill({ status: 500, json: { error: "not expected" } });
    });

    // when
    await page.goto("/demo/welcome");

    // then
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to demo");
    await expect(page.getByRole("region", { name: "Connect this computer" })).toHaveCount(0);
    expect(pairs).toBe(0);
  });
});
