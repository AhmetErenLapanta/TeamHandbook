import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { ENVIRONMENT_FILE, parseEnvironment } from "./environment.js";
import { createTaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a repository's task environment file", () => {
  it("given a setup and an allow list, when the file is read, then both are taken, the setup with the network unless it says otherwise", () => {
    expect(parseEnvironment(JSON.stringify({ setup: { command: "npm ci" }, agent: { allowedDomains: ["registry.npmjs.org", "*.Example.com"] } }))).toEqual({
      setup: { command: "npm ci", network: true },
      allowedDomains: ["registry.npmjs.org", "*.example.com"],
    });
    expect(parseEnvironment(JSON.stringify({ setup: { command: "make deps", network: false } }))).toEqual({ setup: { command: "make deps", network: false }, allowedDomains: null });
  });

  it.each([
    ["a misspelled key", { agent: { allowedDomain: ["registry.npmjs.org"] } }, 'agent has "allowedDomain", which the orchestrator does not read'],
    ["a key the orchestrator does not read", { image: "node:22" }, `${ENVIRONMENT_FILE} has "image", which the orchestrator does not read`],
    ["an address in place of a domain", { agent: { allowedDomains: ["https://registry.npmjs.org"] } }, "agent.allowedDomains is a list of at most 100 domain names, each one written plainly or as *.example.com"],
    ["an IP address in place of a domain", { agent: { allowedDomains: ["10.0.0.5"] } }, "agent.allowedDomains is a list of at most 100 domain names, each one written plainly or as *.example.com"],
    ["a credential in the setup", { setup: { command: "npm ci --//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz012345" } }, "setup.command looks like it contains a secret (npm-token); refer to it by an environment variable's name instead"],
    ["a network that is not a yes or no", { setup: { command: "npm ci", network: "off" } }, "setup.network is true or false"],
  ])("given %s, when the file is read, then it is refused with the reason", (_case, file, refused) => {
    expect(parseEnvironment(JSON.stringify(file))).toEqual({ refused });
  });
});

/** The seeded Payments repository with `environment` committed as its task environment file. */
async function payments(environment: unknown): Promise<{ ctx: OrchestratorContext; bare: string }> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-environment-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const entry = config.repos.find((r: { id: string }) => r.id === "payments-skills");
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  await ctx.store.upsertRepo({ ...entry, tenant: config.tenant });
  const bare = localRepoPath(entry.url)!;
  const work = mkdtempSync(join(root, "work-"));
  git(["clone", "--quiet", bare, work], work);
  mkdirSync(dirname(join(work, ENVIRONMENT_FILE)), { recursive: true });
  writeFileSync(join(work, ENVIRONMENT_FILE), JSON.stringify(environment, null, 2) + "\n");
  git(["add", "-A"], work);
  git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", "chore: describe the task environment"], work);
  git(["fetch", "--quiet", work, "main:main"], bare);
  await syncRepo(ctx, "payments-skills");
  return { ctx, bare };
}

async function run(ctx: OrchestratorContext) {
  const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH } });
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const started = await tasks.start({ repo, title: "Add a note", description: "", agent: "fake", user: ADMIN });
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text);
  return { task, log };
}

const node = (code: string) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;

describe("a task in a repository that describes its environment", () => {
  it("given a setup that writes dependencies, when the task runs, then the setup runs before the agent and what it wrote stays out of the request", async () => {
    // given
    const { ctx, bare } = await payments({ setup: { command: node('require("fs").mkdirSync("vendor",{recursive:true});require("fs").writeFileSync("vendor/lib.js","x")') } });

    // when
    const { task, log } = await run(ctx);

    // then
    expect(task.status).toBe("needs-review");
    expect(log.findIndex((l) => l.startsWith("Running the repository's setup"))).toBeLessThan(log.findIndex((l) => l.startsWith("Starting")));
    expect(log).toContain("The setup created 1 path(s) the change leaves out.");
    const [request] = await ctx.store.listRequests(ctx.tenant);
    expect(git(["diff", "--name-only", "main", request!.branch], bare).trim().split("\n").some((p) => p.startsWith("vendor/"))).toBe(false);
  });

  it.each([
    ["a setup that fails", { setup: { command: node("process.exit(3)") } }, /^The repository's setup failed \(exit code 3\); the agent did not run\./],
    ["a setup that edits a tracked file", { setup: { command: node('require("fs").appendFileSync("README.md","edited")') } }, /^The repository's setup changed README\.md, which the repository tracks/],
    ["an allow list under process isolation", { agent: { allowedDomains: ["registry.npmjs.org"] } }, /^The task did not run: \.teamhandbook\/environment\.json allows the agent only registry\.npmjs\.org, which only container isolation holds\.$/],
    ["a setup with no network under process isolation", { setup: { command: "true", network: false } }, /^The task did not run: \.teamhandbook\/environment\.json runs its setup with no network, which only container isolation holds\.$/],
    ["a file the orchestrator cannot read", { agent: { allowedDomain: [] } }, /^The task did not run: agent has "allowedDomain"/],
  ])("given %s, when the task runs, then it fails before any agent starts and no request opens", async (_case, environment, error) => {
    // given
    const { ctx } = await payments(environment);

    // when
    const { task, log } = await run(ctx);

    // then
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(error);
    expect(log.some((l) => l.startsWith("Starting"))).toBe(false);
    expect(await ctx.store.listRequests(ctx.tenant)).toEqual([]);
  });
});
