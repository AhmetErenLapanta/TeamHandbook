import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { newId } from "./ids.js";
import { migrateStore, migrateStoreCommand, MigrateRefused, parseMigrateArgs } from "./migrate-store.js";
import { openSqliteStore, SCHEMA_VERSION } from "./store.js";
import { openPostgresStore } from "./store-postgres.js";

// The Postgres half runs when ORCHESTRATOR_TEST_DATABASE_URL names a Postgres this suite creates and drops its own databases on.
const PG_URL = process.env.ORCHESTRATOR_TEST_DATABASE_URL;
const TENANTS = ["alpha", "beta"];

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-migrate-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An orchestrator's SQLite database with people, repositories, settings, skill use and events in two organizations. */
async function seededSqlite(): Promise<string> {
  const file = join(scratch(), "data", "orchestrator.db");
  const store = openSqliteStore(file);
  for (const tenant of TENANTS) {
    for (const who of ["owner", "member"]) {
      await store.insertUser({ tenant, id: newId("usr"), email: `${who}@${tenant}.example.invalid`, name: `${tenant} ${who}`, role: who === "owner" ? "owner" : "member", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() });
    }
    await store.upsertRepo({ tenant, id: "team-skills", team: "Core", name: "team-skills", url: "file:///repos/team-skills.git" });
    await store.setSetting(tenant, "privacy", JSON.stringify({ leaderboard: "admins" }));
    await store.addUsage(tenant, "team-skills", "release-checklist", new Date().toISOString().slice(0, 13), 3);
    await store.appendEvent({ tenant, id: newId("evt"), at: new Date().toISOString(), kind: "account.changed", actor: { kind: "orchestrator", id: null, email: null, name: "TeamHandbook Orchestrator" }, repoId: null, subject: null, detail: "seeded" });
  }
  await store.close();
  return file;
}

async function admin<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function freshDatabase(): Promise<string> {
  const name = `orchestrator_migrate_${randomBytes(6).toString("hex")}`;
  await admin(PG_URL!, (c) => c.query(`CREATE DATABASE ${name}`));
  cleanups.push(() => admin(PG_URL!, async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))));
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

