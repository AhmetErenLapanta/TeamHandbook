import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { hostedPayments, openForgeCard } from "./hosted-forge.js";
import { stateFor } from "./roles.js";

// What each screen says when there is nothing to show or its answer did not come: a sentence
// and the next step, never a "Loading" that stays. The orchestrator's answers are replaced in the
// browser, so each case is the one screen the test is about and the orchestrator itself is left as
// it is for the specs after this one.

const FAILED = "The orchestrator failed to answer (500 Internal Server Error). Try again; when it keeps failing, the orchestrator's log says why.";

const failWith500 = (route: Route) => route.fulfill({ status: 500, contentType: "text/plain", body: "Internal Server Error" });

/** The real answer, with the payments repository's record changed the way `change` says. */
async function paymentsRecord(page: Page, change: Record<string, unknown>) {
  await page.route("**/api/repos", async (route) => {
    const body = await (await route.fetch()).json();
    body.repos = body.repos.map((r: { id: string }) => (r.id === "payments-skills" ? { ...r, ...change } : r));
    await route.fulfill({ json: body });
  });
}

async function lastSyncFailed(page: Page, error: string) {
  await page.route("**/api/repos/payments-skills/inventory", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, repo: { ...body.repo, error } } });
  });
}

const visibleLoading = (page: Page) => page.getByText(/Loading/).filter({ visible: true });

