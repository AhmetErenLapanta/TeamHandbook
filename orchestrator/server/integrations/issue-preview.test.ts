import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import type { CliRun } from "../forge/own-cli.js";
import { openSqliteStore } from "../store.js";
import { createVault, storeSecret } from "../vault.js";
import { issuePreview } from "./issue-preview.js";
import { readIssue } from "./issue-read.js";
import { closeStandIns, signedInServer } from "./mcp-stand-in.js";
import { saveEnabled } from "./records.js";
import { TRACKER, TRACKER_TOKEN_SECRET } from "./tracker.js";

const SAM: Principal = { id: "u-sam", name: "Sam Member", email: "sam@example.invalid", role: "member", ownedTeams: ["Payments"] };
const ISSUE = "https://acme.atlassian.example/browse/PAY-142";

afterEach(closeStandIns);

function orchestrator_(): OrchestratorContext {
  return { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", allowedHosts: null, vault: createVault(randomBytes(32)), publicUrl: "https://orchestrator.example.invalid", localMcp: true };
}

/** One app per orchestrator, so a sign-in begun is the one its return finishes. */
const apps = new WeakMap<OrchestratorContext, ReturnType<typeof createApp>>();
function call(ctx: OrchestratorContext, method: string, path: string, body?: unknown, cookie?: string) {
  let app = apps.get(ctx);
  if (!app) {
    const auth: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", SAM);
      await next();
    };
    app = createApp(ctx, auth);
    apps.set(ctx, app);
  }
  const headers: Record<string, string> = { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) };
  return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** Sam adds the stand-in as their own server, signs in to it, and allows `tools`. */
async function samConnects(ctx: OrchestratorContext, base: string, tools: string[]) {
  await call(ctx, "POST", "/api/me/mcp-servers", { name: "atlassian", transport: "http", url: `${base}/mcp`, auth: "oauth" });
  const res = await call(ctx, "POST", "/api/me/mcp-servers/atlassian/connect");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const back = new URL((await fetch((await res.json()).authorizeUrl, { redirect: "manual" })).headers.get("location")!);
  await call(ctx, "GET", back.pathname + back.search, undefined, cookie);
  await call(ctx, "PATCH", "/api/me/mcp-servers/atlassian", { tools });
}

const preview = async (ctx: OrchestratorContext, url = ISSUE) => (await call(ctx, "GET", `/api/issues/preview?url=${encodeURIComponent(url)}`)).json();

