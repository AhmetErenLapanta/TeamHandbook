import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { overflows, THEMES, WIDTHS } from "./layout.js";
import { choose } from "./task-form.js";

const LONG = "Retire the legacy warehouse reporting server for every team that moved to the data platform";

const policies = [
  { id: "pol_000000001aaaaaaaa", name: LONG, audience: { kind: "teams", ids: ["Payments", "Platform"] }, rules: [{ kind: "task-budget", monthlyUsd: 1250.5, per: "member" }], updatedAt: "2026-10-20T10:00:00.000Z", updatedBy: "someone.with.a.long.address@example.invalid" },
  { id: "pol_000000002bbbbbbbb", name: "Retire postgres", audience: { kind: "workspace" }, rules: [{ kind: "mcp-access", effect: "deny", resources: ["mcp:postgres", "mcp:warehouse-reporting-server-with-a-long-name/query_everything_at_once"], reason: "Replaced by the warehouse server." }], updatedAt: null, updatedBy: null, repos: ["payments-skills", "platform-skills"] },
];

async function stored(page: Page): Promise<void> {
  await page.route("**/api/policies", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { policies, problems: [], orchestratorRulesStored: true } }) : route.fallback()));
}

async function memberId(page: Page, email: string): Promise<string> {
  const { users } = await (await page.request.get("/api/users")).json();
  return users.find((u: { email: string }) => u.email === email).id;
}

/**
 * The Team and member screens in the states the shared layout spec does not reach: long
 * names, filled rule blocks, a member's preview and a member's page. Each is opened the way a
 * person reaches it and waited on until it has loaded.
 */
const SCREENS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "team policies",
    open: async (page) => {
      await stored(page);
      // An invitation to a long address sits in a narrower column on Team than it did on Settings.
      await page.route("**/api/invites", (route) => route.fulfill({ json: { invites: [{ id: "inv_long", email: "someone.with.a.long.address@example.invalid", role: "member", teams: ["Payments", "Platform"], invitedBy: "ada@example.invalid", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-11-15T10:00:00.000Z", expired: false }] } }));
      await page.goto("/demo/team");
      await page.locator(".policy-row").first().waitFor();
    },
  },
  {
    name: "policy editor with preview and member preview",
    open: async (page) => {
      await page.goto("/demo/team/policies/new?template=retire-mcp");
      await page.getByLabel("MCP servers to block").fill("warehouse-reporting-server-with-a-long-name/query_everything_at_once");
      await page.getByLabel("MCP servers to block").press("Enter");
      await page.getByLabel("Name", { exact: true }).fill(LONG);
      await choose(page.getByRole("region", { name: /Preview/ }), "Preview for a member", "Pat Payments (pat@example.invalid)");
    },
  },
  {
    name: "policy editor with a budget and repository rules",
    open: async (page) => {
      await stored(page);
      await page.goto("/demo/team/policies/new");
      await page.getByRole("button", { name: "Task budget" }).click();
      await page.getByRole("button", { name: "Repository access", exact: true }).click();
      await page.getByRole("button", { name: "Repository access", exact: true }).click();
      await page.locator(".rule-block").nth(2).waitFor();
    },
  },
  {
    name: "orchestrator policy",
    open: async (page) => {
      await stored(page);
      await page.goto("/demo/team/policies/pol_000000001aaaaaaaa");
      await page.locator(".policy-summary").waitFor();
    },
  },
  {
    name: "member",
    open: async (page) => {
      await page.goto(`/demo/settings/members/${await memberId(page, "pat@example.invalid")}`);
      await page.getByRole("region", { name: "What reaches their sessions" }).getByText(/Through Payments/).waitFor();
    },
  },
];

const shots = process.env.ORCHESTRATOR_LAYOUT_SHOTS;

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test.describe(`at ${width} pixels in the ${theme} theme`, () => {
      test.use({ colorScheme: theme, viewport: { width, height: 900 } });
      for (const screen of SCREENS) {
        test(`given the ${screen.name} screen, when it is laid out, then nothing in it spills, is cut off or makes the page scroll sideways`, async ({ page }) => {
          // given
          await screen.open(page);
          await expect(page.getByText(/^Loading|^Working out|^Reading what reaches|^Checking what/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });

          // when
          const found = (await overflows(page)).map((o) => `${o.where} ${o.why}`);
          if (shots) await page.screenshot({ path: `${shots}/${screen.name.replace(/\W+/g, "-")}-${width}-${theme}.png`, fullPage: true });

          // then
          expect(found).toEqual([]);
        });
      }
    });
  }
}
