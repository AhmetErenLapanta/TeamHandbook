import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { stateFor } from "./roles.js";
import { choose } from "./task-form.js";

const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

async function violations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page }).withTags(RULES).analyze();
  return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
}

const budgetPolicy = {
  id: "pol_000000001aaaaaaaa",
  name: "Platform task budget",
  audience: { kind: "teams", ids: ["Platform"] },
  rules: [{ kind: "task-budget", monthlyUsd: 40, per: "member" }],
  updatedAt: "2026-10-20T10:00:00.000Z",
  updatedBy: "ada@example.invalid",
};

const retirePolicy = {
  id: "pol_000000002bbbbbbbb",
  name: "Retire postgres",
  audience: { kind: "workspace" },
  rules: [{ kind: "mcp-access", effect: "deny", resources: ["mcp:postgres"], reason: "Replaced by the warehouse server." }],
  updatedAt: null,
  updatedBy: null,
  repos: ["payments-skills", "platform-skills"],
};

/** Serves the policy list as an orchestrator with a policy table would, holding the given policies. */
async function policiesStored(page: Page, policies: unknown[]): Promise<void> {
  await page.route("**/api/policies", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { policies, problems: [], orchestratorRulesStored: true } }) : route.fallback(),
  );
}

/** Captures what a save sends instead of opening real requests on the shared demo repositories. */
async function captureSave(page: Page, reply: unknown): Promise<() => { method: string; body: Record<string, unknown> } | null> {
  let sent: { method: string; body: Record<string, unknown> } | null = null;
  await page.route(/\/api\/policies(\/[^/]+)?$/, (route) => {
    const method = route.request().method();
    if (method === "GET" || /\/(proposal|preview)$/.test(route.request().url())) return route.fallback();
    sent = { method, body: route.request().postDataJSON() };
    return route.fulfill({ json: reply });
  });
  return () => sent;
}

