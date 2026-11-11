import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { Redactor } from "../server/tasks/redact.js";
import { orchestratorBuildAt } from "./build-at.js";
import { freePort } from "./clean-machine.js";
import { OrchestratorClient } from "./client.js";
import { seedTeamRepo } from "./repos.js";
import { labEnv, labGit } from "./run.js";
import { readLab } from "./state.js";

/**
 * An old orchestrator's Postgres database, kept in the repository for the release gate to load
 * and upgrade (DEPLOY-sozlesme "TC-20"): the orchestrator as `ref` built it starts on a fresh
 * database in the lab's Postgres, is filled through its own API with an owner, a member, a team
 * repository and a task that ran to review, and is stopped; pg_dump then writes it as plain SQL.
 * Sessions are dropped, the run's own directory is named /srv/fixture, and a dump that still
 * holds a machine path, a credential the Redactor knows, or a sealed value is refused. Its header
 * names the schema, the ref and each table's rows.
 */

const ref = process.argv[2];
if (!ref) {
  console.error("usage: sh lab/fixture-dump.sh <ref>");
  process.exit(2);
}
const lab = readLab();
if (!lab.postgres) throw new Error("this lab has no Postgres; start it with npm run lab");
const sha = labGit(lab.path, ["rev-parse", "--verify", `${ref}^{commit}`], lab.orchestratorDir);
const build = orchestratorBuildAt(lab, ref);
const run = join(lab.dir, "fixture-dump", `${sha.slice(0, 12)}-${Date.now().toString(36)}`);
for (const sub of ["home", "tmp", "data", "scratch"]) mkdirSync(join(run, sub), { recursive: true });

const admin = lab.postgres.url;
const name = `fixture_${sha.slice(0, 12)}_${randomBytes(3).toString("hex")}`;
const database = new URL(admin);
database.pathname = `/${name}`;
const sql = async (text: string, url = admin) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text)).rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
};