describe("what the task form says of a linked issue", () => {
  it("given Sam's own server allowed Jira's reading tool and no tracker connected, when Sam links a Jira issue, then the form says the agent reads it through that server as Sam, with its key, title and status", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ issue: { summary: "Round refunds half to even", status: "In Progress" } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);

    // when
    const said = await preview(ctx);

    // then
    expect(said).toEqual({ url: ISSUE, key: "PAY-142", title: "Round refunds half to even", status: "In Progress", reach: "The agent reads the issue through atlassian as you.", connect: null });
  });

  it("given a server whose issue read fails, when the issue is previewed, then the key alone is shown and the reach still names the server", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ issue: "fails" });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);

    // when
    const said = await preview(ctx);

    // then
    expect(said).toMatchObject({ key: "PAY-142", title: null, status: null, reach: "The agent reads the issue through atlassian as you." });
  });

  it("given an issue title that reads like a secret, when it is previewed, then it is withheld", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ issue: { summary: "use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", status: "Open" } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);

    // when
    const said = await preview(ctx);

    // then
    expect(said.title).toBe("[withheld]");
  });

  it("given a server whose Jira reading tool Sam did not allow, when the issue is previewed, then the form says the agent sees only the link, and the server is not called for it", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer({ issue: { summary: "x", status: "Open" } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources"]);

    // when
    const said = await preview(ctx);

    // then
    expect(said).toMatchObject({ key: "PAY-142", title: null, reach: "The agent sees only the link; connect the issue tracker, or an MCP server that reads Jira issues, in Integrations." });
    expect(state.calls.filter((c) => c.startsWith("tools/call"))).toEqual([]);
  });

  it("given the tracker connected with a token for the site, when the issue is previewed, then the tracker reads it first, without the MCP server", async () => {
    // given
    const ctx = orchestrator_();
    const { base, state } = await signedInServer({ issue: { summary: "x", status: "Open" } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);
    await saveEnabled(ctx, TRACKER, { kind: "jira", url: "https://acme.atlassian.example", email: "bot@example.invalid" }, SAM);
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, "stand-in-token-0001", SAM.email);
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~12": "Payments" }));
    await ctx.store.setSetting(ctx.tenant, "work.boards.projects", JSON.stringify({ "tracker~12": "PAY" }));

    const asked: string[] = [];
    const tracker = (async (url: string | URL) => {
      asked.push(String(url));
      const body = String(url).includes("/comment") ? { comments: [] } : { fields: { summary: "Round refunds half to even", status: { name: "To Do" } } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // when
    const said = await issuePreview(ctx, SAM, ISSUE, tracker);

    // then
    expect(said).toMatchObject({ title: "Round refunds half to even", status: "To Do", reach: "The agent reads the issue's text and latest comments from the tracker before it starts.", connect: null });
    expect(asked.every((u) => u.startsWith("https://acme.atlassian.example/rest/api/3/issue/PAY-142"))).toBe(true);
    expect(state.calls.filter((c) => c.startsWith("tools/call"))).toEqual([]);
  });

  it("given boards mapped to teams and PAY's board mapped to Lending, when Sam, who owns Payments, previews PAY-142, then the tracker is not asked and the form says the agent sees only the link; mapped to Payments, it is read", async () => {
    // given
    const ctx = orchestrator_();
    await saveEnabled(ctx, TRACKER, { kind: "jira", url: "https://acme.atlassian.example", email: "bot@example.invalid" }, SAM);
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, "stand-in-token-0001", SAM.email);
    await ctx.store.setSetting(ctx.tenant, "work.boards.projects", JSON.stringify({ "tracker~12": "PAY" }));
    const asked: string[] = [];
    const tracker = (async (url: string | URL) => {
      asked.push(String(url));
      const body = String(url).includes("/comment") ? { comments: [] } : { fields: { summary: "Round refunds half to even", status: { name: "To Do" } } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // when
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~12": "Lending" }));
    const elsewhere = await issuePreview(ctx, SAM, ISSUE, tracker);
    const askedElsewhere = asked.length;
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~12": "Payments" }));
    const theirs = await issuePreview(ctx, SAM, ISSUE, tracker);

    // then
    expect(elsewhere).toMatchObject({ title: null, reach: "The agent sees only the link: the issue's board is not mapped to a team of yours, so an owner or an admin maps it under Work, or connect an MCP server of your own that reads Jira issues." });
    expect(askedElsewhere).toBe(0);
    expect(theirs).toMatchObject({ title: "Round refunds half to even", reach: "The agent reads the issue's text and latest comments from the tracker before it starts." });
  });

  it("given the tracker's token and no board mapped to any team, when Sam previews PAY-142 and an admin does, then Sam's preview does not ask the tracker and says why, and the admin's reads it", async () => {
    // given
    const ctx = orchestrator_();
    await saveEnabled(ctx, TRACKER, { kind: "jira", url: "https://acme.atlassian.example", email: "bot@example.invalid" }, SAM);
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, "stand-in-token-0001", SAM.email);
    const asked: string[] = [];
    const tracker = (async (url: string | URL) => {
      asked.push(String(url));
      const body = String(url).includes("/comment") ? { comments: [] } : { fields: { summary: "Round refunds half to even", status: { name: "To Do" } } };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // when
    const bySam = await issuePreview(ctx, SAM, ISSUE, tracker);
    const askedForSam = asked.length;
    const byAdmin = await issuePreview(ctx, { ...SAM, id: "u-ada", role: "admin", ownedTeams: [] }, ISSUE, tracker);

    // then
    expect(bySam).toMatchObject({ title: null, reach: "The agent sees only the link: the issue's board is not mapped to a team of yours, so an owner or an admin maps it under Work, or connect an MCP server of your own that reads Jira issues." });
    expect(askedForSam).toBe(0);
    expect(byAdmin).toMatchObject({ title: "Round refunds half to even" });
  });

  it("given a Linear workspace connected with its API key and ENG's board mapped to Payments, when Sam names ENG-12 and then links an issue of another workspace, then the first is read from Linear and the second gets its link alone", async () => {
    // given
    const ctx = orchestrator_();
    await saveEnabled(ctx, TRACKER, { kind: "linear", url: "https://linear.app/acme" }, SAM);
    await storeSecret(ctx.store, ctx.vault!, ctx.tenant, TRACKER_TOKEN_SECRET, "lin_api_stand-in-key-0001", SAM.email);
    await ctx.store.setSetting(ctx.tenant, "work.boards.teams", JSON.stringify({ "tracker~11111111-2222-3333-4444-555555555555": "Payments" }));
    await ctx.store.setSetting(ctx.tenant, "work.boards.projects", JSON.stringify({ "tracker~11111111-2222-3333-4444-555555555555": "ENG" }));
    const asked: string[] = [];
    const linear = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ data: { issue: { title: "Round refunds half to even", state: { name: "In Progress" } } } }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    // when
    const named = await issuePreview(ctx, SAM, "ENG-12", linear);
    const elsewhere = await issuePreview(ctx, SAM, "https://linear.app/acme-labs/issue/ENG-12", linear);

    // then
    expect(named).toEqual({ url: "https://linear.app/acme/issue/ENG-12", key: "ENG-12", title: "Round refunds half to even", status: "In Progress", reach: "The agent reads the issue's text and latest comments from the tracker before it starts.", connect: null });
    expect(elsewhere).toMatchObject({ title: null, reach: "The agent sees only the link; connect the issue tracker, or an MCP server that reads Linear issues, in Integrations." });
    expect(asked).toEqual(["https://api.linear.app/graphql"]);
  });
});

describe("the sign-in the task form offers for an issue nothing reads", () => {
  it("given no tracker and no server of Sam's, when Sam links a Jira, a Linear and a GitLab issue, then each is offered its own one-step sign-in, and a GitHub issue on a team's orchestrator is offered none", async () => {
    // given
    const ctx = orchestrator_();

    // when
    const jira = await preview(ctx);
    const linear = await preview(ctx, "https://linear.app/acme/issue/ENG-12");
    const gitlab = await preview(ctx, "https://gitlab.com/acme/payments/-/issues/12");
    const github = await preview(ctx, "https://github.com/acme/web-skills/issues/101");

    // then
    expect([jira.connect, linear.connect, gitlab.connect, github.connect]).toEqual([{ id: "jira", name: "Atlassian" }, { id: "linear", name: "Linear" }, { id: "gitlab", name: "GitLab" }, null]);
  });

  it("given Sam's own server reads Jira, when Sam links a Jira issue, then no sign-in is offered", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ issue: { summary: "x", status: "Open" } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);

    // when
    const said = await preview(ctx);

    // then
    expect(said.connect).toBeNull();
  });
});

describe("what the task form says of a GitHub issue on one person's own machine", () => {
  it("given a project whose origin is the issue's repository and gh signed in, when the person links the issue, then the form says the agent reads it with their gh and shows its title and state", async () => {
    // given
    const dataDir = mkdtempSync(join(tmpdir(), "own-preview-"));
    const folder = `${dataDir}-project`;
    mkdirSync(join(folder, ".git"), { recursive: true });
    writeFileSync(join(folder, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/acme/web-skills.git\n');
    const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir, tenant: "acme", vault: null, ownForgeCli: true };
    await ctx.store.upsertRepo({ tenant: "acme", id: "web-skills", team: "Mine", name: "web-skills", url: folder });
    const run: CliRun = async (_tool, args) => {
      if (args[0] === "auth") return { code: 0, stdout: "", stderr: "", missing: false };
      const answers: Record<string, unknown> = { user: { login: "solo-person" }, "repos/acme/web-skills/issues/101": { title: "Expose the order-history endpoint", state: "open", body: "" }, "repos/acme/web-skills/issues/101/comments?per_page=100": [] };
      return { code: 0, stdout: JSON.stringify(answers[args[3]!] ?? {}), stderr: "", missing: false };
    };
    const owner: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };

    // when
    const said = await issuePreview(ctx, owner, "https://github.com/acme/web-skills/issues/101", undefined, run);

    // then
    expect(said).toEqual({ url: "https://github.com/acme/web-skills/issues/101", key: "acme/web-skills#101", title: "Expose the order-history endpoint", status: "open", reach: "The agent reads the issue's text and latest comments with your gh before it starts.", connect: null });
  });
});

describe("the issue a task reads through the person's own Atlassian server", () => {
  it("given Jira signed in with Atlassian and no tracker token, when Sam's task reads PAY-142, then the agent gets its title, status, description and latest comments newest first, read as Sam, and an issue on a site Sam's sign-in does not reach is not read", async () => {
    // given
    const ctx = orchestrator_();
    const { base } = await signedInServer({ issue: { summary: "Round refunds half to even", status: "In Progress", description: "Round half to even on refunds.", comments: [{ author: "Kai", created: "2026-11-01T09:00:00.000Z", body: "First." }, { author: "Lee", created: "2026-11-02T09:00:00.000Z", body: "Keep the CSV export." }] } });
    await samConnects(ctx, base, ["getAccessibleAtlassianResources", "getJiraIssue"]);
    const issue = { url: ISSUE, kind: "jira", key: "PAY-142", branchToken: "PAY-142" } as const;

    // when
    const read = await readIssue(ctx, issue, SAM);
    const elsewhere = await readIssue(ctx, { ...issue, url: "https://other.atlassian.example/browse/PAY-142" }, SAM);

    // then
    expect((read as { text: string }).text).toBe(["PAY-142: Round refunds half to even", "Status: In Progress", "", "Description:", "Round half to even on refunds.", "", "Latest comments, newest first:", "- Lee, 2026-11-02:", "Keep the CSV export.", "- Kai, 2026-11-01:", "First."].join("\n"));
    expect(read).toMatchObject({ title: "Round refunds half to even", status: "In Progress" });
    expect(elsewhere).toEqual({ problem: "atlassian reaches no Jira site at other.atlassian.example" });
  });
});
