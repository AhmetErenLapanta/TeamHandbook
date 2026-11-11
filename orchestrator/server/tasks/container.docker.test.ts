import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seed } from "../../demo/seed.js";
import { syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { openSqliteStore } from "../store.js";
import { storePrincipals } from "../test-fixtures.js";
import { FAKE_CAPABILITIES, fakeDecoder } from "./adapters/fake.js";
import { adapterFrom } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import { UNKNOWN_COST } from "./types.js";
import { createTaskRunner } from "./runner.js";

// Container isolation against a real Docker daemon. Off unless ORCHESTRATOR_TEST_DOCKER=1, so the
// default run never touches Docker; ORCHESTRATOR_TEST_DOCKER_IMAGE names any image with node in it.
const ENABLED = process.env.ORCHESTRATOR_TEST_DOCKER === "1";
const IMAGE = process.env.ORCHESTRATOR_TEST_DOCKER_IMAGE ?? "node:22.22.0-bookworm-slim";
const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seeded(): Promise<OrchestratorContext> {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-docker-"));
  dirs.push(root);
  const { configFile } = seed(join(root, "demo"));
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(root, "data"), tenant: config.tenant };
  await storePrincipals(ctx, ADMIN);
  for (const repo of config.repos) {
    await ctx.store.upsertRepo({ ...repo, tenant: config.tenant });
    await syncRepo(ctx, repo.id);
  }
  return ctx;
}

// What the agent reports seeing from inside its container: the network, and which of the
// orchestrator's own paths exist there.
const PROBE = `import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
const checks = JSON.parse(process.argv[2]);
let network;
try { await lookup("example.com"); network = "resolved"; } catch (e) { network = "failed: " + e.code; }
const seen = Object.fromEntries(Object.entries(checks.paths).map(([k, p]) => [k, existsSync(p)]));
writeFileSync("probe.json", JSON.stringify({ network, seen, tasks: readdirSync(checks.tasks) }) + "\\n");
console.log(JSON.stringify({ type: "result", summary: "probed" }));
`;

function probeAdapter(checks: (paths: { root: string; git: string }) => unknown): AgentAdapter {
  return adapterFrom({
    id: "probe",
    label: "Probe",
    capabilities: FAKE_CAPABILITIES,
    credentialEnv: [],
    async configure(paths) {
      writeFileSync(join(paths.home, "probe.mjs"), PROBE);
    },
    invocation(paths) {
      return { program: "node", args: [join(paths.home, "probe.mjs"), JSON.stringify(checks(paths))] };
    },
    decoder: fakeDecoder,
  });
}

function containers(name: string): string {
  return execFileSync("docker", ["ps", "-a", "--filter", `name=${name}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
}

describe.skipIf(!ENABLED)("container isolation on a real Docker daemon", () => {
  it("given a task under container isolation with the network off, when it runs, then its agent reaches no network, sees only its own task directory and no orchestrator path or Docker socket, the request opens and the container is gone", async () => {
    // given
    const ctx = await seeded();
    const checks = (paths: { root: string; git: string }) => ({
      tasks: join(paths.root, ".."),
      paths: {
        orchestratorDb: join(ctx.dataDir, "orchestrator.db"),
        mirrors: join(ctx.dataDir, "mirrors"),
        taskGit: paths.git,
        dockerSocket: "/var/run/docker.sock",
      },
    });
    const tasks = createTaskRunner(ctx, {
      agents: [probeAdapter(checks)],
      isolation: { mode: "container", network: "none", image: IMAGE, dataDir: ctx.dataDir, user: `${process.getuid!()}:${process.getgid!()}` },
      testCommand: () => null,
      hostEnv: process.env,
    });
    writeFileSync(join(ctx.dataDir, "orchestrator.db"), "");
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Probe the container", description: "", agent: "probe", user: ADMIN });
    await tasks.idle();

    // then
    const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
    expect(task.status).toBe("needs-review");
    const report = JSON.parse(git(["show", `task/${task.id}:probe.json`], localRepoPath(repo.url)!));
    expect(report.network).toMatch(/^failed/);
    expect(report.seen).toEqual({ orchestratorDb: false, mirrors: false, taskGit: false, dockerSocket: false });
    expect(report.tasks).toEqual([task.id]);
    expect(containers(`teamhandbook-task-${ctx.tenant}-${task.id}`)).toBe("");
  }, 120_000);

  it("given a task container a killed orchestrator left running, when the next orchestrator starts, then the container is removed", async () => {
    // given
    const ctx = await seeded();
    const id = "eeeeeeeeeeee";
    const name = `teamhandbook-task-${ctx.tenant}-${id}`;
    execFileSync("docker", ["run", "-d", "--rm", "--name", name, "--entrypoint", "sleep", IMAGE, "300"], { encoding: "utf8" });
    await ctx.store.createTask({
      tenant: ctx.tenant, id, repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "probe",
      status: "running", createdBy: "x", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null,
      cost: UNKNOWN_COST, requestNumber: null, error: null,
    });

    // when
    try {
      await createTaskRunner(ctx, {
        agents: [probeAdapter(() => ({}))],
        isolation: { mode: "container", network: "none", image: IMAGE, dataDir: ctx.dataDir },
        testCommand: () => null,
        hostEnv: process.env,
      }).ready();

      // then
      expect(containers(name)).toBe("");
    } finally {
      if (containers(name)) execFileSync("docker", ["rm", "-f", name]);
    }
  }, 120_000);
});
