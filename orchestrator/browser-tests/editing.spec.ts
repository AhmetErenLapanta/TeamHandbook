import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { openTab } from "./repo-tabs.js";
import { stateFor } from "./roles.js";

const LITERAL = "sk-live-9f8e7d6c5b4a39281706AbCd";

async function headOf(request: APIRequestContext, repo: string): Promise<string> {
  const { repos } = await (await request.get("/api/repos")).json();
  return repos.find((r: { id: string }) => r.id === repo).head;
}

/** A change sent the way the page sends it, CSRF token included, so a refusal can only be the role check. */
async function proposeDirectly(request: APIRequestContext, repo: string, slug: string) {
  const { csrf } = await (await request.get("/api/me")).json();
  return request.post(`/api/repos/${repo}/changes`, {
    headers: { "x-csrf-token": csrf },
    data: {
      baseSha: await headOf(request, repo),
      message: `feat(skill): add ${slug}`,
      change: { kind: "skill.add", slug, content: `---\nname: ${slug}\ndescription: Use when testing who may edit.\n---\n\nBody.\n` },
    },
  });
}

async function allFieldValues(page: Page): Promise<string> {
  return page.locator("input, textarea").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value).join("\n"));
}

test.describe("a team owner editing a skill", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given the Payments owner, when they edit a skill and confirm the message, then a local request opens awaiting review, and merging it lands the edit", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/skills");
    await page.getByRole("row", { name: /^release-checklist/ }).getByRole("button", { name: "Edit" }).click();
    const skill = page.getByLabel("SKILL.md");
    await expect(skill).toHaveValue(/name: release-checklist/);

    // when
    await skill.fill((await skill.inputValue()) + "- Status page updated\n");
    await page.getByRole("button", { name: "Review the edit" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY feat(skill): update release-checklist");
    await expect(page.getByLabel("Branch")).toHaveValue(/^handbook\/orchestrator-skill-release-checklist-[0-9a-f]{6}$/);
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: /Request #\d+ opened/ })).toContainText(/Request #\d+ opened on handbook\/orchestrator-skill-release-checklist-/, { timeout: 30_000 });
    await openTab(page, "payments-skills", "Requests");
    const requests = page.getByRole("region", { name: /^Requests from the orchestrator/ });
    const row = requests.getByRole("row", { name: /PAY feat\(skill\): update release-checklist/ });
    await expect(row).toContainText("awaiting review");

    // when the owner merges it
    await row.getByRole("button", { name: "Merge" }).click();

    // then
    await expect(requests.getByRole("row", { name: /PAY feat\(skill\): update release-checklist/ })).toContainText("merged");
    const { content } = await (await page.request.get("/api/repos/payments-skills/skills/release-checklist")).json();
    expect(content).toContain("- Status page updated");
    await openTab(page, "payments-skills", "Skills");
    await expect(page.getByRole("region", { name: /^History/ })).toContainText(/Merge handbook\/orchestrator-skill-release-checklist-/);
  });
});

test.describe("a team whose branches start with a ticket", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a proposal that leaves the ticket to fill in, when the owner names it, then the request is sent on the branch they named", async ({ page }) => {
    // given the orchestrator proposes the team's shape, as it does for an example like TEAM-42-fix-login
    let sent: { branch?: string } | null = null;
    await page.route("**/api/repos/payments-skills/changes/proposal", (route) => route.fulfill({ json: { proposal: "PAY feat(skill): add on-call", branch: "<TICKET>-skill-on-call-0a1b2c" } }));
    await page.route("**/api/repos/payments-skills/changes", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { request: { repoId: "payments-skills", number: 99, url: "local://requests/payments-skills/99", branch: sent!.branch, title: "PAY feat(skill): add on-call", status: "open", provider: "local", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" } } });
    });
    await page.goto("/demo/repositories/payments-skills/skills");
    await page.getByRole("button", { name: "Add a skill" }).click();
    await page.getByLabel("Skill name").fill("on-call");
    await page.getByRole("button", { name: "Review the new skill" }).click();

    // then the ticket is asked for
    await expect(page.getByLabel("Branch")).toHaveValue("<TICKET>-skill-on-call-0a1b2c");
    await expect(page.getByText("This team's branches start with a ticket: put it in place of <TICKET>.")).toBeVisible();

    // when it is named
    await page.getByLabel("Branch").fill("TEAM-77-skill-on-call");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #99" })).toContainText("opened on TEAM-77-skill-on-call", { timeout: 30_000 });
    expect(sent!.branch).toBe("TEAM-77-skill-on-call");
  });
});

