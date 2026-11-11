import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { labEnv } from "../run.js";
import { freshDatabase, lab, readHead, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";

/** `node dist/server.js migrate-store ...` as an operator runs it on the orchestrator's machine. */
function migrateStore(args: string[], home: string, database: string): { status: number | null; out: string; err: string } {
  const run = spawnSync("node", [join(lab.orchestratorDir, "dist", "server.js"), "migrate-store", ...args], { cwd: lab.orchestratorDir, env: labEnv(lab.path, { HOME: home, ORCHESTRATOR_DATABASE_URL: database }), encoding: "utf8" });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

const skill = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks a moved database.\n---\n\nBody.\n`;

test("given an orchestrator that ran on SQLite with people and a request, when its operator moves the database into Postgres with migrate-store, then a run is refused while the orchestrator runs, a dry run leaves Postgres as it was, and the orchestrator started on Postgres shows the same people and request", async () => {
  test.skip(!lab.postgres, "this lab has no Postgres");
  test.setTimeout(240_000);
  // given an orchestrator of its own on SQLite, with a team repository of its own
  const tenant = unique("moving");
  const dir = join(lab.dir, "migrations", tenant);
  const bare = join(dir, "repos", "team-skills.git");
  seedTeamRepo(lab.path, { id: "team-skills", team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when it is the first.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
  const repos = [{ id: "team-skills", team: "Core", url: `file://${bare}` }];
  const dataDir = join(dir, "data");
  const common = { port: spareOrchestratorPort(2), tenant, dataDir, repos };
  const people = { owner: `owner@${tenant}.example.invalid`, member: `member@${tenant}.example.invalid` };
  const code = unique("setup");
  const sqlite = await startOrchestratorProcess({ ...common, store: "sqlite", setupCode: code });
  const owner = await OrchestratorClient.setup(sqlite.url, code, { email: people.owner, name: "Moving Owner" }, lab.password);
  await owner.ok("POST", "/api/users", { email: people.member, name: "Moving Member", role: "member", teams: ["Core"], password: lab.password });
  const slug = unique("before-the-move");
  const head = await readHead(owner, "team-skills");
  const { branch } = await owner.ok<{ branch: string }>("POST", "/api/repos/team-skills/changes/proposal", { change: { kind: "skill.add", slug, content: skill(slug) } });
  await owner.ok("POST", "/api/repos/team-skills/changes", { baseSha: head, change: { kind: "skill.add", slug, content: skill(slug) }, message: `add ${slug}`, branch });
  const before = {
    users: (await owner.ok<{ users: { email: string; role: string }[] }>("GET", "/api/users")).users.map((u) => [u.email, u.role]).sort(),
    requests: (await owner.ok<{ requests: { number: number; title: string; status: string }[] }>("GET", "/api/requests?repo=team-skills")).requests.map((r) => [r.number, r.title, r.status]),
  };
  const database = freshDatabase();
  const args = ["--from", `sqlite:${join(dataDir, "orchestrator.db")}`];

  // when the operator moves it with the orchestrator still running
  const whileRunning = migrateStore(args, join(dir, "home"), database);
  await sqlite.stop();

  // and then as a dry run, and for real
  const dry = migrateStore([...args, "--dry-run"], join(dir, "home"), database);
  const moved = migrateStore(args, join(dir, "home"), database);

  // then
  expect([whileRunning.status, whileRunning.err]).toEqual([1, expect.stringContaining(`an orchestrator is running on ${dataDir}; stop it before moving its database`)]);
  expect([dry.status, dry.out]).toEqual([0, expect.stringContaining("Dry run: the target database is as it was.")]);
  expect([moved.status, moved.out]).toEqual([0, expect.stringContaining("The counts match in every table for every organization.")]);
  expect(moved.out + moved.err).not.toContain(database);

  // when the orchestrator starts on Postgres with the same data directory
  const postgres = await startOrchestratorProcess({ ...common, store: "postgres", databaseUrl: database, setupCode: unique("unused") });
  try {
    const again = await OrchestratorClient.signIn(postgres.url, people.owner, lab.password);

    // then it shows what the SQLite orchestrator held
    expect((await again.ok<{ users: { email: string; role: string }[] }>("GET", "/api/users")).users.map((u) => [u.email, u.role]).sort()).toEqual(before.users);
    expect((await again.ok<{ requests: { number: number; title: string; status: string }[] }>("GET", "/api/requests?repo=team-skills")).requests.map((r) => [r.number, r.title, r.status])).toEqual(before.requests);
    expect((await OrchestratorClient.signIn(postgres.url, people.member, lab.password).then((m) => m.call("GET", "/api/me"))).status).toBe(200);
  } finally {
    await postgres.stop();
  }
});
