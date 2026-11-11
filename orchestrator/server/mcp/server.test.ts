import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { createApp, syncRepo } from "../app.js";
import { PER_KEY_PER_MINUTE } from "../limits.js";
import { MCP_LIMITS } from "./server.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { gitAsync } from "../git.js";
import type { Audit } from "../integrations/audit.js";
import { storeKeys } from "../integrations/keys.js";
import { createUser, principalOf, setupFirstOwner } from "../accounts.js";
import { createKey, revokeKey } from "../keys.js";
import { openSqliteStore } from "../store.js";
import type { TaskRunner } from "../tasks/runner.js";
import type { TaskRecord } from "../tasks/types.js";
import { DEFAULT_MODE } from "../../shared/permission-mode.js";

const OWNER: Principal = { id: "u-owner", name: "Pat Owner", email: "pat@example.invalid", role: "member", ownedTeams: ["Payments"] };
const OTHER_OWNER: Principal = { id: "u-other", name: "Lin Platform", email: "lin@example.invalid", role: "member", ownedTeams: ["Platform"] };
const MEMBER: Principal = { id: "u-member", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: [] };
const BUSY: Principal = { id: "u-busy", name: "Bea Busy", email: "bea@example.invalid", role: "member", ownedTeams: [] };
const KEYS: Record<string, Principal> = { "th_sk_owner_1": OWNER, "th_sk_other_1": OTHER_OWNER, "th_sk_member_1": MEMBER, "th_sk_busy_1": BUSY };

const READ_TOOLS = ["list_repositories", "get_repository", "list_requests", "list_policies", "list_my_tasks"];
const WRITE_TOOLS = ["preview_change", "propose_change"];
const SKILL = "---\nname: refund-runbook\ndescription: Use when a refund is stuck between the ledger and the processor and support asks what to do next.\n---\n\n# Refund runbook\n\n1. Find the refund in the ledger.\n2. Compare it with the processor's record.\n3. Retry once the two agree.\n";

const dirs: string[] = [];
const servers: ServerType[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Logged {
  actor: Principal;
  kind: string;
  repoId?: string | null;
  subject?: string | null;
  detail: string;
}

async function orchestrator_(options: { audit?: Audit | null; keys?: boolean; tasks?: TaskRunner; publicUrl?: string } = {}): Promise<{ ctx: OrchestratorContext; url: string; logged: Logged[] }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-mcp-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const logged: Logged[] = [];
  const audit: Audit = async (actor, kind, fields) => {
    logged.push({ actor, kind, ...fields });
  };
  const ctx: OrchestratorContext = {
    store: openSqliteStore(":memory:"),
    dataDir: join(root, "data"),
    tenant: config.tenant,
    allowedHosts: null,
    ...(options.audit === null ? {} : { audit: options.audit ?? audit }),
    ...(options.keys === false ? {} : { apiKeys: { resolve: async (key: string) => KEYS[key] ?? null } }),
    ...(options.tasks ? { tasks: options.tasks } : {}),
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
  };
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  const app = createApp(ctx);
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  servers.push(server);
  return { ctx, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, logged };
}