test.describe("the keyboard", () => {
  test("given a repository, when it is used with Tab and Enter alone, then a skill's history opens and the focused control shows a ring", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/skills");
    await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();

    // when
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.textContent === "add-ledger-migration");
    }
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!);
      return `${style.outlineStyle} ${style.outlineWidth}`;
    });
    await page.keyboard.press("Enter");

    // then
    expect(reached).toBe(true);
    expect(ring).toBe("solid 2px");
    await expect(page.getByRole("heading", { name: /History/ })).toContainText("skills/add-ledger-migration");
    await expect(page.getByRole("button", { name: "add-ledger-migration" })).toHaveAttribute("aria-pressed", "true");
  });

  test("given a repository, when a slash command is chosen with Space, then its history opens", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/commands");

    // when
    await page.getByRole("button", { name: "/deploy-check", exact: true }).focus();
    await page.keyboard.press("Space");

    // then
    await expect(page.getByRole("heading", { name: /History/ })).toContainText("commands/deploy-check.md");
  });

  test("given a repository, when an MCP server is chosen with Enter, then the history of .mcp.json opens", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/mcp");

    // when
    await page.getByRole("button", { name: "postgres" }).focus();
    await page.keyboard.press("Enter");

    // then
    await expect(page.getByRole("heading", { name: /History/ })).toContainText(".mcp.json");
    await expect(page.getByRole("button", { name: "postgres" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("a form's refusal", () => {
  test("given a wrong password, when sign-in is refused, then both fields are described by the refusal", async ({ browser }) => {
    // given
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto("/");
    await page.getByLabel("Email").fill("ada@example.invalid");
    await page.getByLabel("Password").fill("not the password at all");

    // when
    await page.getByRole("button", { name: "Sign in" }).click();

    // then
    const refusal = (await page.getByRole("alert").textContent())!;
    expect(refusal.length).toBeGreaterThan(0);
    await expect(page.getByLabel("Email")).toHaveAccessibleDescription(refusal);
    await expect(page.getByLabel("Password")).toHaveAccessibleDescription(refusal);
    await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
    await context.close();
  });

  test("given a skill name the orchestrator refuses, when the change is reviewed, then the fields are described by the refusal", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/skills");
    await page.getByRole("button", { name: "Add a skill" }).click();
    await page.getByLabel("Skill name").fill("Not A Valid Name");

    // when
    await page.getByRole("button", { name: "Review the new skill" }).click();

    // then
    const refusal = (await page.getByRole("alert").textContent())!;
    expect(refusal.length).toBeGreaterThan(0);
    await expect(page.getByLabel("Skill name")).toHaveAccessibleDescription(refusal);
    await expect(page.getByLabel("SKILL.md")).toHaveAccessibleDescription(refusal);
  });

  test("given a forge that refuses the token, when forge access is saved, then its fields are described by the refusal", async ({ page }) => {
    // given
    await hostedPayments(page, "the forge refused this token: 401 Unauthorized");
    await openForgeCard(page);
    const form = page.getByRole("form", { name: "Forge access" });
    await form.getByLabel("Project").fill("payments/skills");
    await form.getByLabel("Token").fill("glpat-not-a-real-token-000");

    // when
    await form.getByRole("button", { name: "Save" }).click();

    // then
    await expect(form.getByRole("alert")).toHaveText("The forge refused this token: 401 Unauthorized.");
    await expect(form.getByLabel("Project")).toHaveAccessibleDescription("The forge refused this token: 401 Unauthorized.");
    await expect(form.getByLabel("Token")).toHaveAccessibleDescription("The forge refused this token: 401 Unauthorized.");
    await expect(form.getByLabel("Token")).toHaveValue("");
  });

  test("given an invitation the orchestrator refuses, when it is sent, then the addresses and the role are described by the refusal", async ({ page }) => {
    // given
    await page.goto("/demo/settings/members");
    await page.getByRole("button", { name: "Invite members" }).click();
    const form = page.getByRole("form", { name: "Invite members" });
    await form.getByLabel("Emails").fill("not-an-address");

    // when
    await form.getByRole("button", { name: "Create invitation links" }).click();

    // then
    const refusal = (await form.getByRole("alert").textContent())!;
    expect(refusal).toBe("Enter a valid email address.");
    await expect(form.getByLabel("Emails")).toHaveAccessibleDescription(`Separate addresses with spaces, commas or new lines. ${refusal}`);
    await expect(form.getByRole("radio", { name: "Member" })).toHaveAccessibleDescription(refusal);
  });
});

test.describe("when the orchestrator does not answer", () => {
  test("given the connection is dropped at start, when the orchestrator opens, then it says so and Retry connecting brings it up", async ({ page }) => {
    // given
    await page.route("**/api/me", (route) => route.abort());

    // when
    await page.goto("/");

    // then
    await expect(page.getByRole("alert")).toContainText("The orchestrator did not answer. Check that it is running and reachable from here, then try again.");

    // when the orchestrator answers again
    await page.unroute("**/api/me");
    await page.getByRole("button", { name: "Retry connecting" }).click();

    // then
    await expect(page.getByRole("navigation", { name: "Orchestrator" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tasks");
  });

  test("given a repository's answer fails with a 500, when it is opened, then the screen names what did not load and its Retry loads it", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/inventory", failWith500);

    // when
    await page.goto("/demo/repositories/payments-skills/skills");

    // then
    await expect(page.getByRole("alert")).toContainText(`Couldn't load payments-skills. ${FAILED}`);
    await expect(visibleLoading(page)).toHaveCount(0);

    // when the orchestrator answers again
    await page.unroute("**/api/repos/payments-skills/inventory");
    await page.getByRole("button", { name: "Retry payments-skills" }).click();

    // then
    await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();
  });

  test("given every request fails, when a repository's Requests opens, then it says so instead of loading, and Try again lists them", async ({ page }) => {
    // given
    const all = (url: URL) => url.pathname === "/api/requests";
    await page.route(all, failWith500);

    // when
    await page.goto("/demo/repositories/payments-skills/requests");

    // then
    await expect(page.getByRole("alert")).toContainText(`Couldn't load requests. ${FAILED}`);
    await expect(visibleLoading(page)).toHaveCount(0);

    // when the orchestrator answers again
    await page.unroute(all);
    await page.getByRole("button", { name: "Retry requests" }).click();

    // then
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("region", { name: /Requests from the orchestrator/ }).getByText(/No request opened from the orchestrator yet|awaiting review/).first()).toBeVisible();
  });

  test("given a repository's requests fail, when it is opened, then the requests section says they did not load rather than that there are none", async ({ page }) => {
    // given
    await page.route((url) => url.pathname === "/api/requests" && url.searchParams.get("repo") === "payments-skills", failWith500);

    // when
    await page.goto("/demo/repositories/payments-skills/requests");

    // then
    const section = page.getByRole("region", { name: /Requests from the orchestrator/ });
    await expect(section).toContainText(`Couldn't load requests. ${FAILED}`);
    await expect(section).not.toContainText("No request opened");
  });

  test("given the history fails, when a skill is chosen, then the history says it did not load rather than that no commit touches it", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/history**", failWith500);
    await page.goto("/demo/repositories/payments-skills/skills");

    // when
    await page.getByRole("button", { name: "add-ledger-migration" }).click();

    // then
    const history = page.getByRole("region", { name: /History/ });
    await expect(history).toContainText(`Couldn't load the history. ${FAILED}`);
    await expect(history).not.toContainText("No commits touch this path.");
  });

  test("given a skill's text fails to load, when Edit is pressed, then no empty editor is offered", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/skills/add-ledger-migration", failWith500);
    await page.goto("/demo/repositories/payments-skills/skills");

    // when
    await page.getByRole("row").filter({ hasText: "add-ledger-migration" }).getByRole("button", { name: "Edit" }).click();

    // then
    await expect(page.getByRole("alert")).toContainText("add-ledger-migration did not load, so it cannot be edited now.");
    await expect(page.getByLabel("SKILL.md")).toHaveCount(0);
  });
});

test.describe("a repository whose sync failed", () => {
  test("given a repository the orchestrator never read, when an admin opens it, then the reason shows with Sync again, which reads it once the remote answers", async ({ page }) => {
    // given
    await paymentsRecord(page, { head: null, error: "fatal: could not read from the remote repository" });
    await page.route("**/api/repos/payments-skills/inventory", (route) => route.fulfill({ status: 409, json: { error: "fatal: could not read from the remote repository" } }));
    await page.route("**/api/repos/payments-skills/sync", (route) => route.fulfill({ status: 502, json: { error: "fatal: the remote end hung up" } }));
    await page.goto("/demo/repositories/payments-skills/skills");
    await expect(page.getByRole("alert")).toContainText("The orchestrator has not read this repository yet. fatal: could not read from the remote repository");

    // when the sync fails again
    await page.getByRole("button", { name: "Sync again" }).click();

    // then
    await expect(page.getByRole("alert")).toContainText("fatal: the remote end hung up");

    // when the remote answers
    await page.unrouteAll();
    await page.getByRole("button", { name: "Sync again" }).click();

    // then
    await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync again" })).toHaveCount(0);
  });

  test("given the last sync failed, when an admin opens the repository, then what the orchestrator last read shows under the reason", async ({ page }) => {
    // given
    await lastSyncFailed(page, "fatal: the remote end hung up");

    // when
    await page.goto("/demo/repositories/payments-skills/skills");

    // then
    await expect(page.getByRole("alert")).toContainText("The last sync failed; this page shows the project as the orchestrator last read it. fatal: the remote end hung up");
    await expect(page.getByRole("button", { name: "Sync again" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "add-ledger-migration" })).toBeVisible();
  });

  test.describe("for a member", () => {
    test.use({ storageState: stateFor("member") });

    test("given the last sync failed, when a member opens the repository, then they are told who can sync it and offered no button", async ({ page }) => {
      // given
      await lastSyncFailed(page, "fatal: the remote end hung up");

      // when
      await page.goto("/demo/repositories/payments-skills");

      // then
      await expect(page.getByRole("alert")).toContainText("An admin or an owner of Payments can sync it again.");
      await expect(page.getByRole("button", { name: "Sync again" })).toHaveCount(0);
    });
  });
});

test.describe("nothing to show yet", () => {
  test("given no repository is connected, when its owner opens the orchestrator, then Tasks opens the setup steps, the same on a team's server whoever runs it", async ({ page }) => {
    // given
    await page.route("**/api/repos", (route) => route.fulfill({ json: { repos: [] } }));

    // when
    await page.goto("/demo");

    // then Tasks opens the setup steps, with no word of how the server is run
    await expect(page).toHaveURL(/\/demo\/tasks$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome to demo");
    await expect(page.getByText(/ORCHESTRATOR_CONFIG/)).toHaveCount(0);
  });

  test("given no request was opened, when a repository's Requests opens, then it says where one comes from", async ({ page }) => {
    // given
    await page.route((url) => url.pathname === "/api/requests", (route) => route.fulfill({ json: { requests: [] } }));

    // when
    await page.goto("/demo/repositories/payments-skills/requests");

    // then
    await expect(page.getByText("No request opened from the orchestrator yet", { exact: true })).toBeVisible();
    await expect(page.getByText("A change proposed on a repository's page, or a task's result, opens one here.")).toBeVisible();
    // On the repository's own page a change is proposed from its tabs, so the list links nowhere else.
    await expect(page.getByRole("link", { name: "Propose your first change" })).toHaveCount(0);
    await expect(visibleLoading(page)).toHaveCount(0);
  });

  test("given a path no commit touches, when it is chosen, then the history says so", async ({ page }) => {
    // given
    await page.route("**/api/repos/payments-skills/history**", (route) => route.fulfill({ json: { history: [] } }));
    await page.goto("/demo/repositories/payments-skills/skills");

    // when
    await page.getByRole("button", { name: "add-ledger-migration" }).click();

    // then
    await expect(page.getByRole("region", { name: /History/ })).toContainText("No commits touch this path.");
  });
});
