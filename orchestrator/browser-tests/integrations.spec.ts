import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { stateFor } from "./roles.js";
import { choose } from "./task-form.js";

const RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

/** Slack's webhook stood in for on this machine; it keeps every message it is sent. */
async function fakeSlack(): Promise<{ server: Server; url: string; received: { text: string }[] }> {
  const received: { text: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push(JSON.parse(raw));
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/T000/B000/e2e`, received };
}

/** An MCP server on this machine with the sign-in the MCP authorization spec describes; its access token is the one it issued last. */
async function signingInServer() {
  const state = { access: "", challenge: "" };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url!, base);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ["S256"] });
      if (url.pathname === "/register") return json(201, { client_id: "e2e-client" });
      if (url.pathname === "/authorize") {
        state.challenge = url.searchParams.get("code_challenge") ?? "";
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "e2e-code");
        back.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        if (createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== state.challenge) return json(400, { error: "invalid_grant" });
        state.access = `e2e-access-${Date.now()}`;
        return json(200, { access_token: state.access, refresh_token: "e2e-refresh", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        if (req.headers.authorization !== `Bearer ${state.access}`) return json(401, {});
        const message = JSON.parse(raw);
        if (message.id === undefined) return res.writeHead(202).end();
        if (message.method === "initialize") return json(200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tickets", version: "1" } } });
        return json(200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "get_ticket", description: "Reads a ticket" }, { name: "close_ticket", description: "Closes a ticket" }] } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, close: () => server.close() };
}

/** Takes an integration a test set up away again, so the specs after it run on the orchestrator they expect. */
async function undo(page: Page, method: string, path: string) {
  const { csrf } = await (await page.request.get("/api/me")).json();
  await page.request.fetch(path, { method, headers: { "x-csrf-token": csrf } });
}

test.describe("the Integrations page for an admin", () => {
  test("given no GitLab application registered, when an admin opens Integrations, then the GitLab card says the next step once, and the settings' names wait behind its (i)", async ({ page }) => {
    // given
    const integrations = "/demo/integrations";

    // when
    await page.goto(integrations);

    // then
    const card = page.locator("#card-gitlab");
    await expect(card).toContainText("Whoever runs the orchestrator registers it as a GitLab OAuth application first; until then, connect with a token under Other ways to connect.");
    await expect(card).not.toContainText("Connect a repository with a token");
    const settings = card.getByText("Its operator sets ORCHESTRATOR_FORGE_GITLAB_*, ORCHESTRATOR_PUBLIC_URL and ORCHESTRATOR_SECRET_KEY, as the operator's guide to forge applications describes.");
    await expect(settings).toBeHidden();
    await card.getByLabel("About connecting GitLab with one click").click();
    await expect(settings).toBeVisible();
  });

  test("given the page, when an admin searches for slack, then only the Slack card stays", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
    const page_ = page.getByRole("region", { name: "Integrations" });
    await expect(page_.getByRole("heading", { level: 2 })).toHaveText(["Start here", "Code hosting", "Notifications", "Issue tracking", "MCP servers"]);
    await expect(page_.getByRole("heading", { level: 3 })).toHaveText(["Jira", "Linear", "Notion", "Sentry", "GitLab", "GitHub", "Slack", "Issue tracker", "Automations", "Orchestrator MCP", "Team MCP servers", "Your MCP servers"]);
    const mcp = page.getByRole("region", { name: "MCP servers" });
    await expect(mcp.getByText("From Claude Code to the orchestrator: teammates reach the orchestrator from their own sessions.")).toBeVisible();
    await expect(mcp.getByText("For your team's tasks: the servers the team repositories declare.")).toBeVisible();
    await expect(mcp.getByText("For your own tasks: servers only the tasks you start get.")).toBeVisible();
    if (process.env.ORCHESTRATOR_E2E_SHOTS) await page.screenshot({ path: `${process.env.ORCHESTRATOR_E2E_SHOTS}/integrations.png`, fullPage: true });

    // when
    await page.getByPlaceholder("Search integrations").fill("slack");

    // then
    await expect(page.getByRole("region", { name: "Integrations" }).getByRole("heading", { level: 2 })).toHaveText(["Notifications"]);
    await expect(page.getByRole("region", { name: "Integrations" }).getByRole("heading", { level: 3 })).toHaveText(["Slack"]);
  });

  test("given the store not answering, when an admin opens the page and retries once it answers, then the page says what failed to load and why, offers no search meanwhile, and shows the cards after the retry", async ({ page }) => {
    // given
    let refused = true;
    await page.route("**/api/integrations", async (route) => {
      if (!refused) return route.fallback();
      refused = false;
      return route.fulfill({ status: 503, json: { error: "The store did not answer.", code: "store-unreachable" } });
    });
    await page.goto("/demo/integrations");
    await expect(page.getByRole("alert")).toContainText("Couldn't load integrations. The store did not answer.");
    await expect(page.getByPlaceholder("Search integrations")).toHaveCount(0);

    // when
    await page.getByRole("button", { name: "Retry integrations" }).click();

    // then
    await expect(page.getByRole("region", { name: "Integrations" }).getByRole("heading", { level: 2 })).toHaveText(["Start here", "Code hosting", "Notifications", "Issue tracking", "MCP servers"]);
    await expect(page.getByPlaceholder("Search integrations")).toBeVisible();
    await expect(page.getByText("Couldn't load integrations.")).toHaveCount(0);
  });

  test("given a link to the issue tracker card, as Get started's optional step gives, when an admin follows it, then the page opens on that card alone", async ({ page }) => {
    // when
    await page.goto("/demo/integrations?open=tracker");

    // then
    await expect(page.getByRole("region", { name: "Issue tracker" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Slack" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close" })).toHaveCount(1);
  });

  test("given a Slack app set up by whoever runs the orchestrator, when an admin presses Add to Slack and Slack sends them back, then Slack is the one action with the webhook address under Other ways, and the card says it is added and posts every event; without that app it says what to set", async ({ page }) => {
    // given
    let added = false;
    const withSlack = async (route: Route, over: Record<string, unknown>) => {
      const read = (await (await route.fetch()).json()) as { integrations: { id: string }[] };
      return route.fulfill({ json: { ...read, integrations: read.integrations.map((c) => (c.id === "slack" ? { ...c, ...over } : c)) } });
    };
    await page.route("**/api/integrations/slack/add", (route) => route.fulfill({ json: { authorizeUrl: "/demo/integrations?slack=added" } }));
    await page.route("**/api/integrations", (route) => withSlack(route, added ? { state: "connected", addable: true, events: ["request.opened"] } : { state: "off", addable: true, redirectUri: "https://orchestrator.example.invalid/integrations/mcp-oauth/callback" }));

    // when
    await page.goto("/demo/integrations");
    const slack = page.getByRole("region", { name: "Slack" });
    await slack.getByText("Other ways to connect").click();

    // then
    await expect(slack.getByRole("button", { name: "Add to Slack" })).toBeVisible();
    await expect(slack.getByLabel("Incoming webhook address")).toBeVisible();

    // when Slack sends the person back
    added = true;
    await slack.getByRole("button", { name: "Add to Slack" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/integrations\?slack=added$/);
    await expect(page.getByText("Slack added the channel. Pick the events to post below.")).toBeVisible();

    // and without a Slack app, the card keeps the webhook form and says what to set
    await page.unroute("**/api/integrations");
    await page.route("**/api/integrations", (route) => withSlack(route, { state: "off", addable: false, redirectUri: "https://orchestrator.example.invalid/integrations/mcp-oauth/callback" }));
    await page.goto("/demo/integrations");
    await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Slack", exact: true }) }).getByRole("button", { name: "Set up" }).click();
    await expect(page.getByText(/^To add Slack in one press, whoever runs this orchestrator registers a Slack app with the redirect address https:\/\/orchestrator\.example\.invalid\/integrations\/mcp-oauth\/callback and sets ORCHESTRATOR_SLACK_CLIENT_ID/)).toBeVisible();
  });

  test("given an orchestrator with no address a sign-in returns to, when an admin opens Integrations, then Start here says what whoever runs it sets, each sign-in is off and tied to that line, and the API token stays", async ({ page }) => {
    // given
    await page.route("**/api/integrations", async (route) => route.fulfill({ json: { ...(await (await route.fetch()).json()), signIn: false } }));

    // when
    await page.goto("/demo/integrations");

    // then
    const start = page.getByRole("region", { name: "Start here" });
    await expect(start.locator("#start-no-return")).toHaveText("A sign-in returns to this orchestrator's own address, and none is set. Whoever runs it sets ORCHESTRATOR_PUBLIC_URL; until then these sign-ins are off.");
    for (const name of ["Sign in with Atlassian", "Sign in with Linear", "Sign in with Notion", "Sign in with Sentry"]) {
      const button = start.getByRole("button", { name });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-describedby", "start-no-return");
    }
    const jira = page.getByRole("region", { name: "Jira" });
    await jira.getByText("Other ways to connect").click();
    await expect(jira.getByRole("button", { name: "Use an API token instead" })).toBeEnabled();
  });

  test("given Jira not connected, when the person signs in with Atlassian and approves it there, then they return to a Jira card that says Connected with its boards and opens Work, asked for no name, address or kind", async ({ page }) => {
    // given
    let signedIn = false;
    await page.route("**/api/integrations/jira/sign-in", (route) => route.fulfill({ json: { authorizeUrl: "/stand-in-atlassian/authorize" } }));
    await page.route("**/stand-in-atlassian/authorize", (route) => {
      signedIn = true;
      return route.fulfill({ status: 302, headers: { location: "/demo/integrations?connected=atlassian" } });
    });
    await page.route("**/api/integrations", async (route) => {
      const read = await (await route.fetch()).json();
      return route.fulfill({ json: { ...read, jira: { mcp: signedIn ? { name: "atlassian", connected: true } : null } } });
    });
    await page.route("**/api/work/boards?source=mcp*", (route) => route.fulfill({ json: { boards: [{ id: "mcp:atlassian~c.PAY", name: "Payments" }, { id: "mcp:atlassian~c.HR", name: "People" }], fetchedAt: null, stale: false } }));
    await page.goto("/demo/integrations");
    const jira = page.getByRole("region", { name: "Jira" });
    await jira.getByText("Other ways to connect").click();
    await expect(jira.getByRole("button", { name: "Use an API token instead" })).toBeVisible();

    // when
    await jira.getByRole("button", { name: "Sign in with Atlassian" }).click();

    // then
    await expect(page).toHaveURL(/\/demo\/integrations\?connected=atlassian$/);
    await expect(jira.getByText("Connected")).toBeVisible();
    await expect(jira).toContainText("Read through Atlassian as you. 2 boards on Work. Nothing in Jira changes.");
    await expect(jira.getByRole("link", { name: "Open Work" })).toHaveAttribute("href", "/demo/work");
    await expect(jira.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Your MCP servers" })).toHaveCount(0);
  });

  test("given a Slack stand-in, when an admin connects it and sends a test message, then the card is connected by them, the message arrives, and the address is not shown", async ({ page }) => {
    // given
    const slack = await fakeSlack();
    try {
      await page.goto("/demo/integrations");
      const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Slack" }) });
      await card.getByRole("button", { name: "Set up" }).click();

      // when
      await expect(card.getByLabel("Something stopped working")).toBeChecked();
      await expect(card.getByLabel("It works again")).toBeChecked();
      await card.getByLabel("Incoming webhook address").fill(slack.url);
      await card.getByLabel("Request closed").uncheck();
      await card.getByRole("button", { name: "Save" }).click();
      await expect(card.getByRole("status")).toHaveText(/Saved/);
      await card.getByRole("button", { name: "Send a test message" }).click();

      // then
      await expect(card.getByText("Connected")).toBeVisible();
      await expect(card.getByText(/^Enabled by Ada Admin on \d{4}-\d{2}-\d{2}$/)).toBeVisible();
      await expect(card.getByText(/Last message .*: Delivered\./)).toBeVisible();
      expect(slack.received).toEqual([{ text: "A test message from the TeamHandbook Orchestrator, sent by Ada Admin." }]);
      expect(await page.content()).not.toContain(slack.url);
      await expect(card.getByLabel("Request closed")).not.toBeChecked();

      // when Disconnect is pressed, it asks first, and keeping Slack changes nothing
      await card.getByRole("button", { name: "Disconnect Slack" }).click();
      await expect(card.getByRole("group", { name: "Disconnect Slack" })).toContainText("the webhook address is deleted");
      await card.getByRole("button", { name: "Keep Slack" }).click();
      await expect(card.getByText("Connected")).toBeVisible();

      // when it is confirmed, then Slack is off
      await card.getByRole("button", { name: "Disconnect Slack" }).click();
      await card.getByRole("group", { name: "Disconnect Slack" }).getByRole("button", { name: "Disconnect Slack" }).click();
      await expect(card.getByRole("status")).toHaveText("Slack is disconnected and its webhook address removed.");
      await expect(card.getByText("Not set up")).toBeVisible();
    } finally {
      await undo(page, "DELETE", "/api/integrations/slack");
      slack.server.close();
    }
  });

  test("given the Orchestrator MCP card on an orchestrator with keys and an event log, when an admin sets it up for a repository, then the request it would open is proposed with the entry, and Cancel opens nothing", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Orchestrator MCP" }) });
    await card.getByRole("button", { name: /Set up|Manage/ }).click();
    await expect(card.getByText(/Teammates reach it at .*\/mcp/)).toBeVisible();
    const before = await (await page.request.get("/api/requests?status=open")).json();

    // when
    await card.getByRole("row", { name: /payments-skills/ }).getByRole("button", { name: "Set up" }).click();
    await card.getByRole("button", { name: "Review the request" }).click();

    // then
    await expect(card.getByLabel("Commit message")).toHaveValue(/feat\(mcp\): add the TeamHandbook Orchestrator server/);
    await expect(card.getByText(/"url": "http:\/\/127\.0\.0\.1:\d+\/mcp"/)).toBeVisible();
    await card.getByRole("button", { name: "Cancel" }).click();
    expect((await (await page.request.get("/api/requests?status=open")).json()).total).toBe(before.total);
  });

  test("given a Jira site, when an admin saves it with an API token, then the card says issues are read and never shows the token", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Issue tracker" }) });
    await card.getByRole("button", { name: /Set up|Manage/ }).click();

    // when
    await card.getByLabel("Address").fill("https://acme.atlassian.example");
    await card.getByLabel("Account email").fill("bot@example.invalid");
    await card.getByLabel("API token").fill("stand-in-token-0001");
    await card.getByRole("button", { name: "Save" }).click();

    // then
    try {
      await expect(card.getByText(/^Issues are read with a token set by ada@example.invalid/)).toBeVisible();
      await expect(card.getByRole("switch", { name: "Move Jira issues when a card moves on Work" })).toHaveAttribute("aria-checked", "false");
      await expect(card.getByText("Off: the orchestrator reads Jira and changes nothing there.")).toBeVisible();
      await expect(card.getByLabel("API token")).toHaveValue("");
      expect(await page.content()).not.toContain("stand-in-token-0001");
    } finally {
      await undo(page, "DELETE", "/api/integrations/tracker");
    }
  });

  test("given an MCP server that signs people in, when an admin adds it and connects it, then its tools load by themselves, only the reading one ticked and the writing one apart, noted once ticked by hand, and after saving it shows connected with the reading tool and no token on the page", async ({ page }) => {
    // given
    const server = await signingInServer();
    try {
      await page.goto("/demo/integrations");
      const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Your MCP servers" }) });
      await card.getByRole("button", { name: "Manage" }).click();
      const form = card.getByRole("form", { name: "Add an MCP server" });
      await form.getByLabel("Name", { exact: true }).fill("tickets");
      await form.getByLabel("URL", { exact: true }).fill(`${server.base}/mcp`);
      await form.getByRole("button", { name: "Add" }).click();
      const row = card.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "tickets" }) });

      // when
      await row.getByRole("button", { name: "Connect" }).click();
      await expect(page.getByRole("status").filter({ hasText: "tickets is connected" })).toHaveText("tickets is connected. Pick the tools a task may use.");
      const back = card.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "tickets" }) });
      await expect(back.getByRole("status")).toHaveText("Only tools that read are ticked; tick any other yourself. Save tools to let the tasks you start use tickets.");
      await expect(back.getByRole("group", { name: "Reads" }).getByLabel("get_ticket")).toBeChecked();
      await expect(back.getByRole("group", { name: "Writes" }).getByLabel("close_ticket")).not.toBeChecked();
      await expect(back.getByRole("note")).toHaveCount(0);
      await back.getByLabel("close_ticket").check();
      await expect(back.getByRole("note")).toHaveText(/^This lets a task change things in tickets as you: close_ticket\./);
      await back.getByLabel("close_ticket").uncheck();
      await expect(back.getByRole("note")).toHaveCount(0);
      await back.getByRole("button", { name: "Save tools" }).click();

      // then
      await expect(back.getByText("Tasks may use: get_ticket")).toBeVisible();
      await expect(back.getByText(/^Connected until /)).toBeVisible();
      expect(await page.content()).not.toContain(server.state.access);

      // when Remove is pressed, it says what is lost before anything is
      await back.getByRole("button", { name: "Remove tickets" }).click();
      await expect(back.getByRole("group", { name: "Remove tickets" })).toContainText("This cannot be undone.");
      await back.getByRole("button", { name: "Keep tickets" }).click();
      await expect(back.getByText("Tasks may use: get_ticket")).toBeVisible();
    } finally {
      await undo(page, "DELETE", "/api/me/mcp-servers/tickets");
      server.close();
    }
  });

  test("given the add form set for a team, when an admin checks a server for Payments, then the request it would open is proposed, and Cancel opens nothing", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Your MCP servers" }) });
    await card.getByRole("button", { name: "Manage" }).click();
    const form = card.getByRole("form", { name: "Add an MCP server" });
    await choose(form, "For", "The Payments team, through a request on payments-skills");
    await form.getByLabel("Name", { exact: true }).fill("tickets");
    await form.getByLabel("URL", { exact: true }).fill("https://tickets.example.invalid/mcp");
    const before = (await (await page.request.get("/api/requests?status=open")).json()).total;

    // when
    await form.getByRole("button", { name: "Review the request" }).click();
    await card.getByRole("button", { name: "Check the server" }).click();

    // then
    await expect(card.getByLabel("Commit message")).toHaveValue(/feat\(mcp\): add tickets/);
    await card.getByRole("button", { name: "Cancel" }).click();
    expect((await (await page.request.get("/api/requests?status=open")).json()).total).toBe(before);
    expect((await (await page.request.get("/api/me/mcp-servers")).json()).servers).toEqual([]);
  });

  test("given the demo's repositories read from a path, when an admin opens the GitLab card, then each says its requests open on the orchestrator's own copy, and the card shows the line of the configuration to change", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.locator("#card-gitlab");

    // when
    await card.getByText("Other ways to connect", { exact: true }).click();

    // then
    await expect(card.getByRole("row", { name: /payments-skills/ })).toContainText("A path on the server");
    await expect(card.getByRole("row", { name: /payments-skills/ })).toContainText("The orchestrator's own copy");
    await card.getByText(/^Open the requests of .* on GitLab$/).click();
    await expect(card.getByText(/"url": "https:\/\/gitlab\.com\/<group>\/<project>\.git"/)).toBeVisible();
  });

  test("given GitHub connected for the organization, when an admin opens the GitHub card, connects a listed repository and creates the team repository, then each is sent as asked and the card says what came of it", async ({ page }) => {
    // given
    const sent: { path: string; body: unknown }[] = [];
    await page.route("**/api/forge/github/**", async (route) => {
      const url = new URL(route.request().url());
      const body = route.request().postDataJSON() as unknown;
      if (route.request().method() !== "GET") sent.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/connection/check")) return route.fulfill({ json: { check: { ok: false, account: "acme", granted: ["metadata: read"], missing: ["issues: read"], version: null, problem: "The app is not allowed to read issues." } } });
      if (url.pathname.endsWith("/connection")) return route.fulfill({ json: { connection: { via: "app", account: "acme", by: "Ada Admin", at: "2026-11-02T10:00:00.000Z", repos: 0, problem: null }, available: true, missing: [] } });
      if (url.pathname.endsWith("/repos")) return route.fulfill({ json: { repos: [{ fullName: "acme/payments-api", url: "https://github.example/acme/payments-api.git", connected: null, empty: false }, { fullName: "acme/skills", url: "https://github.example/acme/skills.git", connected: "skills", empty: false }] } });
      if (url.pathname.endsWith("/repos/connect")) return route.fulfill({ json: { repo: { id: "payments-api", name: "payments-api", team: "Payments", url: "https://github.example/acme/payments-api.git" } } });
      if (url.pathname.endsWith("/team-repo")) return route.fulfill({ json: { repo: { id: "payments-skills-2", name: "payments-skills-2", team: "Payments", url: "https://github.example/acme/payments-skills-2.git" }, webhook: "installed" } });
      return route.fulfill({ status: 404, json: { error: "not found" } });
    });
    await page.goto("/demo/integrations");
    const card = page.locator("#card-github");

    // when
    await card.getByText("Other ways to connect", { exact: true }).click();
    const listed = card.getByRole("list", { name: "GitHub repositories" });
    await listed.getByRole("combobox", { name: "Team for acme/payments-api" }).fill("Payments");
    await listed.getByRole("button", { name: "Connect acme/payments-api" }).click();
    await card.getByRole("button", { name: "Create team repository" }).click();
    const form = card.getByRole("form", { name: "Create team repository" });
    await form.getByRole("textbox", { name: "Name" }).fill("payments-skills-2");
    await form.getByRole("combobox", { name: "Team" }).fill("Payments");
    await form.getByRole("button", { name: "Create repository" }).click();

    // then
    await expect(card.getByText("Connected as acme by Ada Admin on 2026-11-02.")).toBeVisible();
    await expect(listed.getByRole("listitem").filter({ hasText: "acme/skills" })).toContainText("Connected");
    await expect(card.getByRole("status").filter({ hasText: "Created acme/payments-skills-2." })).toBeVisible();
    expect(sent).toEqual([
      { path: "/api/forge/github/repos/connect", body: { fullName: "acme/payments-api", team: "Payments" } },
      { path: "/api/forge/github/team-repo", body: { name: "payments-skills-2", team: "Payments", visibility: "private" } },
    ]);
    await expect(card.getByRole("button", { name: "Disconnect GitHub" })).toBeVisible();
    await card.getByRole("button", { name: "Check connection" }).click();
    await expect(card.getByRole("alert").filter({ hasText: "The app is not allowed to read issues." })).toBeVisible();
    await expect(card.getByRole("list", { name: "What the connection lacks" })).toHaveText("issues: read");
  });

  test("given a personal GitHub account the orchestrator cannot create a repository on, when an admin creates the team repository, then the card lists the steps to take on GitHub, each linked, and links to the app's repository choice", async ({ page }) => {
    // given
    const steps = [
      { text: "Create an empty repository named payments-skills on GitHub, without a README", url: "https://github.example/new?name=payments-skills" },
      { text: "Add it to the app's installation", url: "https://github.example/settings/installations/1" },
      { text: "Use acme/payments-skills as the team repository here", url: null },
    ];
    await page.route("**/api/forge/github/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/connection")) return route.fulfill({ json: { connection: { via: "app", account: "ada", by: "Ada Admin", at: "2026-11-02T10:00:00.000Z", repos: 0, problem: null, manageUrl: "https://github.example/settings/installations/1" }, available: true, missing: [] } });
      if (url.pathname.endsWith("/repos")) return route.fulfill({ json: { repos: [] } });
      if (url.pathname.endsWith("/team-repo")) return route.fulfill({ status: 409, json: { error: "a personal GitHub account takes no repository from an app", code: "team-repo", steps } });
      return route.fulfill({ status: 404, json: { error: "not found" } });
    });
    await page.goto("/demo/integrations");
    const card = page.locator("#card-github");
    await card.getByText("Other ways to connect", { exact: true }).click();

    // when
    await card.getByRole("button", { name: "Create team repository" }).click();
    const form = card.getByRole("form", { name: "Create team repository" });
    await form.getByRole("textbox", { name: "Name" }).fill("payments-skills");
    await form.getByRole("combobox", { name: "Team" }).fill("Payments");
    await form.getByRole("button", { name: "Create repository" }).click();

    // then
    const listed = card.getByRole("list", { name: "Steps to make the team repository" });
    await expect(listed.getByRole("listitem")).toHaveText(steps.map((s) => s.text));
    await expect(listed.getByRole("link", { name: steps[0]!.text })).toHaveAttribute("href", steps[0]!.url!);
    await expect(listed.getByRole("link")).toHaveCount(2);
    await expect(card.getByRole("link", { name: "Choose the repositories the GitHub app reaches" })).toHaveAttribute("href", "https://github.example/settings/installations/1");
  });

  test("given a GitLab.com connection and a self-managed GitLab reached with a token, when an admin opens the GitLab card, then each host is a card saying how it is reached, its repositories, and where to make the token and what it allows", async ({ page }) => {
    // given
    await page.route("**/api/forge/hosts", (route) =>
      route.fulfill({
        json: {
          hosts: [
            { kind: "gitlab", webUrl: "https://gitlab.com", apiUrl: "https://gitlab.com/api/v4", connection: { via: "oauth", account: "acme-bot", by: "Ada Admin", at: "2026-11-02T10:00:00.000Z", repos: 1, problem: null }, ownApplication: false, repos: [{ id: "payments-api", via: "connection" }], credentials: { tokenPage: "https://gitlab.com/-/user_settings/personal_access_tokens?name=TeamHandbook&scopes=api", scopes: ["api"] } },
            { kind: "gitlab", webUrl: "https://git.acme.example", apiUrl: "https://git.acme.example/api/v4", connection: null, ownApplication: true, repos: [{ id: "ledger", via: "token" }], credentials: { tokenPage: "https://git.acme.example/-/user_settings/personal_access_tokens?name=TeamHandbook&scopes=api", scopes: ["api"] } },
            { kind: "github", webUrl: "https://github.com", apiUrl: "https://api.github.com", connection: null, ownApplication: false, repos: [], credentials: { tokenPage: "https://github.com/settings/personal-access-tokens/new", scopes: [] } },
          ],
        },
      }),
    );
    await page.goto("/demo/integrations");
    const card = page.locator("#card-gitlab");

    // when
    await card.getByText("Other ways to connect", { exact: true }).click();

    // then
    const hosts = card.getByRole("list", { name: "GitLab hosts" }).getByRole("listitem");
    await expect(hosts).toHaveCount(2);
    await expect(hosts.nth(0)).toContainText("GitLab at gitlab.com");
    await expect(hosts.nth(0)).toContainText("Connected as acme-bot.");
    await expect(hosts.nth(0)).toContainText("payments-api through the connection.");
    await expect(hosts.nth(1)).toContainText("The organization's own application is entered; nobody connected through it yet.");
    await expect(hosts.nth(1)).toContainText("ledger with a token.");
    await expect(hosts.nth(1).getByRole("link", { name: "git.acme.example" })).toHaveAttribute("href", "https://git.acme.example/-/user_settings/personal_access_tokens?name=TeamHandbook&scopes=api");
    await expect(hosts.nth(1)).toContainText("that allows: api.");
  });

  test("given the organization's Jira with its token and the Customers board unmapped, when an admin maps it to Payments and back to none, then each choice is sent and said", async ({ page }) => {
    // given
    const sent: unknown[] = [];
    let team: string | null = null;
    await page.route("**/work/boards/teams", async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as { boards: { team: string | null }[] };
        sent.push(body);
        team = body.boards[0]!.team;
      }
      return route.fulfill({ json: { boards: [{ boardId: "tracker~7", name: "Customers", team }] } });
    });
    await page.route("**/api/integrations", async (route) => {
      const read = (await (await route.fetch()).json()) as { integrations: { id: string }[] };
      const tracker = { id: "tracker", state: "connected", enabledBy: "Ada Admin", enabledAt: "2026-11-02T10:00:00.000Z", config: { kind: "jira", url: "https://jira.example", email: "bot@example.invalid" }, token: { setAt: "2026-11-02T10:00:00.000Z", setBy: "ada@example.invalid" }, webhook: null, writeBack: false };
      return route.fulfill({ json: { ...read, integrations: read.integrations.map((c) => (c.id === "tracker" ? tracker : c)) } });
    });
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Issue tracker", exact: true }) });
    await card.getByRole("button", { name: "Manage" }).click();
    const section = card.getByRole("region", { name: "Boards and teams" });

    // when
    await section.getByRole("combobox", { name: "Team for Customers" }).selectOption("Payments");
    await expect(section.getByRole("status")).toHaveText("Customers is shown to Payments.");
    await section.getByRole("combobox", { name: "Team for Customers" }).selectOption("");

    // then
    await expect(section.getByRole("status")).toHaveText("Customers is shown to owners and admins only.");
    expect(sent).toEqual([{ boards: [{ boardId: "tracker~7", team: "Payments" }] }, { boards: [{ boardId: "tracker~7", team: null }] }]);
  });

  test("given the tracker's Customers board, when an admin adds an automation drafting a task when an issue moves into In Dev, then it is listed with what it does, and its deliveries read from the log", async ({ page }) => {
    // given
    const saved: unknown[] = [];
    const automation = { id: "aut_e2e", name: "Draft in dev", board: "tracker~7", project: "HOO", trigger: { kind: "column", column: "In Dev", statuses: ["In Dev"] }, filter: { labels: [], types: [] }, repoId: "payments-skills", agent: "fake", action: "draft", enabled: true, perMinute: 3, by: { id: "u", name: "Ada Admin" }, at: "2026-11-02T10:00:00.000Z" };
    await page.route("**/api/work/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/work/boards")) return route.fulfill({ json: { boards: [{ id: "tracker~7", name: "Customers", type: "scrum", project: "HOO", url: "https://jira.example/board/7", team: null }], fetchedAt: "", stale: false } });
      if (url.pathname.endsWith("/columns")) return route.fulfill({ json: { columns: [{ name: "Ready for Dev", statuses: ["Ready for Dev"] }, { name: "In Dev", statuses: ["In Dev"] }] } });
      if (url.pathname.endsWith("/deliveries")) return route.fulfill({ json: { deliveries: [{ at: "2026-11-02T10:05:00.000Z", detail: "HOO-412 moved to In Dev: a task is drafted for someone to start" }] } });
      if (url.pathname.endsWith("/work/automations")) {
        if (route.request().method() === "POST") {
          saved.push(route.request().postDataJSON());
          return route.fulfill({ json: { automation } });
        }
        return route.fulfill({ json: { enabled: true, automations: saved.length ? [automation] : [] } });
      }
      return route.fulfill({ status: 404, json: { error: "not found" } });
    });
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Automations", exact: true }) });
    await card.getByRole("button", { name: "Manage" }).click();

    // when
    await card.getByRole("button", { name: "Add automation" }).click();
    const form = card.getByRole("form", { name: "Add automation" });
    await form.getByRole("textbox", { name: "Name" }).fill("Draft in dev");
    await form.getByRole("combobox", { name: /^Board/ }).selectOption("tracker~7");
    await form.getByRole("combobox", { name: /^Column/ }).selectOption("In Dev");
    await expect(form.getByRole("combobox", { name: /^Repository/ })).toHaveValue("payments-skills");
    await expect(form.getByRole("combobox", { name: /^Agent/ })).toHaveValue("fake");
    await form.getByRole("button", { name: "Add automation" }).click();

    // then
    await expect(card.getByRole("status")).toHaveText("Draft in dev is set up.");
    expect(saved).toEqual([expect.objectContaining({ name: "Draft in dev", board: "tracker~7", trigger: { kind: "column", column: "In Dev" }, action: "draft" })]);
    const listed = card.getByRole("list", { name: "Automations" });
    await expect(listed).toContainText("When an issue of HOO moves into In Dev, draft a task for someone to start on payments-skills with fake.");
    await listed.getByRole("button", { name: "Deliveries" }).click();
    await expect(card.getByRole("list", { name: "Deliveries of Draft in dev" })).toContainText("HOO-412 moved to In Dev: a task is drafted for someone to start");
  });

  /** One person's own gh and glab as the cards read them: gh signed in, glab not on this machine. */
  const ownCli = (id: string) =>
    id === "github"
      ? { tool: "gh", name: "GitHub's gh", host: "github.com", installed: true, signedIn: true, account: "ada", version: "2.103.3", helper: true, install: "https://cli.github.com", login: "gh auth login --hostname github.com", repos: ["payments-skills"] }
      : { tool: "glab", name: "GitLab's glab", host: "gitlab.com", installed: false, signedIn: false, account: null, version: null, helper: false, install: "https://gitlab.com/gitlab-org/cli", login: "glab auth login --hostname gitlab.com", repos: [] };
  // A card that signs in reloads the page's integrations as the test ends; that late read is let go rather than failing the next test.
  const asLocal = async (page: Page) =>
    page.route("**/api/integrations", async (route) => {
      const answer = await route.fetch().catch(() => null);
      if (!answer) return;
      const read = (await answer.json()) as { integrations: { id: string }[] };
      await route.fulfill({ json: { ...read, local: true, claudeCodeServers: 11 } }).catch(() => undefined);
    });

  test("given the orchestrator on one person's own machine, when they open Integrations, then the page is laid out as a team's is, says how many MCP servers of their own Claude Code their tasks use in place of listing them, offers their own gh and glab each as one action, and keeps the tracker's token one press from Jira", async ({ page }) => {
    // given
    await asLocal(page);
    await page.route("**/api/forge/*/sign-in", (route) => {
      const kind = new URL(route.request().url()).pathname.split("/")[3]!;
      return route.fulfill({ json: { offered: true, why: null, cli: ownCli(kind), installLine: kind === "gitlab" ? "brew install glab" : null, signIn: { state: "idle" } } });
    });

    // when
    await page.goto("/demo/integrations");
    const region = page.getByRole("region", { name: "Integrations" });

    // then
    await expect(region.getByText("Services the orchestrator works with.", { exact: true })).toBeVisible();
    await expect(region.getByText("Your tasks use the 11 MCP servers in your Claude Code.")).toBeVisible();
    await expect(region.getByRole("heading", { name: "Found on this machine" })).toHaveCount(0);
    await expect(region.getByRole("heading", { level: 2 })).toHaveText(["Start here", "Code hosting", "Notifications", "Issue tracking", "MCP servers"]);
    await expect(region.getByRole("heading", { level: 3 })).toHaveText(["Jira", "Linear", "Notion", "Sentry", "GitLab", "GitHub", "Slack", "Issue tracker", "Automations", "Orchestrator MCP", "Team MCP servers", "Your MCP servers"]);
    await expect(region.getByRole("button", { name: /^Connect with GitLab/ })).toHaveCount(0);
    await expect(region.getByRole("list", { name: "GitLab hosts" })).toHaveCount(0);
    const gitlab = page.locator("#card-gitlab");
    await expect(gitlab).toContainText("GitLab's glab is not on this machine. Install it, then check again.");
    await expect(gitlab).toContainText("brew install glab");
    await expect(gitlab.getByRole("button", { name: "Check again" })).toBeVisible();
    await expect(gitlab.getByRole("button", { name: /^Set up GitLab for/ })).toHaveCount(0);
    const github = page.locator("#card-github");
    await expect(github.getByText("Connected", { exact: true })).toBeVisible();
    await expect(github).toContainText("Connected as ada on github.com.");
    await expect(github.getByRole("link", { name: "Connect a repository on GitHub" })).toHaveCount(0);

    // when they would rather read issues with a token
    const jira = page.getByRole("region", { name: "Jira" });
    await jira.getByText("Other ways to connect").click();
    await expect(jira).toContainText("Read Jira, Linear or GitLab issues with an API token instead.");
    await jira.getByRole("button", { name: "Use an API token instead" }).click();

    // then the tracker's card opens, the one place its token is set
    await expect(region.getByRole("heading", { level: 3, name: "Issue tracker" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Issue tracker" }).getByRole("combobox", { name: "Tracker" })).toBeVisible();
  });

  test("given gh on one person's machine and not signed in, when they press Sign in with GitHub, then the card shows the code to enter and the page to enter it on, and says Connected once gh has signed in", async ({ page }) => {
    // given
    await asLocal(page);
    let signedIn = false;
    let started = 0;
    await page.route("**/api/forge/*/sign-in", (route) => {
      const kind = new URL(route.request().url()).pathname.split("/")[3]!;
      if (route.request().method() === "POST") started += 1;
      const cli = kind === "github" ? { ...ownCli("github"), signedIn, account: signedIn ? "ada" : null, repos: [] } : ownCli("gitlab");
      const signIn = kind !== "github" || !started ? { state: "idle" } : signedIn ? { state: "done", account: "ada" } : { state: "waiting", code: "ABCD-1234", url: "https://github.com/login/device" };
      return route.fulfill({ json: { offered: true, why: null, cli, installLine: null, signIn } });
    });
    await page.goto("/demo/integrations");
    const github = page.locator("#card-github");

    // when
    await github.getByRole("button", { name: "Sign in with GitHub" }).click();

    // then
    await expect(github.getByRole("status")).toContainText("Enter ABCD-1234 on GitHub: Open GitHub. Waiting for GitHub.");
    await expect(github.getByRole("link", { name: "Open GitHub" })).toHaveAttribute("href", "https://github.com/login/device");
    await expect(github.getByRole("button", { name: "Sign in with GitHub" })).toBeDisabled();
    signedIn = true;
    await expect(github.getByText("Connected", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(github).toContainText("Connected as ada on github.com.");
    expect(started).toBe(1);
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test(`given every card opened in the ${colorScheme} theme, when axe checks the page, then it finds no violation`, async ({ page }) => {
      // given
      await page.emulateMedia({ colorScheme });
      await page.goto("/demo/integrations");
      await page.locator("#card-gitlab").getByText("Other ways to connect", { exact: true }).click();
      for (const name of ["Slack", "Issue tracker", "Automations", "Orchestrator MCP", "Team MCP servers", "Your MCP servers"]) {
        await page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: true }) }).getByRole("button", { name: /Set up|Manage/ }).click();
      }

      // when
      const result = await new AxeBuilder({ page }).withTags(RULES).analyze();

      // then
      expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
    });
  }
});

test.describe("the Integrations page for a member", () => {
  test.use({ storageState: stateFor("member") });

  test("given a member, when they open the tracker card, then they read it, cannot change it, and see that changing issues is off and theirs to ask for", async ({ page }) => {
    // given
    await page.goto("/demo/integrations");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Issue tracker" }) });

    // when
    await card.getByRole("button", { name: /Set up|Manage/ }).click();

    // then
    await expect(card.getByRole("switch", { name: "Move Jira issues when a card moves on Work" })).toBeDisabled();
    await expect(card.getByText("Off: the orchestrator reads Jira and changes nothing there. An owner or an admin turns it on.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Save" })).toHaveCount(0);
  });
});
