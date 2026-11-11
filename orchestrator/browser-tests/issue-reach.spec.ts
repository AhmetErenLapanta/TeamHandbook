import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { newTaskForm, work } from "./task-form.js";

// Where the before and after pictures of this screen go, when a run is asked to take them.
const SHOTS = process.env.ORCHESTRATOR_E2E_SHOTS;
const ISSUE = "https://acme.atlassian.example/browse/PAY-142";

/** A remote MCP server on this machine that signs people in and reads Jira the way Atlassian's does: a site's cloud id, then the issue. */
async function atlassianStandIn(): Promise<{ server: Server; base: string }> {
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
        const answer = (result: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result });
        const text = (value: unknown) => answer({ content: [{ type: "text", text: JSON.stringify(value) }] });
        if (message.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "atlassian", version: "1" } });
        if (message.method === "tools/list") return answer({ tools: [{ name: "getAccessibleAtlassianResources", description: "Sites", annotations: { readOnlyHint: true } }, { name: "getJiraIssue", description: "Reads an issue", annotations: { readOnlyHint: true } }, { name: "createJiraIssue", description: "Creates an issue" }] });
        if (message.params?.name === "getAccessibleAtlassianResources") return text([{ id: "cloud-1", url: "https://acme.atlassian.example", name: "acme" }]);
        if (message.params?.name === "getJiraIssue") return text({ key: message.params.arguments.issueIdOrKey, fields: { summary: "Round refunds half to even", status: { name: "In Progress" } } });
        return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

async function csrf(page: Page): Promise<Record<string, string>> {
  return { "x-csrf-token": (await (await page.request.get("/api/me")).json()).csrf };
}

/** Adds the stand-in as the signed-in person's own server, signs in to it in this browser, and allows its reading tools. */
async function connectAtlassian(page: Page, base: string): Promise<void> {
  await page.goto("/demo/integrations");
  const headers = await csrf(page);
  await page.request.post("/api/me/mcp-servers", { headers, data: { name: "atlassian", transport: "http", url: `${base}/mcp`, auth: "oauth" } });
  const { authorizeUrl } = await (await page.request.post("/api/me/mcp-servers/atlassian/connect", { headers })).json();
  await page.goto(authorizeUrl);
  await page.request.patch("/api/me/mcp-servers/atlassian", { headers, data: { tools: ["getAccessibleAtlassianResources", "getJiraIssue"] } });
}

test.describe("how the task form says an issue is read", () => {
  test("given an own MCP server that reads Jira and no issue tracker connected, when a Jira link is given, then the form says the agent reads it through that server as the person, and shows its key, title and status", async ({ page }) => {
    // given
    const { server, base } = await atlassianStandIn();
    try {
      await connectAtlassian(page, base);
      await page.goto("/demo/tasks");
      const form = await newTaskForm(page);

      // when
      await work(form, ISSUE);
      const card = form.getByRole("status", { name: "Issue" });
      await expect(card.getByRole("link", { name: "PAY-142" })).toBeVisible();
      if (SHOTS) await form.screenshot({ path: `${SHOTS}/issue-reach.png` });

      // then
      await expect(card).toContainText("PAY-142 Round refunds half to even");
      await expect(card).toContainText("In Progress");
      await expect(card.locator("p.muted")).toHaveText("The agent reads the issue through atlassian as you.");
    } finally {
      await page.request.delete("/api/me/mcp-servers/atlassian", { headers: await csrf(page) });
      server.close();
    }
  });
});