test.describe("a team owner changing how requests are named", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given the Payments owner, when they set a new prefix and example and confirm, then the request carries both and is named the way the team names it today", async ({ page }) => {
    // given
    let sent: { change?: unknown; message?: string } | null = null;
    await page.route("**/api/repos/payments-skills/changes", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { request: { repoId: "payments-skills", number: 98, url: "local://requests/payments-skills/98", branch: "handbook/orchestrator-naming-0a1b2c", title: sent!.message, status: "open", provider: "local", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" } } });
    });
    await page.goto("/demo/repositories/payments-skills/settings");
    await page.getByRole("button", { name: "Edit naming" }).click();
    await expect(page.getByLabel(/^Commit prefix/)).toHaveValue("PAY");

    // when
    await page.getByLabel(/^Commit prefix/).fill("CORE");
    await page.getByLabel(/^Example branch name/).fill("CORE-12-add-ledger");
    await page.getByRole("button", { name: "Review the change" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY chore: set how commits and branches to this repository are named");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #98 opened" })).toContainText("Request #98 opened", { timeout: 30_000 });
    expect(sent!.change).toEqual({ kind: "team.naming", commitPrefix: "CORE", branchExample: "CORE-12-add-ledger" });
  });

  test("given an example branch that holds a home directory, when it is reviewed, then the plugin's rule refuses it on the screen", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/settings");
    await page.getByRole("button", { name: "Edit naming" }).click();

    // when
    await page.getByLabel(/^Example branch name/).fill("/home/someone/fix-login");
    await page.getByRole("button", { name: "Review the change" }).click();

    // then
    await expect(page.getByRole("alert")).toContainText("That example branch cannot be recorded: it is carrying a trace of a machine");
    await expect(page.getByLabel("Commit message")).toHaveCount(0);
  });
});

test.describe("a team owner editing and removing an MCP server", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  async function captureSent(page: Page): Promise<() => { change?: unknown } | null> {
    let sent: { change?: unknown; message?: string } | null = null;
    await page.route("**/api/repos/payments-skills/changes", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { request: { repoId: "payments-skills", number: 97, url: "local://requests/payments-skills/97", branch: "handbook/orchestrator-mcp-0a1b2c", title: sent!.message, status: "open", provider: "local", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" } } });
    });
    return () => sent;
  }

  test("given a declared server, when the owner edits its address and confirms, then the request replaces that one definition", async ({ page }) => {
    // given
    const sent = await captureSent(page);
    await page.goto("/demo/repositories/payments-skills/mcp");
    await page.getByRole("row", { name: /^docs/ }).getByRole("button", { name: "Edit" }).click();
    await expect(page.getByLabel("URL")).toHaveValue("https://docs.example.com/mcp");

    // when
    await page.getByLabel("URL").fill("https://docs.example.com/v2/mcp");
    await page.getByRole("button", { name: "Review the server" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY feat(mcp): update docs");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #97 opened" })).toContainText("Request #97 opened", { timeout: 30_000 });
    expect(sent()!.change).toEqual({ kind: "mcp.edit", name: "docs", config: { type: "http", url: "https://docs.example.com/v2/mcp" } });
  });

  test("given a declared server, when the owner removes it and confirms, then the request names only that server", async ({ page }) => {
    // given
    const sent = await captureSent(page);
    await page.goto("/demo/repositories/payments-skills/mcp");

    // when
    await page.getByRole("row", { name: /^postgres/ }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Review removing postgres" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY chore(mcp): remove postgres");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #97 opened" })).toContainText("Request #97 opened", { timeout: 30_000 });
    expect(sent()!.change).toEqual({ kind: "mcp.remove", name: "postgres" });
  });
});

test.describe("an MCP server that carries a secret", () => {
  test("given a server whose env holds a literal token, when it is reviewed, then it is refused by the share rule and the token is nowhere on the screen", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/platform-skills/mcp");
    const before = await (await page.request.get("/api/requests?repo=platform-skills")).json();
    await page.getByRole("button", { name: "Add a server" }).click();
    await page.getByLabel("Server name").fill("billing");
    await page.getByRole("textbox", { name: "Command", exact: true }).fill("billing-mcp");
    await page.getByLabel("Environment").fill(`BILLING_TOKEN=${LITERAL}`);

    // when
    await page.getByRole("button", { name: "Review the server" }).click();

    // then
    await expect(page.getByRole("alert")).toHaveText(
      "Billing is not shareable as written: env.BILLING_TOKEN holds a literal value; move the value into an environment variable referenced as ${VAR} and review again.",
    );
    expect(await page.locator("body").innerText()).not.toContain(LITERAL);
    expect(await allFieldValues(page)).not.toContain(LITERAL);
    expect(await page.content()).not.toContain(LITERAL);
    const after = await (await page.request.get("/api/requests?repo=platform-skills")).json();
    expect(after.requests).toHaveLength(before.requests.length);
  });
});

