import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, mirrorDir, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { recordEvent } from "../events.js";
import { gitAsync } from "../git.js";
import { forgeTokenName } from "../propose.js";
import { auditServer, detectSecret } from "../plugin.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import type { Audit } from "./audit.js";
import { ORCHESTRATOR_MCP_SERVER, orchestratorMcpEntry } from "./orchestrator-mcp.js";
import { cleanWebhook, notifySlack, slackMessage, withSlack } from "./slack.js";
import { issueAddress } from "./tracker.js";

const ADMIN: Principal = { id: "a", name: "Ada Admin", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const OWNER: Principal = { id: "p", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const MEMBER: Principal = { id: "m", name: "Max Member", email: "max@example.invalid", role: "member", ownedTeams: [] };
const PUBLIC_URL = "https://orchestrator.example.invalid";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

async function demo(extra: Partial<OrchestratorContext> = {}): Promise<{ ctx: OrchestratorContext; logged: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-integrations-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const logged: string[] = [];
  const audit: Audit = async (actor, kind, fields) => {
    logged.push(`${actor.id} ${kind} ${fields.detail}`);
  };
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant, allowedHosts: null, vault: createVault(randomBytes(32)), audit, ...extra };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return { ctx, logged };
}

function call(ctx: OrchestratorContext, user: Principal, method: string, path: string, body?: unknown) {
  return createApp(ctx, as(user)).request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
}

/** A stand-in for Slack's webhook on this machine, keeping each message it is sent. */
async function fakeSlack(status = 200): Promise<{ url: string; received: unknown[] }> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      received.push(JSON.parse(raw));
      res.statusCode = status;
      res.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/services/T000/B000/fake`, received };
}

describe("a Slack webhook address", () => {
  it("given addresses on Slack, on this machine and elsewhere, when each is cleaned, then only Slack's own and a loopback stand-in are taken", () => {
    // given
    const taken = ["https://hooks.slack.com/services/T0/B0/x", "http://127.0.0.1:9/services/x"];
    const refused = ["http://hooks.slack.com/services/T0/B0/x", "https://hooks.slack.com.example.invalid/services/x", "https://example.invalid/services/x", "https://hooks.slack.com/other", "http://10.0.0.5/services/x", "https://u:p@hooks.slack.com/services/x"];

    // when
    const outcome = (url: string) => {
      try {
        cleanWebhook(url);
        return "taken";
      } catch {
        return "refused";
      }
    };

    // then
    expect(taken.map(outcome)).toEqual(["taken", "taken"]);
    expect(refused.map(outcome)).toEqual(refused.map(() => "refused"));
  });

  it("given a request titled to page the whole channel, when it becomes a Slack message, then the mention and the link markup are shown as typed", () => {
    // given
    const event = { tenant: "t", kind: "request.opened", repoId: "payments-skills", subject: "request:3", detail: "<!channel> see <https://evil.example.invalid|the docs> & more", actor: { name: "Pat <Owner>" } };

    // when
    const { text } = slackMessage(event);

    // then
    expect(text).toBe("Request opened in payments-skills by Pat &lt;Owner&gt;: &lt;!channel&gt; see &lt;https://evil.example.invalid|the docs&gt; &amp; more");
  });
});

describe("Slack notifications", () => {
  it("given an admin who sets up Slack, when the integrations are read, then the card shows who turned it on and never the address", async () => {
    // given
    const { ctx, logged } = await demo();
    const slack = await fakeSlack();

    // when
    const saved = await call(ctx, ADMIN, "PUT", "/api/integrations/slack", { webhookUrl: slack.url, events: ["request.merged", "request.opened"] });
    const read = await call(ctx, MEMBER, "GET", "/api/integrations");
    const text = await read.text();

    // then
    expect(saved.status).toBe(200);
    const card = (JSON.parse(text).integrations as { id: string }[]).find((c) => c.id === "slack");
    expect(card).toMatchObject({ state: "connected", enabledBy: ADMIN.name, events: ["request.opened", "request.merged"] });
    expect(text).not.toContain(slack.url);
    expect(text).not.toContain("/services/");
    expect(logged).toEqual([`a integration.enabled Slack notifications for request.opened, request.merged`]);
  });

  it("given a member or a team owner, when they set up Slack, then they are refused and nothing is stored", async () => {
    // given
    const { ctx } = await demo();

    // when
    const tries = await Promise.all([MEMBER, OWNER].map((u) => call(ctx, u, "PUT", "/api/integrations/slack", { webhookUrl: "https://hooks.slack.com/services/T0/B0/x", events: ["request.opened"] })));

    // then
    expect(tries.map((r) => r.status)).toEqual([403, 403]);
    expect(await ctx.store.getSecret(ctx.tenant, "integration.slack.webhook")).toBeNull();
  });

  it("given Slack asked for merges only, when a merge and an opening are logged, then only the merge is posted and the delivery is recorded", async () => {
    // given
    const { ctx } = await demo();
    const slack = await fakeSlack();
    await call(ctx, ADMIN, "PUT", "/api/integrations/slack", { webhookUrl: slack.url, events: ["request.merged"] });
    const event = (kind: string) => ({ tenant: ctx.tenant, kind, repoId: "payments-skills", subject: "request:4", detail: "feat(skill): add refunds", actor: { name: "Pat Owner" } });

    // when
    const opened = await notifySlack(ctx, event("request.opened"));
    const merged = await notifySlack(ctx, event("request.merged"));

    // then
    expect(opened).toBeNull();
    expect(merged).toMatchObject({ ok: true });
    expect(slack.received).toEqual([{ text: "Request merged in payments-skills by Pat Owner: feat(skill): add refunds" }]);
  });

  it("given a store wrapped for Slack, when the event log records a merge, then the channel is told after the row is written", async () => {
    // given
    const { ctx } = await demo();
    const slack = await fakeSlack();
    await call(ctx, ADMIN, "PUT", "/api/integrations/slack", { webhookUrl: slack.url, events: ["request.merged"] });
    withSlack(ctx.store, () => ctx);

    // when
    await recordEvent(ctx, OWNER, "request.merged", { repoId: "payments-skills", subject: "request:4", detail: "merged request #4" });

    // then
    await expect.poll(() => slack.received.length).toBe(1);
    expect(slack.received).toEqual([{ text: "Request merged in payments-skills by Pat Owner: merged request #4" }]);
    expect((await ctx.store.eventPage(ctx.tenant, { kindPrefix: "request" }, null, 10)).events).toHaveLength(1);
  });

  it("given a webhook Slack has removed, when a test message is sent, then the card says so without the address", async () => {
    // given
    const { ctx } = await demo();
    const slack = await fakeSlack(404);
    await call(ctx, ADMIN, "PUT", "/api/integrations/slack", { webhookUrl: slack.url, events: ["request.merged"] });

    // when
    const tested = await (await call(ctx, ADMIN, "POST", "/api/integrations/slack/test")).json();

    // then
    expect(tested.delivery).toMatchObject({ ok: false, detail: "Slack answered 404; the webhook was removed or the address is wrong." });
    expect(JSON.stringify(tested)).not.toContain(slack.url);
  });
});

describe("the forge cards", () => {
  it("given a repository on GitLab with its token, when a member and an admin read the integrations, then only the admin reads its address, project and who set it", async () => {
    // given
    const { ctx } = await demo();
    await ctx.store.setForgeConfig(ctx.tenant, { repoId: "payments-skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/payments-skills" });
    await ctx.store.putSecret(ctx.tenant, forgeTokenName({ repoId: "payments-skills", apiUrl: "https://gitlab.example.invalid/api/v4" }), "sealed", ADMIN.email);
    const gitlab = async (user: Principal) => ((await (await call(ctx, user, "GET", "/api/integrations")).json()).integrations as { id: string }[]).find((c) => c.id === "gitlab");

    // when
    const member = await gitlab(MEMBER);
    const admin = await gitlab(ADMIN);

    // then
    expect(member).toMatchObject({ state: "connected", repos: [{ repoId: "payments-skills", apiUrl: "", project: "", setBy: "" }] });
    expect(JSON.stringify(member)).not.toContain(ADMIN.email);
    expect(admin).toMatchObject({ repos: [{ apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/payments-skills" }] });
  });
});

describe("the issue tracker", () => {
  it("given a Jira site connected, when a task names an issue by key or by link, then the key becomes a link on that site and a link is kept", () => {
    // given
    const jira = { kind: "jira" as const, url: "https://acme.atlassian.net" };

    // when
    const byKey = issueAddress("PAY-142", jira);
    const byLink = issueAddress("https://acme.atlassian.net/browse/PAY-9", jira);

    // then
    expect(byKey).toBe("https://acme.atlassian.net/browse/PAY-142");
    expect(byLink).toBe("https://acme.atlassian.net/browse/PAY-9");
    expect(() => issueAddress("PAY-142", null)).toThrow(/paste the issue's full link/);
    expect(issueAddress("acme/payments#12", { kind: "gitlab", url: "https://gitlab.com" })).toBe("https://gitlab.com/acme/payments/-/issues/12");
  });

  it("given an admin, when the tracker is saved, then the card shows it with writing back off, and an http address is refused", async () => {
    // given
    const { ctx } = await demo();

    // when
    const plain = await call(ctx, ADMIN, "PUT", "/api/integrations/tracker", { kind: "jira", url: "http://acme.atlassian.net" });
    const saved = await call(ctx, ADMIN, "PUT", "/api/integrations/tracker", { kind: "jira", url: "https://acme.atlassian.net/" });
    const card = ((await (await call(ctx, MEMBER, "GET", "/api/integrations")).json()).integrations as { id: string }[]).find((c) => c.id === "tracker");

    // then
    expect(plain.status).toBe(400);
    expect(saved.status).toBe(200);
    expect(card).toMatchObject({ state: "connected", config: { kind: "jira", url: "https://acme.atlassian.net" }, writeBack: false, enabledBy: ADMIN.name });
  });
});

describe("moving Jira issues when a card moves on Work", () => {
  it("given a fresh orchestrator, when an admin turns it on and off, then it starts off, each change is logged with who made it, and a member is refused", async () => {
    // given
    const { ctx, logged } = await demo();
    const before = (await (await call(ctx, ADMIN, "GET", "/api/integrations")).json()).writes;

    // when
    const on = await call(ctx, ADMIN, "PUT", "/api/integrations/writes", { on: true });
    const off = await call(ctx, ADMIN, "PUT", "/api/integrations/writes", { on: false });
    const byMember = await call(ctx, MEMBER, "PUT", "/api/integrations/writes", { on: true });

    // then
    expect(before).toBe(false);
    expect([on.status, (await on.json()).writes, (await off.json()).writes, byMember.status]).toEqual([200, true, false, 403]);
    expect(logged.filter((l) => l.includes("moving Jira issues"))).toEqual([
      `${ADMIN.id} integration.changed turned on moving Jira issues when a card moves on Work`,
      `${ADMIN.id} integration.changed turned off moving Jira issues when a card moves on Work`,
    ]);
  });

  it("given an orchestrator with no event log, when an admin turns it on, then it is refused and stays off", async () => {
    // given
    const { ctx } = await demo();
    delete ctx.audit;

    // when
    const on = await call(ctx, ADMIN, "PUT", "/api/integrations/writes", { on: true });

    // then
    expect(on.status).toBe(409);
    expect((await (await call(ctx, ADMIN, "GET", "/api/integrations")).json()).writes).toBe(false);
  });
});

describe("the issue tracker's token", () => {
  it("given a Jira site saved with a token, when the site changes without one, then the change is refused, the card shows the token, and a disconnect removes it", async () => {
    // given
    const { ctx } = await demo();
    const saved = await call(ctx, ADMIN, "PUT", "/api/integrations/tracker", { kind: "jira", url: "https://acme.atlassian.net", email: "bot@example.invalid", token: "stand-in-token-0001" });

    // when
    const moved = await call(ctx, ADMIN, "PUT", "/api/integrations/tracker", { kind: "jira", url: "https://other.atlassian.net", email: "bot@example.invalid" });
    const card = ((await (await call(ctx, MEMBER, "GET", "/api/integrations")).json()).integrations as { id: string }[]).find((c) => c.id === "tracker");
    const text = JSON.stringify(card);
    await call(ctx, ADMIN, "DELETE", "/api/integrations/tracker");

    // then
    expect(saved.status).toBe(200);
    expect(moved.status).toBe(400);
    expect((await moved.json()).error).toMatch(/enter the token again/);
    expect(card).toMatchObject({ config: { url: "https://acme.atlassian.net" }, token: { setBy: ADMIN.email } });
    expect(text).not.toContain("stand-in-token-0001");
    expect(await ctx.store.getSecret(ctx.tenant, "integration.tracker.token")).toBeNull();
  });
});

describe("turning the orchestrator's MCP server on for a team", () => {
  it("given the entry the orchestrator writes, when the plugin's share rule audits it, then it travels and carries no credential at all, only the address", () => {
    // given
    const entry = orchestratorMcpEntry(PUBLIC_URL);

    // when
    const audit = auditServer(entry);

    // then
    expect(audit.migratable).toBe(true);
    expect(detectSecret(JSON.stringify(entry))).toBeNull();
    expect(entry).toEqual({ type: "http", url: `${PUBLIC_URL}/mcp` });
  });

  it("given an owner of Payments, when they set it up, then a request adds the server to the team's .mcp.json, unmerged, and the card shows it requested by them", async () => {
    // given
    const { ctx, logged } = await demo({ publicUrl: PUBLIC_URL, apiKeys: { resolve: async () => null } });
    const proposal = await (await call(ctx, OWNER, "POST", "/api/integrations/orchestrator-mcp/payments-skills/proposal")).json();

    // when
    const opened = await call(ctx, OWNER, "POST", "/api/integrations/orchestrator-mcp/payments-skills/propose", { baseSha: proposal.baseSha, message: proposal.proposal, branch: proposal.branch });
    const cards = (await (await call(ctx, MEMBER, "GET", "/api/integrations")).json()).integrations as { id: string; repos?: { repoId: string }[] }[];

    // then
    expect(opened.status).toBe(200);
    const { request } = await opened.json();
    const mirror = mirrorDir(ctx, "payments-skills");
    const added = JSON.parse(await gitAsync(["show", `${request.branch}:.mcp.json`], mirror));
    expect(added.mcpServers[ORCHESTRATOR_MCP_SERVER]).toEqual(orchestratorMcpEntry(PUBLIC_URL));
    expect(await gitAsync(["show", "main:.mcp.json"], mirror).catch(() => "")).not.toContain(ORCHESTRATOR_MCP_SERVER);
    const card = cards.find((c) => c.id === "orchestrator-mcp")!;
    expect(card).toMatchObject({ state: "requested", enabledBy: OWNER.name });
    expect(card.repos!.find((r) => r.repoId === "payments-skills")).toMatchObject({ state: "requested", request: { number: request.number, status: "open" } });
    expect(logged).toEqual([`p integration.enabled requested the orchestrator's MCP server for payments-skills in request #${request.number}`]);
  });

  it("given an owner of Payments, when they set it up for Platform, then they are refused", async () => {
    // given
    const { ctx } = await demo({ publicUrl: PUBLIC_URL, apiKeys: { resolve: async () => null } });

    // when
    const res = await call(ctx, OWNER, "POST", "/api/integrations/orchestrator-mcp/platform-skills/proposal");

    // then
    expect(res.status).toBe(403);
  });

  it("given an orchestrator without API keys, when an admin sets it up, then it is refused with what is missing", async () => {
    // given
    const { ctx } = await demo({ publicUrl: PUBLIC_URL });

    // when
    const res = await call(ctx, ADMIN, "POST", "/api/integrations/orchestrator-mcp/payments-skills/proposal");

    // then
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("API keys are not available on this orchestrator yet, so the server lets nobody in.");
  });
});
