import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { labGit } from "../run.js";
import { orchestratorBuildAt, lab, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";

/** An orchestrator from before the schema was recorded, whose database this one moves up: the one the upgrade scenario starts from. */
const BEFORE_BACKUPS = process.env.LAB_BACKUP_FROM ?? "89b93a4";

const skill = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks a copy.\n---\n\nBody.\n`;

/** The log's lines written after `from` characters, until one matches or `ms` pass. */
async function logLine(file: string, from: number, pattern: RegExp, ms = 30_000): Promise<string> {
  for (let waited = 0; waited < ms; waited += 250) {
    const line = readFileSync(file, "utf8").slice(from).split("\n").find((l) => pattern.test(l));
    if (line) return line;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no line matching ${pattern} in ${file}`);
}

function teamRepository(dir: string): { bare: string; repos: { id: string; team: string; url: string }[] } {
  const bare = join(dir, "repos", "team-skills.git");
  seedTeamRepo(lab.path, { id: "team-skills", team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when it is the first.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
  return { bare, repos: [{ id: "team-skills", team: "Core", url: `file://${bare}` }] };
}

test.describe("copies of a running orchestrator", () => {
  test("given an orchestrator on SQLite with a request open in a repository by path, when its operator sends SIGUSR2 while it serves, then a copy is written, and an orchestrator restored from it alone shows the same people and the request with its branch", async () => {
    test.setTimeout(240_000);
    // given
    const tenant = unique("copied");
    const dir = join(lab.dir, "backups", tenant);
    const { repos } = teamRepository(dir);
    const code = unique("setup");
    const running = await startOrchestratorProcess({ port: spareOrchestratorPort(2), tenant, dataDir: join(dir, "data"), store: "sqlite", repos, setupCode: code });
    let said: string;
    let stillServing: number;
    let branch: string;
    let requests: { number: number; branch: string; status: string }[];
    // Stopped whatever fails: the next scenario starts its own orchestrator on the same port.
    try {
      const owner = await OrchestratorClient.setup(running.url, code, { email: `owner@${tenant}.example.invalid`, name: "Copied Owner" }, lab.password);
      const read = async () => (await owner.ok<{ repos: { head: string | null }[] }>("GET", "/api/repos")).repos[0]?.head ?? null;
      let head = await read();
      for (let i = 0; i < 480 && !head; i++) {
        await new Promise((r) => setTimeout(r, 250));
        head = await read();
      }
      const slug = unique("before-the-copy");
      const change = { kind: "skill.add", slug, content: skill(slug) };
      ({ branch } = await owner.ok<{ branch: string }>("POST", "/api/repos/team-skills/changes/proposal", { change }));
      await owner.ok("POST", "/api/repos/team-skills/changes", { baseSha: head, change, message: `add ${slug}`, branch });
      requests = (await owner.ok<{ requests: { number: number; branch: string; status: string }[] }>("GET", "/api/requests?repo=team-skills")).requests;

      // when
      const before = readFileSync(running.log, "utf8").length;
      process.kill(running.pid, "SIGUSR2");
      said = await logLine(running.log, before, /^backup: asked copy written to /);
      stillServing = (await owner.call("GET", "/api/me")).status;
    } finally {
      await running.stop();
    }

    // then a copy with the database and the repository's bundle was written while it served
    const copy = said.replace(/^backup: asked copy written to (\S+) .*$/, "$1");
    const manifest = JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8")) as { database: string; repositories: { bundle: string }[] };
    expect([stillServing, manifest.database, manifest.repositories.length]).toEqual([200, "orchestrator.db", 1]);

    // when an orchestrator is restored from the copy alone, into a new directory with the repository from its bundle
    const restored = join(dir, "restored");
    const restoredBare = join(restored, "repos", "team-skills.git");
    labGit(lab.path, ["clone", "--quiet", "--mirror", join(copy, manifest.repositories[0]!.bundle), restoredBare], dir);
    mkdirSync(join(restored, "data"), { recursive: true });
    copyFileSync(join(copy, "orchestrator.db"), join(restored, "data", "orchestrator.db"));
    const again = await startOrchestratorProcess({ port: spareOrchestratorPort(2), tenant, dataDir: join(restored, "data"), store: "sqlite", repos: [{ id: "team-skills", team: "Core", url: `file://${restoredBare}` }], setupCode: unique("unused") });
    try {
      const back = await OrchestratorClient.signIn(again.url, `owner@${tenant}.example.invalid`, lab.password);

      // then
      const shown = (await back.ok<{ requests: { number: number; branch: string; status: string }[] }>("GET", "/api/requests?repo=team-skills")).requests;
      expect(shown.map((r) => [r.number, r.branch, r.status])).toEqual(requests.map((r) => [r.number, r.branch, r.status]));
      expect(labGit(lab.path, ["rev-parse", "--verify", `refs/heads/${branch}`], restoredBare)).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await again.stop();
    }
  });

  test("given a database an earlier orchestrator wrote, when the current orchestrator opens it, then it copies the database first and says where, and a bad copy interval stops the orchestrator at start", async () => {
    test.setTimeout(240_000);
    // given
    const tenant = unique("upgraded");
    const dir = join(lab.dir, "backups", tenant);
    const { repos } = teamRepository(dir);
    const common = { port: spareOrchestratorPort(2), tenant, dataDir: join(dir, "data"), store: "sqlite" as const, repos };
    const code = unique("setup");
    const old = await startOrchestratorProcess({ ...common, setupCode: code, build: orchestratorBuildAt(BEFORE_BACKUPS) });
    await OrchestratorClient.setup(old.url, code, { email: `owner@${tenant}.example.invalid`, name: "Upgraded Owner" }, lab.password);
    await old.stop();

    // when the current orchestrator opens it with a bad interval, then with none
    const refused = await startOrchestratorProcess({ ...common, setupCode: unique("unused"), env: { ORCHESTRATOR_BACKUP_HOURS: "0" } });
    await refused.stop();
    const before = readFileSync(refused.log, "utf8").length;
    const current = await startOrchestratorProcess({ ...common, setupCode: unique("unused") });
    try {
      const said = await logLine(current.log, before, /^start: copied the database at schema \d+ to /);

      // then
      expect(refused.running()).toBe(false);
      expect(readFileSync(refused.log, "utf8")).toContain("ORCHESTRATOR_BACKUP_HOURS is a whole number from 1 to 8760; this orchestrator stops");
      const copies = readdirSync(join(dir, "data", "backups")).filter((n) => n.startsWith("before-schema-"));
      expect(copies).toHaveLength(1);
      expect(said).toContain(join(dir, "data", "backups", copies[0]!));
      expect(existsSync(join(dir, "data", "backups", copies[0]!))).toBe(true);
      expect((await (await OrchestratorClient.signIn(current.url, `owner@${tenant}.example.invalid`, lab.password)).call("GET", "/api/me")).status).toBe(200);
    } finally {
      await current.stop();
    }
  });
});