test.describe("people who may not edit a team's repository", () => {
  test.describe("a member", () => {
    test.use({ storageState: stateFor("member") });

    test("given a member, when they open a repository, then no edit control is offered and the API refuses a change with a valid CSRF token", async ({ page }) => {
      // when
      await page.goto("/demo/repositories/payments-skills");

      // then
      await expect(page.getByText("An admin or an owner of Payments proposes changes here.")).toBeVisible();
      for (const tab of ["Overview", "Skills", "MCP servers", "Commands", "Requests", "Settings"] as const) {
        await openTab(page, "payments-skills", tab);
        await expect(page.getByRole("button", { name: /^(Add a skill|Add a server|Add a command|Edit|Remove|Edit reviewers and labels|Edit naming|Edit \/.+|Remove \/.+)$/ })).toHaveCount(0);
      }
      const res = await proposeDirectly(page.request, "payments-skills", "member-attempt");
      expect(res.status()).toBe(403);
      expect((await res.json()).error).toBe("only an admin or an owner of Payments can change this repository");
    });
  });

  test.describe("another team's owner", () => {
    test.use({ storageState: stateFor("platformOwner") });

    test("given the Platform owner, when they open Payments and Platform, then only Platform offers edits, and the API refuses Payments while accepting Platform", async ({ page }) => {
      // when
      await page.goto("/demo/repositories/payments-skills/skills");

      // then
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("payments-skills");
      await expect(page.getByRole("button", { name: "Add a skill" })).toHaveCount(0);
      const refused = await proposeDirectly(page.request, "payments-skills", "platform-owner-attempt");
      expect(refused.status()).toBe(403);
      expect((await refused.json()).error).toBe("only an admin or an owner of Payments can change this repository");

      // when
      await page.goto("/demo/repositories/platform-skills/skills");

      // then
      await expect(page.getByRole("button", { name: "Add a skill" })).toBeVisible();
      expect((await proposeDirectly(page.request, "platform-skills", "platform-owner-own-team")).status()).toBe(200);
    });
  });
});

test.describe("a team owner managing a team's usage report", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a team that reports skill use, when the owner asks for a new address, then the screen says every teammate is asked again and the request is sent as a new address", async ({ page }) => {
    // given
    let sent: { action?: string } | null = null;
    await page.route("**/api/repos/payments-skills/inventory", async (route) => {
      const body = await (await route.fetch()).json();
      await route.fulfill({ json: { ...body, inventory: { ...body.inventory, team: { ...body.inventory.team, usageEndpoint: "https://orchestrator.example.com/ingest/usage/x/payments-skills" } } } });
    });
    await page.route("**/api/repos/payments-skills/usage/proposal", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ action: "rotate" });
      await route.fulfill({ json: { proposal: "PAY chore: give teammates' TeamHandbook a new address for skill-use counts", branch: "handbook/orchestrator-usage-address-0a1b2c" } });
    });
    await page.route("**/api/repos/payments-skills/usage/propose", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { request: { repoId: "payments-skills", number: 96, url: "local://requests/payments-skills/96", branch: "handbook/orchestrator-usage-address-0a1b2c", title: "PAY chore: new address", status: "open", provider: "local", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" } } });
    });
    await page.goto("/demo/repositories/payments-skills/settings");
    await expect(page.getByRole("button", { name: "Ask this team to report skill use" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Stop asking for skill use" })).toBeVisible();

    // when
    await page.getByRole("button", { name: "Give the team a new usage address" }).click();
    await expect(page.getByText(/every teammate is asked again before anything is sent to the new one/)).toBeVisible();
    await page.getByRole("button", { name: "Review the request" }).click();
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #96 opened" })).toContainText("Request #96 opened", { timeout: 30_000 });
    expect(sent).toMatchObject({ action: "rotate", message: "PAY chore: give teammates' TeamHandbook a new address for skill-use counts" });
  });
});

