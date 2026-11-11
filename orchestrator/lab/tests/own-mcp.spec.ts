import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { ownerKey } from "../state.js";
import { as, lab, SHAPES, signInOnPage, unique } from "./support.js";

interface OwnServer {
  name: string;
  auth: string;
  status?: string;
  connected?: boolean;
}

const { org, repo } = SHAPES[0]!;

test.describe("a person's own MCP server, signed in with OAuth", () => {
  test.beforeAll(async () => {
    // An unknown path under /api is answered with the page itself, so only a JSON answer means the route is there.
    const probe = await (await as(org, "member")).call("GET", "/api/me/mcp-servers");
    test.skip(probe.status !== 200 || "text" in probe.json, "this orchestrator has no personal MCP servers yet");
  });

  test(`given ${org.name}'s ${repo.team} owner, when they add the lab tracker as their own server and connect it in the browser, then its tools are listed through their sign-in, nobody else sees it, no token of theirs reaches an answer or the event log, a lapsed access token is refreshed, and disconnecting stops it`, async ({ browser }) => {
    test.setTimeout(180_000);
    // given
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInOnPage(page, org, ownerKey(repo.team));
    const { csrf } = (await (await page.request.get(`${org.url}/api/me`)).json()) as { csrf: string };
    const call = async (method: string, path: string, data?: unknown) => {
      const res = await page.request.fetch(`${org.url}${path}`, { method, headers: { "x-csrf-token": csrf }, ...(data === undefined ? {} : { data }) });
      return { status: res.status(), json: (await res.json().catch(() => ({}))) as Record<string, unknown>, text: await res.text() };
    };
    const name = unique("tracker").replace(/-/g, "_").slice(0, 30);

    // when the server is added and connected through the browser
    const added = await call("POST", "/api/me/mcp-servers", { name, description: "The lab tracker", transport: "http", url: `${lab.mcpOauth!.url}/mcp`, auth: "oauth" });
    const connect = await call("POST", `/api/me/mcp-servers/${name}/connect`);
    await page.goto(String(connect.json.authorizeUrl));
    await page.getByRole("button", { name: `Allow as ${(await (await as(org, ownerKey(repo.team))).ok<{ user: { email: string } }>("GET", "/api/me")).user.email}` }).click();
    await page.waitForLoadState("networkidle");
    const tools = await call("GET", `/api/me/mcp-servers/${name}/tools`);

    // then the person's own sign-in lists its tools
    expect(added.status, added.text).toBe(201);
    expect(tools.status, tools.text).toBe(200);
    expect(tools.text).toContain("getIssue");

    // and nobody else sees it
    const member = await OrchestratorClient.signIn(org.url, (await (await as(org, "member")).ok<{ user: { email: string } }>("GET", "/api/me")).user.email, lab.password);
    const theirs = await member.ok<{ servers?: OwnServer[] }>("GET", "/api/me/mcp-servers");
    expect(JSON.stringify(theirs)).not.toContain(name);

    // and no token the provider issued appears in what the orchestrator answers or logs
    const { tokens } = (await (await fetch(`${lab.mcpOauth!.url}/lab/tokens`)).json()) as { tokens: string[] };
    const listed = await call("GET", "/api/me/mcp-servers");
    const log = await (await as(org, "org-admin")).call("GET", "/api/events");
    for (const token of tokens) {
      expect(listed.text).not.toContain(token);
      expect(JSON.stringify(log.json)).not.toContain(token);
    }

    // when the access token has lapsed
    await page.waitForTimeout(21_000);
    const later = await call("GET", `/api/me/mcp-servers/${name}/tools`);

    // then the orchestrator refreshed it, and the tools are still listed
    expect(later.status, later.text).toBe(200);
    expect(later.text).toContain("getIssue");

    // when the person disconnects it
    await call("POST", `/api/me/mcp-servers/${name}/disconnect`);
    const after = await call("GET", `/api/me/mcp-servers/${name}/tools`);

    // then nothing is listed through it any longer
    expect(after.text).not.toContain("getIssue");
    await call("DELETE", `/api/me/mcp-servers/${name}`);
    await context.close();
  });
});