async function openRetireTemplate(page: Page): Promise<void> {
  await page.goto("/demo/team");
  await page.getByRole("link", { name: /Retire an MCP server/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add policy");
}

test.describe("the Controls page", () => {
  test("given no policy in any team file, when Team opens, then its policies say none holds anyone yet, offer Add policy and the four templates, and link the managed-settings export for an organization that allows only managed hooks", async ({ page }) => {
    // when
    await page.goto("/demo/team");

    // then
    await expect(page.getByRole("region", { name: /^Policies/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add policy" })).toBeVisible();
    const templates = page.getByRole("region", { name: /Control templates/ });
    for (const name of ["Retire an MCP server", "Read-only Bash for a team", "Monthly task budget", "Keep a skill to one team"]) {
      await expect(templates.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }
    await expect(templates).toContainText("A rule saved as a request reaches teammates once a reviewer merges it on the team repository");
    await expect(templates).toContainText("one that applies now holds this orchestrator's tasks from the moment it is saved");
    await expect(templates).toContainText("Where an organization allows only managed hooks, policies reach teammates through the managed-settings export.");
    await expect(templates.locator('a[href="/api/policies/export?download=1"]')).toHaveText("Export the saved policies");
    await expect(templates.getByRole("button", { name: /control templates/i })).toHaveCount(0);
  });

  test("given policies of both kinds, when Controls opens, then each reads as its sentence and says whether it reaches teammates or orchestrator tasks", async ({ page }) => {
    // given
    await policiesStored(page, [budgetPolicy, retirePolicy]);

    // when
    await page.goto("/demo/team");

    // then
    const rows = page.locator(".policy-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Members of Platform can each spend up to $40 a month on tasks.");
    await expect(rows.nth(0)).toContainText("Applies to orchestrator tasks");
    await expect(rows.nth(1)).toContainText("Everyone in the organization cannot use the MCP server postgres.");
    await expect(rows.nth(1)).toContainText("Reaches teammates through the team file");
  });
});

test.describe("the policy editor", () => {
  test("given the retire template, when the server is named and the policy filled in, then the sentence follows each edit and save unlocks only once nothing is missing", async ({ page }) => {
    // given
    await openRetireTemplate(page);
    const summary = page.locator(".policy-summary");
    const save = page.getByRole("button", { name: "Save policy" });
    await expect(summary).toHaveText("Everyone in the organization cannot use the chosen MCP servers.");
    await expect(page.locator("#locked-reason")).toHaveText("Name the MCP servers this rule blocks to continue.");
    await expect(save).toBeDisabled();

    // when
    await page.getByLabel("MCP servers to block").fill("postgres");
    await page.getByLabel("MCP servers to block").press("Enter");

    // then
    await expect(summary).toHaveText("Everyone in the organization cannot use the MCP server postgres.");
    await expect(page.locator("#locked-reason")).toHaveCount(0);
    await expect(save).toBeEnabled();
    await page.getByLabel("Reason teammates see").fill("");
    await expect(page.locator("#locked-reason")).toHaveText("Say why this is blocked; teammates read it when a call is stopped.");
    await expect(save).toBeDisabled();
  });

  test("given a complete blocking policy, when it is previewed, then the orchestrator's own preview lists who it covers and the repositories saving opens a request on", async ({ page }) => {
    // given
    await openRetireTemplate(page);
    await page.getByLabel("MCP servers to block").fill("postgres");

    // when
    await page.getByLabel("MCP servers to block").press("Enter");

    // then
    const preview = page.getByRole("region", { name: /Preview/ });
    await expect(preview.getByText("Saved as a request; reaches teammates when merged.")).toBeVisible();
    await expect(preview).toContainText(/Saving opens a request on .*payments-skills/);
    await expect(preview).toContainText("Where an organization allows only managed hooks, policies reach teammates through the managed-settings export.");
    await expect(preview.getByRole("link", { name: "Export the saved policies for payments-skills" })).toHaveAttribute("href", "/api/policies/export?repo=payments-skills&download=1");
    await expect(preview.getByText("Ada Admin", { exact: true })).toBeVisible();
  });

  test("given a complete blocking policy, when it is saved, then each repository's request is confirmed first and the save carries the message, branches and heads but no id", async ({ page }) => {
    // given
    const sent = await captureSave(page, { saved: "request", id: "pol_x", requests: [{ repoId: "payments-skills", number: 41, url: "https://forge.example.invalid/payments/41", branch: "b", title: "PAY chore(policy): retire postgres", status: "open", provider: "gitlab", createdAt: "2026-10-25T00:00:00.000Z", createdBy: "ada@example.invalid" }], failed: [{ repoId: "platform-skills", error: "the forge refused the branch" }] });
    await openRetireTemplate(page);
    await page.getByLabel("MCP servers to block").fill("postgres");
    await page.getByLabel("MCP servers to block").press("Enter");

    // when
    await page.getByRole("button", { name: "Save policy" }).click();
    const confirm = page.getByRole("region", { name: /Save this policy as/ });
    await expect(confirm.getByText("payments-skills")).toBeVisible();
    await expect(confirm.getByLabel("Commit message")).not.toHaveValue("");
    await page.getByRole("button", { name: /^Open (the request|\d+ requests)$/ }).click();

    // then
    await expect(page.getByRole("heading", { name: "Saved as a request; reaches teammates when merged" })).toBeVisible();
    await expect(page.getByRole("link", { name: "payments-skills #41" })).toHaveAttribute("href", "https://forge.example.invalid/payments/41");
    await expect(page.getByText("the forge refused the branch")).toBeVisible();
    const body = sent()!;
    expect(body.method).toBe("POST");
    expect(body.body.id).toBeUndefined();
    expect(body.body.message).toBe("chore: add the team policy Retire an MCP server");
    expect(Object.keys(body.body.baseShas as object)).toContain("payments-skills");
    expect(Object.keys(body.body.branches as object)).toContain("payments-skills");
    expect(body.body.policy).toEqual({ name: "Retire an MCP server", audience: { kind: "workspace" }, rules: [{ kind: "mcp-access", effect: "deny", resources: ["mcp:postgres"], reason: "This server is retired; the team uses its replacement." }] });
  });

  test("given a blocking rule, when the other blocks and audiences are offered, then orchestrator rules and member audiences are locked with the reason", async ({ page }) => {
    // given
    await policiesStored(page, []);
    await openRetireTemplate(page);

    // then
    await expect(page.getByRole("button", { name: "Task budget" })).toBeDisabled();
    await expect(page.getByText("This policy reaches teammates' machines; orchestrator rules go in a policy of their own.").first()).toBeVisible();
    const audience = page.getByRole("combobox", { name: "Who this policy applies to" });
    await audience.click();
    await expect(page.getByRole("option", { name: "These members", exact: true })).toBeDisabled();
    await expect(page.getByRole("option", { name: "Members of teams" })).toBeEnabled();
    await audience.press("Escape");
  });

  test("given an orchestrator that stores its own rules, when a budget is added without an amount and then given one, then save is locked on the limit and the saved policy applies now", async ({ page }) => {
    // given
    await policiesStored(page, []);
    await page.route("**/api/policies/preview", (route) => route.fulfill({ json: { members: [{ id: "u1", name: "Ada Admin" }, { id: "service:ci", name: "CI runner" }], teams: [], repos: [], usage30d: { tasks: 4, usd: 12.5, unknownCost: 1 } } }));
    const sent = await captureSave(page, { saved: "applied", policy: { ...budgetPolicy, id: "pol_y" } });
    await page.goto("/demo/team/policies/new");
    await page.getByLabel("Name", { exact: true }).fill("Monthly budget");

    // when
    await page.getByRole("button", { name: "Task budget" }).click();

    // then
    await expect(page.locator("#locked-reason")).toHaveText("Enter a monthly limit to continue.");
    await page.getByLabel("Monthly limit in US dollars").fill("25");
    const preview = page.getByRole("region", { name: /Preview/ });
    await expect(preview.getByText("Applies now.")).toBeVisible();
    await expect(preview).toContainText("1 task reported no cost");
    await expect(preview.getByText("CI runner")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page).toHaveURL(/\/demo\/team$/);
    expect(sent()!.body.policy).toEqual({ name: "Monthly budget", audience: { kind: "workspace" }, rules: [{ kind: "task-budget", monthlyUsd: 25, per: "audience" }] });
  });

  test("given an orchestrator that stores its own rules, when the starter's own setup block is added, then it starts off on every repository, says what a task runs with, and the saved policy applies now", async ({ page }) => {
    // given
    await policiesStored(page, []);
    const sent = await captureSave(page, { saved: "applied", policy: { name: "Team setup only", audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: false, repos: ["*"] }], id: "pol_z", updatedAt: null, updatedBy: null } });
    await page.goto("/demo/team/policies/new");
    await page.getByLabel("Name", { exact: true }).fill("Team setup only");

    // when
    await page.getByRole("button", { name: "Starter's own setup" }).click();

    // then
    await expect(page.getByLabel("Tasks use the starter's own Claude Code setup")).not.toBeChecked();
    await expect(page.getByText("A task on a person's machine runs with their sign-in and the team's skills only.")).toBeVisible();
    await expect(page.getByRole("region", { name: /Preview/ }).getByText("Applies now.")).toBeVisible();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page).toHaveURL(/\/demo\/team$/);
    expect(sent()!.body.policy).toEqual({ name: "Team setup only", audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: false, repos: ["*"] }] });
  });

  test("given twenty rules, when another is offered, then every block is locked at the limit", async ({ page }) => {
    // given
    await page.goto("/demo/team/policies/new");

    // when
    for (let i = 0; i < 20; i++) await page.getByRole("button", { name: "Skills", exact: true }).click();

    // then
    await expect(page.locator(".rule-block")).toHaveCount(20);
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toBeDisabled();
    await expect(page.getByText("A policy holds at most 20 rules.").first()).toBeVisible();
    await page.getByRole("button", { name: "Remove the Skills rule" }).first().click();
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toBeEnabled();
  });

  test("given text typed into the second of two blocks, when the first is removed, then the text stays with its own block", async ({ page }) => {
    // given
    await page.goto("/demo/team/policies/new");
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.getByRole("button", { name: "MCP servers", exact: true }).click();
    await page.getByLabel("MCP servers to block").fill("warehouse");

    // when
    await page.getByRole("button", { name: "Remove the Skills rule" }).click();

    // then
    await expect(page.locator(".rule-block")).toHaveCount(1);
    await expect(page.getByLabel("MCP servers to block")).toHaveValue("warehouse");
  });

  test("given the keep-to-one-team template, when it opens, then every team is in the audience to take one off", async ({ page }) => {
    // when
    await page.goto("/demo/team/policies/new?template=skill-one-team");

    // then
    const teams = page.getByRole("list", { name: "Teams" });
    await expect(teams.getByText("Payments")).toBeVisible();
    await expect(teams.getByText("Platform")).toBeVisible();
    await page.getByRole("button", { name: "Remove Payments" }).click();
    await page.getByLabel("Skills to block").fill("add-ledger-migration");
    await page.getByLabel("Skills to block").press("Enter");
    await expect(page.locator(".policy-summary")).toHaveText(/^Members of Platform( and .+)? cannot use the skill add-ledger-migration\.$/);
  });
});

test.describe("deleting and refreshing policies", () => {
  test("given an orchestrator policy, when Delete is chosen, then it says what stops at once, keeping it leaves it, and confirming deletes it and returns to the list", async ({ page }) => {
    // given
    await policiesStored(page, [budgetPolicy]);
    const sent = await captureSave(page, { saved: "applied", removed: budgetPolicy.id });
    await page.goto(`/demo/team/policies/${budgetPolicy.id}`);

    // when
    await page.getByRole("button", { name: "Delete this policy" }).click();
    const question = page.getByRole("group", { name: "Delete policy" });
    await expect(question).toContainText("Deleting it applies at once: tasks stop counting against its $40 monthly budget. The deletion is recorded in the audit log.");
    await expect(question.getByRole("button", { name: "Keep policy" })).toBeFocused();
    await question.getByRole("button", { name: "Keep policy" }).click();
    await expect(page.getByRole("button", { name: "Delete this policy" })).toBeFocused();
    expect(sent()).toBeNull();
    await page.getByRole("button", { name: "Delete this policy" }).click();
    await page.getByRole("group", { name: "Delete policy" }).getByRole("button", { name: "Delete policy" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/team$/);
    expect(sent()!.method).toBe("DELETE");
  });

  test("given a policy that reaches teammates, when Delete is chosen, then removing it goes through the request confirmation instead", async ({ page }) => {
    // given
    await policiesStored(page, [retirePolicy]);
    // The policy is served by the stand-in list, not a team file, so the orchestrator's proposal is stood in for too.
    await page.route("**/api/policies/proposal", (route) => route.fulfill({ json: { applies: "request", repos: [{ repoId: "payments-skills", name: "payments-skills", head: "0".repeat(40), change: "remove", proposal: "chore: remove the team policy Retire postgres", branch: "handbook/orchestrator-policy" }] } }));
    await page.goto(`/demo/team/policies/${retirePolicy.id}`);

    // when
    await page.getByRole("button", { name: "Delete this policy" }).click();

    // then
    await expect(page.getByRole("group", { name: "Delete policy" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Remove this policy as/ })).toBeVisible();
  });

  test("given a policies read that fails, when Team opens, then Policies says the read failed and Retry policies reads them again", async ({ page }) => {
    // given
    let failing = true;
    await page.route("**/api/policies", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return failing ? route.fulfill({ status: 500, json: { error: "the store did not answer", code: "internal" } }) : route.fulfill({ json: { policies: [budgetPolicy, retirePolicy], problems: [], orchestratorRulesStored: true } });
    });

    // when
    await page.goto("/demo/team");

    // then
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load policies." })).toContainText("The store did not answer.");

    // when
    failing = false;
    await page.getByRole("button", { name: "Retry policies" }).click();

    // then
    await expect(page.getByText("Couldn't load policies.")).toHaveCount(0);
    await expect(page.locator(".policy-row")).toHaveCount(2);
  });

  test("given an orchestrator whose policy read fails at first, when Controls opens, then it says what failed and Retry policies loads them", async ({ page }) => {
    // given
    let reads = 0;
    await page.route("**/api/policies", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      reads++;
      return reads === 1 ? route.fulfill({ status: 500, json: { error: "the store did not answer", code: "internal" } }) : route.fulfill({ json: { policies: [budgetPolicy], problems: [], orchestratorRulesStored: true } });
    });

    // when
    await page.goto("/demo/team");

    // then
    await expect(page.getByRole("alert")).toContainText("Couldn't load policies. The store did not answer.");
    await page.getByRole("button", { name: "Retry policies" }).click();
    await expect(page.locator(".policy-row")).toHaveCount(1);
  });
});