test.describe("a team owner changing the team's slash commands", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  async function captureSent(page: Page): Promise<() => { change?: unknown } | null> {
    let sent: { change?: unknown; message?: string } | null = null;
    await page.route("**/api/repos/payments-skills/changes", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { request: { repoId: "payments-skills", number: 95, url: "local://requests/payments-skills/95", branch: "handbook/orchestrator-command-0a1b2c", title: sent!.message, status: "open", provider: "local", createdAt: new Date().toISOString(), createdBy: "pat@example.invalid" } } });
    });
    return () => sent;
  }

  test("given the Payments owner, when they add a command in a folder and confirm, then the request carries its name and text", async ({ page }) => {
    // given
    const sent = await captureSent(page);
    await page.goto("/demo/repositories/payments-skills/commands");

    // when
    await page.getByRole("button", { name: "Add a command" }).click();
    await page.getByLabel(/^Command name/).fill("git:sync");
    await page.getByLabel("Command text").fill("---\ndescription: Bring the branch up to date.\n---\n\nFetch, then rebase.\n");
    await page.getByRole("button", { name: "Review the new command" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY feat(command): add /git:sync");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    await expect(page.getByRole("status").filter({ hasText: "Request #95 opened" })).toContainText("Request #95 opened", { timeout: 30_000 });
    expect(sent()!.change).toEqual({ kind: "command.add", name: "git:sync", content: "---\ndescription: Bring the branch up to date.\n---\n\nFetch, then rebase.\n" });
  });

  test("given the demo's /deploy-check, when the owner edits it, then the form starts from its text and the request carries the edit", async ({ page }) => {
    // given
    const sent = await captureSent(page);
    await page.goto("/demo/repositories/payments-skills/commands");
    await page.getByRole("button", { name: "Edit /deploy-check" }).click();
    const text = page.getByLabel("Command text");
    await expect(text).toHaveValue(/Run the checks in release-checklist/);

    // when
    await text.fill("Run every check and stop at the first failure.\n");
    await page.getByRole("button", { name: "Review the edit" }).click();
    await expect(page.getByLabel("Commit message")).toHaveValue("PAY feat(command): update /deploy-check");
    await page.getByRole("button", { name: "Open request" }).click();

    // then
    expect(sent()!.change).toEqual({ kind: "command.edit", name: "deploy-check", content: "Run every check and stop at the first failure.\n" });
  });

  test("given a command carrying a token, when it is reviewed, then the plugin's rule refuses it on the screen without the token", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/commands");
    await page.getByRole("button", { name: "Add a command" }).click();
    await page.getByLabel(/^Command name/).fill("deploy");

    // when
    await page.getByLabel("Command text").fill("curl -H 'Authorization: Bearer ghp_aaaabbbbccccddddeeeeffff'\n");
    await page.getByRole("button", { name: "Review the new command" }).click();

    // then
    await expect(page.getByRole("alert")).toContainText("/deploy is not shareable as written");
    await expect(page.getByRole("alert")).not.toContainText("ghp_aaaa");
  });
});

test.describe("a request the orchestrator merges, and what waits to be merged", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a request the orchestrator opened and a page that read the waiting list, when the owner merges it, then it is not listed as anyone else's", async ({ page }) => {
    // given
    const slug = `waiting-${Date.now().toString(36)}`;
    const { csrf } = await (await page.request.get("/api/me")).json();
    const opened = await page.request.post("/api/repos/payments-skills/changes", {
      headers: { "x-csrf-token": csrf },
      data: { baseSha: await headOf(page.request, "payments-skills"), message: `feat(skill): add ${slug}`, change: { kind: "skill.add", slug, content: `---\nname: ${slug}\ndescription: Use when testing what waits to be merged.\n---\n\nBody.\n` } },
    });
    const { request } = await opened.json();
    await page.goto("/demo/repositories/payments-skills/requests");
    const waiting = page.getByRole("region", { name: /^Waiting to be merged/ });
    await expect(waiting).toContainText("opened from the orchestrator");

    // when
    await page.getByRole("region", { name: /^Requests from the orchestrator/ }).getByRole("row", { name: new RegExp(`add ${slug}`) }).getByRole("button", { name: "Merge" }).click();
    await expect(page.getByRole("region", { name: /^Requests from the orchestrator/ }).getByRole("row", { name: new RegExp(`add ${slug}`) })).toContainText("merged", { timeout: 30_000 });

    // then
    await expect(waiting).not.toContainText(request.branch);
  });
});