const rowsOf = (url: string, table: string, tenant: string) => admin(url, async (c) => Number((await c.query(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant = $1`, [tenant])).rows[0].n));

describe("the migrate-store command's arguments", () => {
  it("given a SQLite path, --dry-run and the Postgres URL in ORCHESTRATOR_DATABASE_URL, when they are read, then the path is absolute and the run is dry", () => {
    // given
    const argv = ["--from", "sqlite:data/orchestrator.db", "--dry-run"];

    // when
    const options = parseMigrateArgs(argv, { ORCHESTRATOR_DATABASE_URL: "postgres://orchestrator@db.example.invalid/orchestrator" });

    // then
    expect(options).toEqual({ from: join(process.cwd(), "data", "orchestrator.db"), to: "postgres://orchestrator@db.example.invalid/orchestrator", dryRun: true });
  });

  it("given the Postgres URL in the file ORCHESTRATOR_DATABASE_URL_FILE names, when they are read, then the file's URL is the target, and the URL set both ways is refused without repeating it", () => {
    // given
    const file = join(scratch(), "database_url");
    writeFileSync(file, "postgres://orchestrator:hunter2-password@db.example.invalid/orchestrator\n");

    // when
    const options = parseMigrateArgs(["--from", "sqlite:orchestrator.db"], { ORCHESTRATOR_DATABASE_URL_FILE: file });
    const both = () => parseMigrateArgs(["--from", "sqlite:orchestrator.db"], { ORCHESTRATOR_DATABASE_URL_FILE: file, ORCHESTRATOR_DATABASE_URL: "postgres://db/orchestrator" });

    // then
    expect(options.to).toBe("postgres://orchestrator:hunter2-password@db.example.invalid/orchestrator");
    expect(both).toThrow(MigrateRefused);
    expect(both).toThrow(/not both/);
    expect(both).not.toThrow(/hunter2/);
  });

  it("given a missing target, a target that is not Postgres, or an unknown flag, when they are read, then each is refused with the usage", () => {
    // given
    const cases: [string[], NodeJS.ProcessEnv][] = [
      [["--from", "sqlite:orchestrator.db"], {}],
      [["--from", "sqlite:orchestrator.db"], { ORCHESTRATOR_DATABASE_URL: "mysql://db/orchestrator" }],
      [["--from", "sqlite:orchestrator.db", "--force"], { ORCHESTRATOR_DATABASE_URL: "postgres://db/orchestrator" }],
    ];

    // when
    const refused = cases.map(([argv, env]) => {
      try {
        parseMigrateArgs(argv, env);
        return null;
      } catch (err) {
        return err;
      }
    });

    // then
    for (const err of refused) {
      expect(err).toBeInstanceOf(MigrateRefused);
      expect((err as Error).message).toContain("migrate-store --from sqlite:");
    }
  });

  it.each([
    ["--to and the URL", ["--to", "postgres://orchestrator:hunter2-password@db.example.invalid/orchestrator"]],
    ["--to= and the URL", ["--to=postgres://orchestrator:hunter2-password@db.example.invalid/orchestrator"]],
    ["an argument it does not read that holds the URL", ["postgres://orchestrator:hunter2-password@db.example.invalid/orchestrator"]],
  ])("given %s on the command line, when they are read, then the run is refused and the password is not repeated", (_label, extra) => {
    // when
    const read = () => parseMigrateArgs(["--from", "sqlite:orchestrator.db", ...extra], { ORCHESTRATOR_DATABASE_URL: "postgres://db/orchestrator" });

    // then
    expect(read).toThrow(MigrateRefused);
    expect(read).not.toThrow(/hunter2/);
  });
});

describe("moving a SQLite database that is not ready", () => {
  it("given a database at an older schema, when it is moved, then it is refused before any connection, asking for one start of this orchestrator first", async () => {
    // given
    const file = join(scratch(), "orchestrator.db");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version (version) VALUES (1);");
    old.close();

    // when
    const moving = migrateStore({ from: file, to: "postgres://nobody@127.0.0.1:1/none", dryRun: false });

    // then
    await expect(moving).rejects.toThrow(`this database is at schema 1 and this orchestrator writes ${SCHEMA_VERSION}; start this orchestrator on it once so it moves up, stop it, then move it`);
  });

  it("given a SQLite database that holds a cloud identity, when it is moved, then it is refused before any connection, naming the table", async () => {
    // given
    const from = await seededSqlite();
    const store = openSqliteStore(from);
    const at = new Date().toISOString();
    await store.insertIdentity({ id: newId("idn"), email: "person@example.invalid", name: "Person", emailVerifiedAt: at, termsUrl: null, termsAcceptedAt: null, createdAt: at }, { provider: "github", subject: "1", identityId: "", email: "person@example.invalid", addedAt: at });
    await store.close();

    // when
    const moving = migrateStore({ from, to: "postgres://nobody@127.0.0.1:1/none", dryRun: false });

    // then
    await expect(moving).rejects.toThrow("the table identities holds rows that belong to no one organization; only an organization's rows are moved");
  });

  it("given no file at the path, when it is moved, then it is refused", async () => {
    // given
    const file = join(scratch(), "missing.db");

    // when
    const moving = migrateStore({ from: file, to: "postgres://nobody@127.0.0.1:1/none", dryRun: false });

    // then
    await expect(moving).rejects.toThrow(`there is no SQLite database at ${file}`);
  });
});

describe.skipIf(!PG_URL)("moving a SQLite database into Postgres", () => {
  it("given a seeded SQLite database, when it is moved as a dry run, then every table's count is reported and the target is left without a table", async () => {
    // given
    const from = await seededSqlite();
    const to = await freshDatabase();

    // when
    const report = await migrateStore({ from, to, dryRun: true });

    // then
    expect(report.tenants).toEqual(TENANTS);
    expect(report.tables.find((t) => t.table === "users")?.rows).toBe(4);
    expect(report.tables.find((t) => t.table === "events")?.rows).toBe(2);
    expect(await admin(to, async (c) => (await c.query("SELECT to_regclass('users') AS t")).rows[0].t)).toBeNull();
  });

  it("given a seeded SQLite database, when it is moved, then an orchestrator opened on Postgres reads the same people, repositories, settings and skill use, and the SQLite file is unchanged", async () => {
    // given
    const from = await seededSqlite();
    const to = await freshDatabase();

    // when
    const report = await migrateStore({ from, to, dryRun: false });
    const store = await openPostgresStore(to, TENANTS, () => undefined);
    cleanups.push(() => store.close());

    // then
    expect(report.dryRun).toBe(false);
    for (const tenant of TENANTS) {
      expect((await store.listUsers(tenant)).map((u) => u.email).sort()).toEqual([`member@${tenant}.example.invalid`, `owner@${tenant}.example.invalid`]);
      expect((await store.listRepos(tenant)).map((r) => r.id)).toEqual(["team-skills"]);
      expect(await store.getSetting(tenant, "privacy")).toBe(JSON.stringify({ leaderboard: "admins" }));
    }
    const sqlite = openSqliteStore(from);
    cleanups.push(() => sqlite.close());
    expect((await sqlite.listUsers("alpha")).length).toBe(2);
  });

  it("given a target that already holds one of the organizations, when it is moved, then it is refused and the target keeps only what it had", async () => {
    // given
    const from = await seededSqlite();
    const to = await freshDatabase();
    const held = await openPostgresStore(to, ["beta"], () => undefined);
    await held.upsertRepo({ tenant: "beta", id: "already-here", team: "Core", name: "already-here", url: "file:///repos/already-here.git" });
    await held.close();

    // when
    const moving = migrateStore({ from, to, dryRun: false });

    // then
    await expect(moving).rejects.toThrow("the target database already holds repos rows of beta; move into a database without these organizations");
    expect([await rowsOf(to, "repos", "alpha"), await rowsOf(to, "repos", "beta")]).toEqual([0, 1]);
  });

  it("given an orchestrator running for one of the organizations on the target, when it is moved, then it is refused", async () => {
    // given
    const from = await seededSqlite();
    const to = await freshDatabase();
    const running = await openPostgresStore(to, ["alpha"], () => undefined);
    cleanups.push(() => running.close());

    // when
    const moving = migrateStore({ from, to, dryRun: false });

    // then
    await expect(moving).rejects.toThrow('an orchestrator is running for tenant "alpha" on the target database; stop it before moving into it');
  });

  it("given a target that refuses one row half-way, when it is moved, then the command says it was rolled back without showing the row, and no table holds anything moved", async () => {
    // given
    const from = await seededSqlite();
    const to = await freshDatabase();
    const shaped = await openPostgresStore(to, ["other"], () => undefined);
    await shaped.close();
    await admin(to, (c) => c.query("ALTER TABLE users ADD CONSTRAINT refuse_beta CHECK (email <> 'member@beta.example.invalid')"));
    const said: string[] = [];

    // when
    const code = await migrateStoreCommand(["--from", `sqlite:${from}`], () => undefined, (line) => said.push(line), { ORCHESTRATOR_DATABASE_URL: to });

    // then
    expect(code).toBe(1);
    expect(said.join("\n")).toContain("it was rolled back and the target database is as it was");
    expect(said.join("\n")).not.toContain("member@beta.example.invalid");
    for (const table of ["repos", "settings", "usage_counts", "users"]) expect([table, await rowsOf(to, table, "alpha")]).toEqual([table, 0]);
  });
});