test.describe("tags in a policy's audience", () => {
  test("given a member tagged by hand, when tags are chosen for an orchestrator rule, then the catalog offers that tag with its count and refuses one nobody carries", async ({ page }) => {
    // given
    const { csrf } = await (await page.request.get("/api/me")).json();
    const { users } = await (await page.request.get("/api/users")).json();
    const max = users.find((u: { email: string }) => u.email === "max@example.invalid");
    const before = ((await (await page.request.get("/api/tags")).json()).tags as { tag: string; members: { id: string; source: string }[] }[])
      .filter((t) => t.members.some((m) => m.id === max.id && m.source === "manual")).map((t) => t.tag);
    expect((await page.request.put(`/api/members/${max.id}/tags`, { data: { tags: [...before, "release-crew"] }, headers: { "x-csrf-token": csrf } })).ok()).toBe(true);
    await policiesStored(page, []);
    await page.goto("/demo/team/policies/new");
    await page.getByRole("button", { name: "Task budget" }).click();
    await page.getByLabel("Monthly limit in US dollars").fill("30");

    try {
      // when
      await choose(page.locator("main"), "Who this policy applies to", "Members tagged");
      await expect(page.getByRole("region", { name: /Preview/ })).toContainText("Add a tag to see who this applies to.");
      await page.getByLabel("Tags", { exact: true }).fill("nobody-has-this");
      await page.getByLabel("Tags", { exact: true }).press("Enter");
      await expect(page.getByText("nobody-has-this is not one of the choices.")).toBeVisible();
      await page.getByLabel("Tags", { exact: true }).fill("release-crew");
      await page.getByLabel("Tags", { exact: true }).press("Enter");

      // then
      await expect(page.locator("datalist option[value='release-crew']")).toHaveCount(0);
      await expect(page.getByRole("list", { name: "Tags" }).getByText("release-crew")).toBeVisible();
      await expect(page.locator(".policy-summary")).toHaveText("Members tagged release-crew can spend up to $30 a month on tasks, together.");
    } finally {
      await page.request.put(`/api/members/${max.id}/tags`, { data: { tags: before }, headers: { "x-csrf-token": csrf } });
    }
  });

  test("given the catalog offers a tag, when the field is read, then the choice names how many members carry it", async ({ page }) => {
    // given
    await page.route("**/api/tags", (route) => route.fulfill({ json: { tags: [{ tag: "backend", members: [{ id: "a", name: "A", source: "directory" }, { id: "b", name: "B", source: "manual" }] }] } }));
    await page.goto("/demo/team/policies/new");

    // when
    await choose(page.locator("main"), "Who this policy applies to", "Everyone except those tagged");

    // then
    await expect(page.locator("datalist option[value='backend']")).toHaveText("backend (2 members)");
  });

  test("given an organization where no member has a tag, when tags are chosen, then it says where tags come from", async ({ page }) => {
    // given
    await page.route("**/api/tags", (route) => route.fulfill({ json: { tags: [] } }));
    await page.goto("/demo/team/policies/new");

    // when
    await choose(page.locator("main"), "Who this policy applies to", "Members tagged");

    // then
    await expect(page.getByText("No member has a tag yet; add one on a member's page in Settings.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings", exact: true }).last()).toHaveAttribute("href", "/demo/settings/members");
  });
});

