import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../demo/seed.js";
import type { MiddlewareHandler } from "hono";
import { createApp, syncRepo } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import type { OrchestratorContext } from "./app.js";
import { localRepoPath } from "./forge/local.js";
import { git, gitMaybe } from "./git.js";
import { reconcileLocalRequests } from "./propose.js";
import { openPostgresStore } from "./store-postgres.js";
import type { Store } from "./store.js";
import { fakeAgentAdapter } from "./tasks/agents.js";
import { createTaskRunner } from "./tasks/runner.js";

// Runs when ORCHESTRATOR_TEST_DATABASE_URL names a Postgres this suite may create and drop
// databases on, as the store contract does.
const PG_URL = process.env.ORCHESTRATOR_TEST_DATABASE_URL;
const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");
const TASK = "aaaaaaaaaaaa";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function admin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function freshDatabase(): Promise<{ url: string; name: string }> {
  const name = `orchestrator_test_${randomBytes(6).toString("hex")}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  cleanups.push(() => admin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))));
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  return { url: url.toString(), name };
}

/** Local team repositories both orchestrators are configured with, as two orchestrators sharing one host's repositories are. */
function teamRepos() {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-pg-hold-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(seed(join(root, "demo")).configFile, "utf8")) as { tenant: string; repos: { id: string; team: string; name: string; url: string }[] };
  return { root, ...config };
}

/** What an orchestrator's start does once its store is open, in the order main.ts does it: sync, reconcile, recover the tasks. */
async function startOrchestrator(url: string, tenant: string, dataDir: string, repos: { id: string; team: string; name: string; url: string }[], onLost: (reason: string) => void = () => undefined): Promise<OrchestratorContext & { stop: () => Promise<void> }> {
  const store = await openPostgresStore(url, [tenant], onLost);
  let stopped: Promise<void> | null = null;
  const stop = () => (stopped ??= store.close());
  cleanups.push(stop);
  const ctx: OrchestratorContext = { store, dataDir, tenant };
  for (const repo of repos) {
    await store.upsertRepo({ ...repo, tenant });
    await syncRepo(ctx, repo.id);
  }
  await reconcileLocalRequests(ctx);
  await createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } }).ready();
  return { ...ctx, stop };
}

/** A task the first orchestrator is running, with its branch already in the team's repository and no request yet. */
async function liveTask(store: Store, tenant: string, bare: string): Promise<void> {
  git(["update-ref", `refs/heads/task/${TASK}`, git(["rev-parse", "main"], bare).trim()], bare);
  await store.createTask({ tenant, id: TASK, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "running", createdBy: "x", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
  await store.setTaskBranch(tenant, TASK, `task/${TASK}`);
}

function hasBranch(bare: string, branch: string): boolean {
  return gitMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], bare) !== null;
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!done()) throw new Error(`timed out waiting until ${what}`);
}

describe.skipIf(!PG_URL)("one orchestrator per tenant on a Postgres database", () => {
  it("given an orchestrator running a task, when a second orchestrator of the same tenant starts with a data directory of its own, then it stops with a reason and the task and its branch stay as they are", async () => {
    // given
    const { url } = await freshDatabase();
    const { root, tenant, repos } = teamRepos();
    const first = await startOrchestrator(url, tenant, join(root, "first"), repos);
    const bare = localRepoPath(repos.find((r) => r.id === "payments-skills")!.url)!;
    await liveTask(first.store, tenant, bare);

    // when
    const second = startOrchestrator(url, tenant, join(root, "second"), repos);

    // then
    await expect(second).rejects.toThrow(`another orchestrator is running for tenant ${JSON.stringify(tenant)} on this database; this one stops without touching its tasks`);
    expect((await first.store.getTask(tenant, TASK))?.status).toBe("running");
    expect(hasBranch(bare, `task/${TASK}`)).toBe(true);
  });

  it("given the first orchestrator stopped, when the second starts, then it starts and sets right what the first left", async () => {
    // given
    const { url } = await freshDatabase();
    const { root, tenant, repos } = teamRepos();
    const first = await startOrchestrator(url, tenant, join(root, "first"), repos);
    const bare = localRepoPath(repos.find((r) => r.id === "payments-skills")!.url)!;
    await liveTask(first.store, tenant, bare);
    await first.stop();

    // when
    const second = await startOrchestrator(url, tenant, join(root, "second"), repos);

    // then
    expect((await second.store.getTask(tenant, TASK))?.status).toBe("failed");
    expect(hasBranch(bare, `task/${TASK}`)).toBe(false);
  });

  it("given an orchestrator running for one tenant, when an orchestrator of another tenant starts on the same database, then it starts", async () => {
    // given
    const { url } = await freshDatabase();
    const { root, tenant, repos } = teamRepos();
    await startOrchestrator(url, tenant, join(root, "first"), repos);

    // when
    const other = startOrchestrator(url, "other", join(root, "other"), []);

    // then
    await expect(other).resolves.toBeDefined();
  });

  it("given an orchestrator serving two orgs, when an orchestrator of one of them starts and then one of a third org and the second, then both are refused and the third org is left free", async () => {
    // given
    const { url } = await freshDatabase();
    const first = await openPostgresStore(url, ["acme", "beta"], () => undefined);
    cleanups.push(() => first.close());

    // when
    const second = openPostgresStore(url, ["beta"], () => undefined);
    const third = openPostgresStore(url, ["gamma", "acme"], () => undefined);

    // then
    await expect(second).rejects.toThrow('another orchestrator is running for tenant "beta"');
    await expect(third).rejects.toThrow('another orchestrator is running for tenant "acme"');
    const gamma = await openPostgresStore(url, ["gamma"], () => undefined);
    cleanups.push(() => gamma.close());
  });

  it("given a running orchestrator, when the database ends the connection that holds its tenant, then the orchestrator is told, and a second orchestrator can start", async () => {
    // given
    const { url, name } = await freshDatabase();
    const { root, tenant, repos } = teamRepos();
    const reasons: string[] = [];
    await startOrchestrator(url, tenant, join(root, "first"), repos, (reason) => void reasons.push(reason));

    // when
    const ended = await admin(async (c) => (await c.query("SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND d.datname = $1", [name])).rowCount);

    // then
    expect(ended).toBe(1);
    await until(() => reasons.length > 0, "the orchestrator was told");
    expect(reasons).toHaveLength(1);
    await expect(startOrchestrator(url, tenant, join(root, "second"), repos)).resolves.toBeDefined();
  });
});

describe.skipIf(!PG_URL)("requests from orchestrators of two tenants on one database", () => {
  it("given more turns at once than the pool has connections, each on its own repository and each reading the store, when they run, then all finish and the store still answers", async () => {
    // given
    const { url } = await freshDatabase();
    const store = await openPostgresStore(url, ["tenant-a"], () => undefined);
    cleanups.push(() => store.close());

    // when
    const done = await Promise.all(Array.from({ length: 12 }, (_, i) => store.holdRepository!(`https://git.example.invalid/acme/repo-${i}`, async () => (await store.listRepos("tenant-a")).length)));

    // then
    expect(done).toHaveLength(12);
    expect(await store.listRepos("tenant-a")).toEqual([]);
  }, 20_000);

  it("given two tenants whose orchestrators reach one team repository, when each opens a change at the same moment, then each raises the version to a number of its own", async () => {
    // given
    const { url } = await freshDatabase();
    const { root, repos } = teamRepos();
    const bare = localRepoPath(repos.find((r) => r.id === "payments-skills")!.url)!;
    const work = mkdtempSync(join(root, "teammate-"));
    git(["clone", "--quiet", bare, work], work);
    const manifest = join(work, ".claude-plugin", "plugin.json");
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.1.30" }, null, 2) + "\n");
    git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "chore: version 0.1.30"], work);
    git(["fetch", "--quiet", work, "main:main"], bare);
    const first = await startOrchestrator(url, "tenant-a", join(root, "data-a"), repos);
    const second = await startOrchestrator(url, "tenant-b", join(root, "data-b"), repos);
    const admin: MiddlewareHandler<OrchestratorEnv> = async (c, next) => {
      c.set("user", { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] });
      await next();
    };
    const head = git(["rev-parse", "main"], bare).trim();
    const open = (ctx: OrchestratorContext, slug: string) =>
      createApp(ctx, admin).request("/api/repos/payments-skills/changes", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": "t" },
        body: JSON.stringify({ baseSha: head, message: `chore(skill): remove ${slug}`, change: { kind: "skill.delete", slug } }),
      });

    // when
    const opened = await Promise.all([open(first, "release-checklist"), open(second, "add-ledger-migration")]);

    // then
    const branches = await Promise.all(opened.map(async (res) => (await res.json()).request.branch as string));
    const versions = branches.map((branch) => JSON.parse(git(["show", `${branch}:.claude-plugin/plugin.json`], bare)).version).sort();
    expect(versions).toEqual(["0.1.31", "0.1.32"]);
  });
});
