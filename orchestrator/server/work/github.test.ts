import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { writeConnection } from "../forge/oauth.js";
import type { ForgeApps } from "../forge/oauth.js";
import { openSqliteStore } from "../store.js";
import { WorkCache } from "./cache.js";
import type { CliRun } from "../forge/own-cli.js";
import { ADA, PAT } from "./jira-stand-in.js";
import { workRoutes } from "./routes.js";

const API = "https://api.github.example";
const TOKEN = "ghs_standInInstallationToken0001";

/** GitHub's API on no network, as the app's installation token reads it: one repository, a milestone, issues and a pull request. */
function github() {
  const asked: string[] = [];
  const send = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    asked.push(path);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return json({}, 401);
    if (path.startsWith("/installation/repositories")) return json({ repositories: [{ full_name: "acme/payments-api", html_url: "https://github.example/acme/payments-api", has_issues: true }] });
    if (path.startsWith("/repos/acme/payments-api/milestones")) return json([{ number: 4, title: "Sprint 4", due_on: "2026-11-14T00:00:00Z", description: "" }]);
    if (path.startsWith("/repos/acme/payments-api/issues?milestone=4")) {
      return json([
        { number: 12, title: "Round refunds", state: "open", labels: [{ name: "priority: high" }, { name: "blocked" }], assignee: { login: "lin" }, html_url: "https://github.example/acme/payments-api/issues/12" },
        { number: 13, title: "A pull request", state: "open", labels: [], html_url: "https://github.example/acme/payments-api/pull/13", pull_request: {} },
        { number: 14, title: "Ledger export", state: "closed", labels: [], html_url: "https://github.example/acme/payments-api/issues/14" },
      ]);
    }
    return json([], 404);
  }) as typeof fetch;
  return { asked, send };
}

async function orchestrator_() {
  const forgeApps = { github: { kind: "github", webUrl: "https://github.example", apiUrl: API } } as unknown as ForgeApps;
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: "unused", tenant: "acme", vault: null, forgeApps };
  await writeConnection(ctx, "github", { via: "app", account: "acme", apiUrl: API, installationId: 1, by: ADA.name, byEmail: ADA.email, at: "2026-11-02T10:00:00.000Z", problem: null });
  const fake = github();
  const who = { user: ADA };
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", who.user);
    await next();
  });
  // Every read goes through the connection's own fetch, which holds a call to the address judged for it; the plain one fails the test.
  const plain = (async () => {
    throw new Error("a read went around the connection's own fetch");
  }) as typeof fetch;
  app.route("/", workRoutes(ctx, { cache: new WorkCache(), send: plain, forgeAccess: async () => ({ baseUrl: API, headers: { authorization: `Bearer ${TOKEN}` }, send: fake.send }) }));
  const call = async (user: Principal, path: string) => {
    who.user = user;
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
  };
  return { call, asked: fake.asked };
}