async function memberId(page: Page, email: string): Promise<string> {
  const { users } = await (await page.request.get("/api/users")).json();
  return users.find((u: { email: string }) => u.email === email).id;
}

test.describe("what reaches one member", () => {
  test("given a Payments member, when an admin opens their page, then it lists what Payments' repository gives their sessions and that no orchestrator rule holds their tasks", async ({ page }) => {
    // given
    const id = await memberId(page, "pat@example.invalid");

    // when
    await page.goto(`/demo/settings/members/${id}`);

    // then
    const section = page.getByRole("region", { name: "What reaches their sessions" });
    await expect(section).toContainText("Through Payments");
    await expect(section.getByRole("region", { name: /payments-skills/ })).toContainText("release-checklist");
    await expect(section.getByRole("region", { name: /payments-skills/ })).toContainText("postgres");
    await expect(section.getByRole("region", { name: /platform-skills/ })).toHaveCount(0);
    await expect(section).toContainText("No orchestrator rule keeps them from starting a task.");
  });

  test("given a policy draft, when a member is chosen in its preview, then it names what the draft takes from them and closes back to the prompt", async ({ page }) => {
    // given
    await openRetireTemplate(page);
    await page.getByLabel("MCP servers to block").fill("postgres");
    await page.getByLabel("MCP servers to block").press("Enter");
    const preview = page.getByRole("region", { name: /Preview/ });
    await expect(preview.getByText("Choose members to preview this policy.")).toBeVisible();

    // when
    await choose(preview, "Preview for a member", "Pat Payments (pat@example.invalid)");

    // then
    await expect(preview.getByRole("status").filter({ hasText: "The MCP server postgres in payments-skills" })).toContainText("This server is retired; the team uses its replacement.");
    await preview.getByRole("button", { name: "Close member preview" }).click();
    await expect(preview.getByText("Choose members to preview this policy.")).toBeVisible();
  });

  test("given an orchestrator rule keeping everyone off a repository, when a member is chosen in its preview, then it names the task start it refuses", async ({ page }) => {
    // given
    await page.goto("/demo/team/policies/new");
    await page.getByLabel("Name", { exact: true }).fill("Hold payments");
    await page.getByRole("button", { name: "Repository access" }).click();
    await page.getByLabel("blocked").check();
    await page.getByRole("combobox", { name: "Repositories" }).fill("payments-skills");
    await page.getByRole("combobox", { name: "Repositories" }).press("Enter");

    // when
    await choose(page.getByRole("region", { name: /Preview/ }), "Preview for a member", "Pat Payments (pat@example.invalid)");

    // then
    await expect(page.getByRole("region", { name: /Preview/ }).getByRole("status").filter({ hasText: "Starting a task on payments-skills" })).toContainText('"preview" does not let you start tasks on payments-skills.');
  });
});