const bare = join(run, "repos", "team-skills.git");
seedTeamRepo(lab.path, { id: "team-skills", team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when an old database is upgraded.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(run, "scratch"));
writeFileSync(join(run, "orchestrator.json"), JSON.stringify({ tenant: "fixture", repos: [{ id: "team-skills", team: "Core", name: "team-skills", url: `file://${bare}` }] }) + "\n");

await sql(`CREATE DATABASE ${name}`);
const port = await freePort();
const code = `fixture-setup-${randomBytes(8).toString("hex")}`;
const log = join(run, "orchestrator.log");
const child = spawn("node", [join(build, "dist", "server.js")], {
  cwd: build,
  stdio: ["ignore", openSync(log, "a"), openSync(log, "a")],
  env: labEnv(lab.path, {
    HOME: join(run, "home"),
    TMPDIR: join(run, "tmp"),
    ORCHESTRATOR_DATA_DIR: join(run, "data"),
    ORCHESTRATOR_CONFIG: join(run, "orchestrator.json"),
    ORCHESTRATOR_PORT: String(port),
    ORCHESTRATOR_HOST: "127.0.0.1",
    ORCHESTRATOR_PUBLIC_URL: `http://127.0.0.1:${port}`,
    ORCHESTRATOR_MODE: "self-hosted",
    ORCHESTRATOR_SERVER_TASKS: "1",
    ORCHESTRATOR_AUTH: "local",
    ORCHESTRATOR_SETUP_TOKEN: code,
    ORCHESTRATOR_SECRET_KEY: randomBytes(32).toString("base64"),
    ORCHESTRATOR_AGENTS: "fake",
    ORCHESTRATOR_WEB_ROOT: join(build, "dist", "web"),
    ORCHESTRATOR_DATABASE_URL: database.toString(),
  }),
});
const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
const base = `http://127.0.0.1:${port}`;
const wait = async <T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> => {
  for (let i = 0; i < 480; i++) {
    const value = await read();
    if (done(value)) return value;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what}: ${readFileSync(log, "utf8").trim().split("\n").slice(-5).join(" | ")}`);
};
try {
  await wait(() => fetch(`${base}/api/health`).then((r) => r.ok, () => false), Boolean, "the orchestrator did not start");
  const owner = await OrchestratorClient.setup(base, code, { email: "owner@fixture.example.invalid", name: "Fixture Owner" }, lab.password);
  await owner.ok("POST", "/api/users", { email: "member@fixture.example.invalid", name: "Fixture Member", role: "member", teams: ["Core"], password: lab.password });
  await wait(() => owner.ok<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos"), (r) => Boolean(r.repos.find((x) => x.id === "team-skills")?.head), "the orchestrator did not read the team repository");
  const { task } = await owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: "Add a fixture skill", description: "Add a skill named after this task.", repoId: "team-skills", agent: "fake" });
  const done = await wait(() => owner.ok<{ task: { status: string; requestNumber: number | null } }>("GET", `/api/tasks/${task.id}`), (r) => !["queued", "running"].includes(r.task.status) && r.task.requestNumber !== null, "the task did not reach review");
  if (done.task.status !== "needs-review") throw new Error(`the task ended ${done.task.status}`);
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  await exited;
}

try {
  // A session's cookie hash and its CSRF token are a sign-in, not data an upgrade carries.
  await sql("DELETE FROM sessions", database.toString());
  const sealed = Number((await sql("SELECT count(*) AS n FROM secrets", database.toString()))[0]!.n);
  if (sealed) throw new Error(`the database holds ${sealed} sealed value(s); a fixture carries none`);
  const version = Number((await sql("SELECT MAX(version) AS v FROM schema_version", database.toString()))[0]!.v);
  const floor = await sql("SELECT * FROM schema_floor", database.toString()).catch(() => []);
  const tables = (await sql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename", database.toString())).map((t) => String(t.tablename));
  const rows: string[] = [];
  for (const table of tables) rows.push(`--   ${table}: ${(await sql(`SELECT count(*) AS n FROM "${table}"`, database.toString()))[0]!.n}`);

  const dumped = spawnSync("pg_dump", ["--no-owner", "--no-privileges", "--dbname", database.toString()], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (dumped.status !== 0) throw new Error(`pg_dump failed: ${dumped.stderr}`);
  let text = dumped.stdout;
  for (const dir of [...new Set([run, realpathSync(run)])].sort((a, b) => b.length - a.length)) text = text.split(dir).join("/srv/fixture");
  const leaks = text.split("\n").flatMap((line, n) => {
    const path = /(\/Users\/|\/private\/|\/var\/folders\/|\/tmp\/|\/home\/)/.test(line) ? "a machine path" : null;
    const credential = new Redactor([lab.password, code]).line(line) !== line ? "a credential" : null;
    return path || credential ? [`line ${n + 1}: ${path ?? credential}`] : [];
  });
  if (leaks.length) throw new Error(`the dump is refused, it holds:\n${leaks.slice(0, 20).join("\n")}`);

  const header = [
    `-- An orchestrator's Postgres database at schema ${version}${floor.length ? ` (floor ${JSON.stringify(floor[0])})` : ""}, made by lab/fixture-dump.sh from ${ref} (${sha}).`,
    "-- Filled through the orchestrator's API: an owner and a member (.example.invalid), the team repository team-skills, one task that ran to review. No session, no sealed value.",
    "-- Rows per table:",
    ...rows,
    "",
  ].join("\n");
  const out = join(lab.orchestratorDir, "lab", "fixtures", "postgres", `schema-${version}.sql`);
  mkdirSync(join(lab.orchestratorDir, "lab", "fixtures", "postgres"), { recursive: true });
  writeFileSync(out, header + text);
  console.log(`${out} (schema ${version}, ${tables.length} tables)`);
} finally {
  await sql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