describe("GitHub issues through the organization's GitHub connection", () => {
  it("given the app installed on a repository with an open milestone, when an admin opens it, then the milestone is the sprint and its issues are Open or Closed, pull requests left out", async () => {
    // given
    const { call } = await orchestrator_();

    // when
    const sources = await call(ADA, "/api/work/sources");
    const boards = await call(ADA, "/api/work/boards?source=forge:github");
    const sprints = await call(ADA, `/api/work/sprints?board=${encodeURIComponent(boards.body.boards[0].id)}`);
    const items = await call(ADA, `/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(sources.body.sources).toEqual([expect.objectContaining({ id: "forge:github", kind: "github", name: "GitHub (acme)", via: "app", as: "organization", can: expect.objectContaining({ write: false }), writeProblem: "The orchestrator does not move GitHub issues yet", problem: null })]);
    expect(boards.body.boards).toEqual([{ id: "forge:github~acme/payments-api", name: "acme/payments-api", type: "repository", project: "acme/payments-api", url: "https://github.example/acme/payments-api", team: null }]);
    expect(sprints.body.sprints.map((s: { id: string; name: string }) => [s.id, s.name])).toEqual([["forge:github~acme/payments-api~4", "Sprint 4"]]);
    expect(items.body.columns.map((c: { name: string }) => c.name)).toEqual(["Open", "Closed"]);
    expect(items.body.items.map((i: { key: string; column: string; priority: string | null; blocked: boolean }) => [i.key, i.column, i.priority, i.blocked])).toEqual([
      ["acme/payments-api#12", "Open", "high", true],
      ["acme/payments-api#14", "Closed", null, false],
    ]);
  });

  it("given no board mapped to a team, when the Payments owner lists the connection's boards, then they see none and GitHub is not asked for the repository", async () => {
    // given
    const { call, asked } = await orchestrator_();

    // when
    const boards = await call(PAT, "/api/work/boards?source=forge:github");
    const sprints = await call(PAT, "/api/work/sprints?board=forge:github~acme/payments-api");

    // then
    expect(boards.body.boards).toEqual([]);
    expect(sprints.status).toBe(404);
    expect(asked.some((p) => p.startsWith("/repos/"))).toBe(false);
  });
});

/** A folder of the person's whose origin is on GitHub, connected as a project on their own machine. */
async function ownMachine(signedInAtFirst: boolean, project = false) {
  const gh = { signedIn: signedInAtFirst, project };
  const dataDir = mkdtempSync(join(tmpdir(), "own-gh-"));
  const folder = join(dataDir, "..", `${dataDir.split("/").pop()}-payments-api`);
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/payments-api.git\n');
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir, tenant: "acme", vault: null, ownForgeCli: true };
  await ctx.store.upsertRepo({ tenant: "acme", id: "payments-api", team: "Mine", name: "payments-api", url: folder });
  const fake = github();
  const ran: string[][] = [];
  // The person's gh, standing in: `gh auth status` says whether it is signed in, `gh api` answers as GitHub would.
  const run: CliRun = async (tool, args) => {
    ran.push([tool, ...args]);
    if (args[0] === "auth") return { code: gh.signedIn ? 0 : 1, stdout: "", stderr: "", missing: false };
    if (args[3] === "graphql") {
      const query = args.find((a) => a.startsWith("query="))!;
      const data = !gh.project ? { repository: { projectsV2: { nodes: [] } } }
        : query.includes("projectsV2") ? { repository: { projectsV2: { nodes: [{ id: "PVT_1", closed: false, field: { options: [{ name: "Todo" }, { name: "In progress" }, { name: "Done" }] } }] } } }
        : { node: { items: { nodes: [{ content: { number: 12, repository: { nameWithOwner: "acme/payments-api" } }, fieldValueByName: { name: "In progress" } }, { content: { number: 14, repository: { nameWithOwner: "acme/payments-api" } }, fieldValueByName: { name: "Done" } }] } } };
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "", missing: false };
    }
    const res = await fake.send(`https://api.github.com/${args[3]}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { code: res.ok ? 0 : 1, stdout: await res.text(), stderr: res.ok ? "" : `HTTP ${res.status}`, missing: false };
  };
  const app = new Hono<OrchestratorEnv>();
  app.use(async (c, next) => {
    c.set("user", { ...ADA, role: "owner" });
    await next();
  });
  const plain = (async () => {
    throw new Error("a read went around the person's gh");
  }) as typeof fetch;
  app.route("/", workRoutes(ctx, { cache: new WorkCache(), send: plain, cliRun: run }));
  const call = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, body: await res.json() };
  };
  return { call, ran, gh };
}

describe("GitHub issues read with the person's own gh on their own machine", () => {
  it("given a project whose origin is on GitHub and gh signed in, when the person opens Work, then the repository is the board, its milestone the sprint, and every read goes through gh with no token held", async () => {
    // given
    const { call, ran } = await ownMachine(true);

    // when
    const sources = await call("/api/work/sources");
    const boards = await call("/api/work/boards?source=own:github");
    const sprints = await call(`/api/work/sprints?board=${encodeURIComponent(boards.body.boards[0].id)}`);
    const items = await call(`/api/work/items?sprint=${encodeURIComponent(sprints.body.sprints[0].id)}`);

    // then
    expect(sources.body.sources).toEqual([expect.objectContaining({ id: "own:github", kind: "github", name: "GitHub (your gh)", via: "cli", as: "you", problem: null })]);
    expect(boards.body.boards).toEqual([{ id: "own:github~acme/payments-api", name: "acme/payments-api", type: "repository", project: "acme/payments-api", url: "https://github.com/acme/payments-api", team: null }]);
    expect(sprints.body.sprints.map((s: { name: string }) => s.name)).toEqual(["Sprint 4"]);
    expect(items.body.items.map((i: { key: string; column: string }) => [i.key, i.column])).toEqual([["acme/payments-api#12", "Open"], ["acme/payments-api#14", "Closed"]]);
    expect(ran.every(([tool, verb, ...rest]) => tool === "gh" && ["auth", "api"].includes(verb!) && rest.join(" ").includes("--hostname github.com"))).toBe(true);
    expect(ran.filter(([, verb]) => verb === "api").map((r) => r[4])).toEqual(expect.arrayContaining(["repos/acme/payments-api/milestones?state=open&per_page=50", expect.stringMatching(/^repos\/acme\/payments-api\/issues\?milestone=4/)]));
  });

  it("given gh not signed in, when the person opens Work and signs gh in, then the source first says which command signs it in without asking GitHub, and reads once they have", async () => {
    // given
    const { call, ran, gh } = await ownMachine(false);

    // when
    const before = await call("/api/work/sources");
    const askedBefore = ran.some(([, verb]) => verb === "api");
    gh.signedIn = true;
    const after = await call("/api/work/sources");

    // then
    expect(before.body.sources).toEqual([expect.objectContaining({ id: "own:github", problem: expect.stringContaining("gh auth login --hostname github.com") })]);
    expect(askedBefore).toBe(false);
    expect(after.body.sources).toEqual([expect.objectContaining({ id: "own:github", problem: null })]);
  });

  it("given the repository's issues on a GitHub Project with a Status field, when the person opens Work, then the columns are the project's statuses and each issue sits in its own, read through gh", async () => {
    // given
    const { call, ran } = await ownMachine(true, true);
    const board = (await call("/api/work/boards?source=own:github")).body.boards[0].id;
    const sprint = (await call(`/api/work/sprints?board=${encodeURIComponent(board)}`)).body.sprints[0].id;

    // when
    const items = await call(`/api/work/items?sprint=${encodeURIComponent(sprint)}`);

    // then
    expect(items.body.columns.map((c: { name: string }) => c.name)).toEqual(["Todo", "In progress", "Done"]);
    expect(items.body.items.map((i: { key: string; column: string }) => [i.key, i.column])).toEqual([["acme/payments-api#12", "In progress"], ["acme/payments-api#14", "Done"]]);
    const graphql = ran.filter((r) => r[4] === "graphql");
    expect(graphql.length).toBeGreaterThan(0);
    expect(graphql.every((r) => r.some((a) => a.startsWith("query=query")))).toBe(true);
  });
});