test("given an owner, when Controls opens, then Run automations switches every automation off and on, and off says changes are logged and start nothing", async ({ page }) => {
  // given
  let enabled = true;
  const sent: unknown[] = [];
  await page.route("**/api/work/automations", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      sent.push(body);
      enabled = body.enabled;
    }
    await route.fulfill({ json: { enabled, automations: [] } });
  });
  await page.goto("/demo/team");
  const panel = page.getByRole("region", { name: "Automations" });

  // when
  await panel.getByLabel("Run automations").uncheck();

  // then
  await expect(panel).toContainText("Every automation is off: changes on the tracker are logged and set nothing going.");
  await expect.poll(() => sent).toEqual([{ enabled: false }]);
  await expect(panel.getByRole("link", { name: "Manage automations" })).toHaveAttribute("href", "/demo/integrations");
});

test("given an owner whose switch is not saved, when Run automations is turned off, then it is back on and says why", async ({ page }) => {
  // given
  await page.route("**/api/work/automations", (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 500, json: { error: "the store did not answer", code: "internal" } })
    : route.fulfill({ json: { enabled: true, automations: [] } }));
  await page.goto("/demo/team");
  const panel = page.getByRole("region", { name: "Automations" });

  // when
  await panel.getByLabel("Run automations").uncheck();

  // then
  await expect(panel.getByRole("alert")).toContainText("The store did not answer.");
  await expect(panel.getByLabel("Run automations")).toBeChecked();
});