async function connect(url: string, key: string): Promise<Client> {
  const client = new Client({ name: "orchestrator-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

function parsed(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { text: string }[])[0]!.text;
}

function fakeRunner(started: unknown[]): TaskRunner {
  return {
    agents: () => [{ id: "fake", label: "Stand-in agent", modes: [DEFAULT_MODE], options: [] }],
    codeTarget: () => null,
    personal: async () => null,
    runsHere: () => true,
    keptForMachine: () => false,
    start: async (input: { repo: { id: string; team: string }; title: string; user: Principal }) => {
      started.push(input);
      return { id: "abcdef012345", repoId: input.repo.id, team: input.repo.team, title: input.title, status: "queued", agent: "fake", createdBy: input.user.email } as TaskRecord;
    },
  } as unknown as TaskRunner;
}

describe("the orchestrator's MCP server, through the official MCP client", () => {
  it("given a member's key, when the client connects and lists the tools, then it is offered the reading tools alone", async () => {
    // given
    const { url } = await orchestrator_();

    // when
    const client = await connect(url, "th_sk_member_1");
    const tools = await client.listTools();

    // then
    expect(client.getServerVersion()?.name).toBe("teamhandbook-orchestrator");
    expect(tools.tools.map((t) => t.name)).toEqual(READ_TOOLS);
    await client.close();
  });

  it("given a team owner's key, when the tools are listed, then the change tools are offered too, and none merges or closes a request", async () => {
    // given
    const { url } = await orchestrator_({ tasks: fakeRunner([]) });

    // when
    const client = await connect(url, "th_sk_owner_1");
    const tools = await client.listTools();

    // then
    expect(tools.tools.map((t) => t.name)).toEqual([...READ_TOOLS, ...WRITE_TOOLS, "start_task"]);
    expect(tools.tools.find((t) => t.name === "start_task")?.inputSchema.properties?.agent).toMatchObject({ enum: ["fake"] });
    await client.close();
  });

  it("given an owner of Payments, when they preview and then propose a new skill, then a request opens unmerged on the team repository and both calls are in the event log without the skill's text", async () => {
    // given
    const { ctx, url, logged } = await orchestrator_();
    const client = await connect(url, "th_sk_owner_1");
    const change = { kind: "skill.add", slug: "refund-runbook", content: SKILL };

    // when
    const preview = parsed(await client.callTool({ name: "preview_change", arguments: { repo: "payments-skills", change } }));
    const proposed = await client.callTool({ name: "propose_change", arguments: { repo: "payments-skills", baseSha: preview.baseSha, change, message: preview.proposal } });

    // then
    expect(proposed.isError).toBeFalsy();
    const request = (parsed(proposed).request as { number: number; status: string; branch: string });
    expect(request.status).toBe("open");
    expect((await ctx.store.getRequest(ctx.tenant, "payments-skills", request.number))?.createdBy).toBe(OWNER.email);
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const main = (await gitAsync(["ls-tree", "-r", "--name-only", "main"], join(ctx.dataDir, "mirrors", ctx.tenant, "payments-skills.git"))).split("\n");
    expect(main).not.toContain("skills/refund-runbook/SKILL.md");
    expect(repo.head).toBeTruthy();
    expect(logged.map((l) => [l.kind, l.subject, l.actor.id, l.repoId])).toEqual([
      ["mcp.call", "tool:preview_change", OWNER.id, "payments-skills"],
      ["mcp.call", "tool:propose_change", OWNER.id, "payments-skills"],
    ]);
    expect(logged[1]!.detail).toBe("propose_change on payments-skills skill.add refund-runbook");
    expect(JSON.stringify(logged)).not.toContain("ledger");
    await client.close();
  });

  it("given an owner of another team, when they propose a change to Payments, then the call is refused and no request opens", async () => {
    // given
    const { ctx, url } = await orchestrator_();
    const client = await connect(url, "th_sk_other_1");
    const change = { kind: "skill.add", slug: "refund-runbook", content: SKILL };
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const proposed = await client.callTool({ name: "propose_change", arguments: { repo: "payments-skills", baseSha: head, change, message: "feat(skill): add refund-runbook" } });

    // then
    expect(proposed.isError).toBe(true);
    expect(text(proposed)).toBe("only an admin or an owner of Payments can change this repository");
    expect(await ctx.store.listRequests(ctx.tenant, "payments-skills")).toEqual([]);
    await client.close();
  });

  it("given a member, when they call a change tool the server did not offer them, then it is refused as unknown and nothing is logged or opened", async () => {
    // given
    const { ctx, url, logged } = await orchestrator_();
    const client = await connect(url, "th_sk_member_1");

    // when
    const call = client.callTool({ name: "propose_change", arguments: { repo: "payments-skills", baseSha: "x", change: { kind: "skill.delete", slug: "release-checklist" }, message: "m" } });

    // then
    await expect(call).rejects.toThrow(/no tool named "propose_change" is offered to you/);
    expect(logged).toEqual([]);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
    await client.close();
  });

  it("given a change to the team's naming, when an owner asks for it through MCP, then it is refused: only skills and MCP servers change from here", async () => {
    // given
    const { ctx, url } = await orchestrator_();
    const client = await connect(url, "th_sk_owner_1");
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const proposed = await client.callTool({ name: "propose_change", arguments: { repo: "payments-skills", baseSha: head, change: { kind: "team.naming", commitPrefix: "X", branchExample: "x" }, message: "m" } });

    // then
    expect(proposed.isError).toBe(true);
    expect(text(proposed)).toMatch(/^change.kind is one of skill.add/);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
    await client.close();
  });

  it("given an event log that refuses the row, when an owner proposes a change, then the change is not made", async () => {
    // given
    const { ctx, url } = await orchestrator_({ audit: async () => { throw new Error("disk full"); } });
    const client = await connect(url, "th_sk_owner_1");
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head;

    // when
    const call = client.callTool({ name: "propose_change", arguments: { repo: "payments-skills", baseSha: head, change: { kind: "skill.delete", slug: "release-checklist" }, message: "chore(skill): remove release-checklist" } });

    // then
    await expect(call).rejects.toThrow(/the event log did not take this call, so it was not made/);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
    await client.close();
  });

  it("given an orchestrator with no event log, when a member reads, then the call is refused rather than made unrecorded", async () => {
    // given
    const { url } = await orchestrator_({ audit: null });
    const client = await connect(url, "th_sk_member_1");

    // when
    const call = client.callTool({ name: "list_repositories", arguments: {} });

    // then
    await expect(call).rejects.toThrow(/keeps no event log/);
    await client.close();
  });

  it("given an owner, when they start a task with a key the stand-in runner knows, then the task is started as them; another team's owner is refused", async () => {
    // given
    const started: { user: Principal; title: string }[] = [];
    const { url } = await orchestrator_({ tasks: fakeRunner(started) });
    const owner = await connect(url, "th_sk_owner_1");
    const other = await connect(url, "th_sk_other_1");

    // when
    const mine = await owner.callTool({ name: "start_task", arguments: { repo: "payments-skills", agent: "fake", title: "Tidy the refund skills" } });
    const theirs = await other.callTool({ name: "start_task", arguments: { repo: "payments-skills", agent: "fake", title: "Tidy the refund skills" } });

    // then
    expect(parsed(mine).task).toMatchObject({ status: "queued", repo: "payments-skills" });
    expect(started.map((s) => [s.user.id, s.title])).toEqual([[OWNER.id, "Tidy the refund skills"]]);
    expect(theirs.isError).toBe(true);
    expect(text(theirs)).toBe("this team keeps its tasks to its owners");
    await owner.close();
    await other.close();
  });

  it("given an agent that runs only in Auto, when start_task names Auto and then a mode the agent does not run in, then the first starts in Auto and the second is refused in the agent's words", async () => {
    // given
    const started: { mode: string }[] = [];
    const { url } = await orchestrator_({ tasks: fakeRunner(started) });
    const owner = await connect(url, "th_sk_owner_1");

    // when
    const auto = await owner.callTool({ name: "start_task", arguments: { repo: "payments-skills", agent: "fake", title: "Tidy the refund skills", mode: "auto" } });
    const careful = await owner.callTool({ name: "start_task", arguments: { repo: "payments-skills", agent: "fake", title: "Tidy the refund skills", mode: "approval-required" } });

    // then
    expect(auto.isError).toBeFalsy();
    expect(started.map((s) => s.mode)).toEqual(["auto"]);
    expect(careful.isError).toBe(true);
    expect(text(careful)).toBe("this agent runs in Auto, not in Approval required");
    await owner.close();
  });

  it("given requests and tasks, when a member reads them, then they see the open requests and only the tasks they started", async () => {
    // given
    const { ctx, url } = await orchestrator_();
    const base = { tenant: ctx.tenant, repoId: "payments-skills", provider: "local" as const, branch: "b", headSha: "0".repeat(40) };
    await ctx.store.saveRequest({ ...base, number: 1, url: "local:1", title: "feat(skill): add a", status: "open", createdAt: "2026-10-01T00:00:00.000Z", createdBy: OWNER.email });
    await ctx.store.saveRequest({ ...base, number: 2, url: "local:2", branch: "c", title: "feat(skill): add b", status: "merged", createdAt: "2026-10-02T00:00:00.000Z", createdBy: OWNER.email });
    const task = (id: string, by: string) => ({ tenant: ctx.tenant, id, repoId: "payments-skills", team: "Payments", title: `task ${id}`, description: "", issueUrl: null, issueKey: null, agent: "fake", status: "needs-review" as const, createdBy: by, createdAt: "2026-10-03T00:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    await ctx.store.createTask(task("aaaaaaaaaaaa", MEMBER.email));
    await ctx.store.createTask(task("bbbbbbbbbbbb", OWNER.email));
    const client = await connect(url, "th_sk_member_1");

    // when
    const requests = parsed(await client.callTool({ name: "list_requests", arguments: {} }));
    const tasks = parsed(await client.callTool({ name: "list_my_tasks", arguments: {} }));

    // then
    expect((requests.requests as { number: number }[]).map((r) => r.number)).toEqual([1]);
    expect((tasks.tasks as { id: string }[]).map((t) => t.id)).toEqual(["aaaaaaaaaaaa"]);
    await client.close();
  });
});

describe("the orchestrator's own API keys at its MCP server", () => {
  it("given a team owner's keys, when one with read scopes and one with write scopes connect, then the read key is offered the reading tools alone, and a revoked key is turned away", async () => {
    // given
    const { ctx, url } = await orchestrator_({ keys: false });
    ctx.apiKeys = storeKeys(ctx.store, ctx.tenant);
    const first = await principalOf(ctx.store, await setupFirstOwner(ctx.store, ctx.tenant, "setup-code", { code: "setup-code", email: "ada@example.invalid", name: "Ada", password: "correct horse battery" }));
    const pat = await principalOf(ctx.store, await createUser(ctx.store, ctx.tenant, new Set(["Payments", "Platform"]), { email: "pat@example.invalid", name: "Pat", role: "member", teams: ["Payments"], password: "correct horse battery" }, first));
    const reading = await createKey(ctx.store, ctx.tenant, pat, { name: "read", scopes: { repositories: "read", requests: "read", tasks: "read" } });
    const writing = await createKey(ctx.store, ctx.tenant, pat, { name: "write", scopes: { repositories: "read", requests: "write", tasks: "read" } });

    // when
    const reader = await connect(url, reading.secret);
    const writer = await connect(url, writing.secret);
    const readTools = (await reader.listTools()).tools.map((t) => t.name);
    const writeTools = (await writer.listTools()).tools.map((t) => t.name);
    await revokeKey(ctx.store, ctx.tenant, pat, reading.key.id);
    const revoked = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${reading.secret}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

    // then
    expect(readTools).toEqual(READ_TOOLS);
    expect(writeTools).toEqual([...READ_TOOLS, ...WRITE_TOOLS]);
    expect(revoked.status).toBe(401);
    await reader.close();
    await writer.close();
  });
});

describe("how often the orchestrator's MCP server answers one caller", () => {
  const rpc = (url: string, key: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  it("given a key that has made its calls for the minute, when it calls again, then it is told to wait, and another key is still answered", async () => {
    // given
    const { url } = await orchestrator_();
    // The key gate is the process's, so this test's caller is one no other test calls as.
    for (let i = 0; i < PER_KEY_PER_MINUTE; i++) expect((await rpc(url, "th_sk_busy_1", list)).status).toBe(200);

    // when
    const over = await rpc(url, "th_sk_busy_1", list);
    const other = await rpc(url, "th_sk_member_1", list);

    // then
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(other.status).toBe(200);
  });

  it("given a key that has proposed as often as a minute allows, when it proposes again, then the call is refused before it is logged or run", async () => {
    // given
    const { url, logged } = await orchestrator_();
    const preview = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "preview_change", arguments: { repo: "payments-skills", change: { kind: "skill.delete", slug: "release-checklist" } } } });
    for (let i = 0; i < MCP_LIMITS.writesPerCredential; i++) expect((await (await rpc(url, "th_sk_owner_1", preview(i))).json()).error).toBeUndefined();

    // when
    const over = await (await rpc(url, "th_sk_owner_1", preview(99))).json();
    const reading = await (await rpc(url, "th_sk_owner_1", { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "list_repositories", arguments: {} } })).json();

    // then
    expect(over.error).toMatchObject({ code: -32029 });
    expect(logged.filter((l) => l.subject === "tool:preview_change")).toHaveLength(MCP_LIMITS.writesPerCredential);
    expect(reading.result.isError).toBeFalsy();
  });

  it("given a client sending made-up keys, when it passes the limit for its address, then it is told to wait before any key is looked up", async () => {
    // given
    const { ctx, url } = await orchestrator_();
    let lookups = 0;
    const resolve = ctx.apiKeys!.resolve;
    ctx.apiKeys = { resolve: async (key) => (lookups++, resolve(key)) };
    for (let i = 0; i < MCP_LIMITS.perClient; i++) await rpc(url, `th_sk_madeup_${i}`, list);
    const before = lookups;

    // when
    const over = await rpc(url, "th_sk_owner_1", list);

    // then
    expect(over.status).toBe(429);
    expect(lookups).toBe(before);
  });
});

describe("the policies a team declares", () => {
  it("given a team file with a policy at the head the orchestrator read, when a member lists policies, then they read it as the team wrote it", async () => {
    // given
    const { ctx, url } = await orchestrator_();
    const policies = [{ id: "retire-legacy", name: "Retire the legacy server", rules: [{ action: "mcp.use", resource: "mcp:legacy", effect: "deny", reason: "Use payments-api instead." }] }];
    const mirror = join(ctx.dataDir, "mirrors", ctx.tenant, "payments-skills.git");
    const head = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.head!;
    const team = JSON.parse(await gitAsync(["show", `${head}:.teamhandbook.json`], mirror));
    const blob = (await gitAsync(["hash-object", "-w", "--stdin"], mirror, JSON.stringify({ ...team, policies }))).trim();
    const others = (await gitAsync(["ls-tree", head], mirror)).split("\n").filter((line) => line && !line.endsWith("\t.teamhandbook.json"));
    const tree = (await gitAsync(["mktree"], mirror, `${[...others, `100644 blob ${blob}\t.teamhandbook.json`].join("\n")}\n`)).trim();
    const commit = (await gitAsync(["commit-tree", tree, "-p", head, "-m", "chore: add a policy"], mirror, undefined, { name: "Pat Owner", email: OWNER.email })).trim();
    await ctx.store.recordSync(ctx.tenant, "payments-skills", { head: commit });
    const client = await connect(url, "th_sk_member_1");

    // when
    const listed = parsed(await client.callTool({ name: "list_policies", arguments: { repo: "payments-skills" } }));

    // then
    expect(listed.repositories).toEqual([{ repo: "payments-skills", team: "Payments", policies }]);
    await client.close();
  });
});

describe("who the orchestrator's MCP server lets in", () => {
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const post = (url: string, headers: Record<string, string>, body: unknown = initialize) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

  it("given an orchestrator with no API keys, when a client calls with any key, then it is turned away", async () => {
    // given
    const { url } = await orchestrator_({ keys: false });

    // when
    const res = await post(url, { authorization: "Bearer th_sk_owner_1" });

    // then
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect((await res.json()).error).toMatch(/API keys are not set up/);
  });

  it("given an unknown key, a missing key or a session cookie alone, when a client calls, then each is turned away", async () => {
    // given
    const { url } = await orchestrator_();

    // when
    const statuses = await Promise.all([
      post(url, { authorization: "Bearer th_sk_revoked_1" }),
      post(url, {}),
      post(url, { cookie: "th_session_x=anything" }),
    ].map(async (r) => (await r).status));

    // then
    expect(statuses).toEqual([401, 401, 401]);
  });

  it("given the key alone in the header, as a team's .mcp.json sends it, when a client calls, then it is let in as the key's owner", async () => {
    // given
    const { url } = await orchestrator_();

    // when
    const res = await post(url, { authorization: "th_sk_member_1" });

    // then
    expect(res.status).toBe(200);
  });

  it("given a page of another site, when it posts with a valid key, then the server refuses it by its origin", async () => {
    // given
    const { url } = await orchestrator_({ publicUrl: "https://orchestrator.example.invalid" });

    // when
    const foreign = await post(url, { authorization: "Bearer th_sk_owner_1", origin: "http://rebound.example.invalid" });
    const own = await post(url, { authorization: "Bearer th_sk_owner_1", origin: "https://orchestrator.example.invalid" });

    // then
    expect(foreign.status).toBe(403);
    expect(own.status).toBe(200);
  });

  it("given a valid key, when a client asks for an event stream, sends a batch, or sends a notification, then it gets 405, 400 and 202", async () => {
    // given
    const { url } = await orchestrator_();
    const auth = { authorization: "Bearer th_sk_member_1" };

    // when
    const stream = await fetch(url, { headers: { ...auth, accept: "text/event-stream" } });
    const batch = await post(url, auth, [initialize]);
    const note = await post(url, auth, { jsonrpc: "2.0", method: "notifications/initialized" });

    // then
    expect([stream.status, batch.status, note.status]).toEqual([405, 400, 202]);
  });

  it("given a client asking for a protocol revision the server does not speak, when it initializes, then it is offered the newest the server speaks", async () => {
    // given
    const { url } = await orchestrator_();

    // when
    const res = await post(url, { authorization: "Bearer th_sk_member_1" }, { ...initialize, params: { ...initialize.params, protocolVersion: "2099-01-01" } });

    // then
    expect((await res.json()).result.protocolVersion).toBe("2025-11-25");
  });
});