test.describe("a team's owner in the editor", () => {
  test.use({ storageState: stateFor("paymentsOwner") });

  test("given a team's owner, when the editor opens, then the orchestrator's own rules are left to an owner or admin", async ({ page }) => {
    // given
    await policiesStored(page, []);

    // when
    await page.goto("/demo/team/policies/new");

    // then
    await expect(page.getByRole("button", { name: "Task budget" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Repository access" })).toBeDisabled();
    await expect(page.getByText("Only an admin sets the orchestrator's own rules.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Skills", exact: true })).toBeEnabled();
  });

  test("given a team's owner, when tags are chosen, then members' tags are left to an owner or admin", async ({ page }) => {
    // given
    await page.goto("/demo/team/policies/new");

    // when
    await choose(page.locator("main"), "Who this policy applies to", "Members tagged");

    // then
    await expect(page.getByText("Only an owner or an admin sees members' tags.")).toBeVisible();
  });
});

test.describe("a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member who owns no team, when they open the editor's address or a saved policy's, then they read who sets policies and the policy's sentence, with nothing to save", async ({ page }) => {
    // given
    await policiesStored(page, [budgetPolicy]);

    // when
    await page.goto("/demo/team/policies/new");

    // then
    await expect(page.getByRole("region", { name: "Who sets policies" })).toContainText("back to the policies in force");
    await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);

    // when
    await page.goto(`/demo/team/policies/${budgetPolicy.id}`);

    // then
    await expect(page.getByRole("region", { name: "What it does" })).toContainText("Members of Platform can each spend up to $40 a month on tasks.");
    await expect(page.getByRole("button", { name: /Save|Delete/ })).toHaveCount(0);
  });

  test("given a member on no team, when they open their own page, then it says no team repository reaches their sessions", async ({ page }) => {
    // given
    const { user } = await (await page.request.get("/api/me")).json();

    // when
    await page.goto(`/demo/settings/members/${user.id}`);

    // then
    await expect(page.getByRole("region", { name: "What reaches their sessions" })).toContainText("Not on a team, so no team repository reaches their sessions.");
  });

});

test.describe("what each role is offered on Team", () => {
  test.describe("a member who owns no team", () => {
    test.use({ storageState: stateFor("member") });

    test("given a member who owns no team, when Team opens, then it holds no policies part: no template and no Add policy", async ({ page }) => {
      // given
      await policiesStored(page, []);

      // when
      await page.goto("/demo/team");

      // then
      await expect(page.getByRole("region", { name: /^Policies/ })).toHaveCount(0);
      await expect(page.getByRole("region", { name: /Control templates/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Add policy" })).toHaveCount(0);
    });
  });

  test.describe("a team's owner", () => {
    test.use({ storageState: stateFor("paymentsOwner") });

    test("given a team's owner, when Controls opens, then the templates are the three that reach teammates, the orchestrator's own rules are left to an owner or admin, and Retire opens on their team", async ({ page }) => {
      // given
      await policiesStored(page, []);

      // when
      await page.goto("/demo/team");

      // then
      const templates = page.getByRole("region", { name: /Control templates/ });
      await expect(templates.locator("a.template")).toHaveCount(3);
      await expect(templates.getByRole("link", { name: /Monthly task budget/ })).toHaveCount(0);
      await expect(templates).toContainText("an owner or admin sets these");
      await expect(templates).toContainText("policies reach teammates through the managed-settings export");
      await templates.getByRole("link", { name: /Retire an MCP server/ }).click();
      await expect(page.locator(".policy-summary")).toHaveText("Members of Payments cannot use the chosen MCP servers.");
    });
  });
});

test.describe("a change's preview before its request opens", () => {
  test("given a policy that blocks a server, when that server's removal is reviewed, then the review step says who loses it and names the policy", async ({ page }) => {
    // given
    await policiesStored(page, [retirePolicy]);
    await page.goto("/demo/repositories/payments-skills/mcp");

    // when
    await page.getByRole("row", { name: /^postgres/ }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Review removing postgres" }).click();

    // then
    const touched = page.getByRole("region", { name: "What this change touches" });
    await expect(touched).toContainText("Once merged, teammates on Payments lose postgres.");
    await expect(touched.getByRole("link", { name: "Retire postgres" })).toHaveAttribute("href", "/demo/team/policies/pol_000000002bbbbbbbb");
  });

  test("given a skill, when its removal is reviewed, then the review step says how much it was used", async ({ page }) => {
    // given
    await page.goto("/demo/repositories/payments-skills/skills");

    // when
    await page.getByRole("row", { name: /^release-checklist/ }).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("button", { name: "Review removing release-checklist" }).click();

    // then
    await expect(page.getByRole("region", { name: "What this change touches" })).toContainText(/(Used [\d,]+ times? in the last \d+ days|No reported use in the last \d+ days)/);
  });
});

const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "Controls with templates",
    open: async (page) => {
      await policiesStored(page, [budgetPolicy, retirePolicy]);
      await page.goto("/demo/team");
      await expect(page.locator(".policy-row")).toHaveCount(2);
    },
  },
  {
    name: "policy editor with a preview",
    open: async (page) => {
      await openRetireTemplate(page);
      await page.getByLabel("MCP servers to block").fill("postgres");
      await page.getByLabel("MCP servers to block").press("Enter");
      await expect(page.getByText("Saved as a request; reaches teammates when merged.")).toBeVisible();
    },
  },
  {
    name: "requests to confirm",
    open: async (page) => {
      await openRetireTemplate(page);
      await page.getByLabel("MCP servers to block").fill("postgres");
      await page.getByLabel("MCP servers to block").press("Enter");
      await page.getByRole("button", { name: "Save policy" }).click();
      await expect(page.getByRole("region", { name: /Save this policy as/ }).getByLabel("Commit message")).toBeVisible();
    },
  },
  {
    name: "change review with its preview",
    open: async (page) => {
      await policiesStored(page, [retirePolicy]);
      await page.goto("/demo/repositories/payments-skills/mcp");
      await page.getByRole("row", { name: /^postgres/ }).getByRole("button", { name: "Remove" }).click();
      await page.getByRole("button", { name: "Review removing postgres" }).click();
      await expect(page.getByRole("region", { name: "What this change touches" })).toBeVisible();
    },
  },
  {
    name: "member page with what reaches them",
    open: async (page) => {
      await page.goto(`/demo/settings/members/${await memberId(page, "pat@example.invalid")}`);
      await expect(page.getByRole("region", { name: "What reaches their sessions" })).toContainText("Through Payments");
    },
  },
  {
    name: "policy editor with a member preview",
    open: async (page) => {
      await openRetireTemplate(page);
      await page.getByLabel("MCP servers to block").fill("postgres");
      await page.getByLabel("MCP servers to block").press("Enter");
      await choose(page.getByRole("region", { name: /Preview/ }), "Preview for a member", "Pat Payments (pat@example.invalid)");
      await expect(page.getByText("The MCP server postgres in payments-skills")).toBeVisible();
    },
  },
  {
    name: "policy editor with a budget",
    open: async (page) => {
      await policiesStored(page, []);
      await page.goto("/demo/team/policies/new?template=team-task-budget");
      await expect(page.locator("#locked-reason")).toBeVisible();
    },
  },
];

for (const theme of ["light", "dark"] as const) {
  test.describe(`Controls in the ${theme} theme`, () => {
    test.use({ colorScheme: theme });
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

test.describe("Controls at 390 pixels wide", () => {
  test.use({ viewport: { width: 390, height: 844 } });
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
