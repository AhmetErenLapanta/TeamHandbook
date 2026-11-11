import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { describePlan, migrateCommand, moveRefused, parseMigrateArgs, SchemaMoveRefused } from "./migrate.js";
import type { SchemaPlan } from "./migrate.js";
import { openPostgresStore } from "./store-postgres.js";
import { MIGRATIONS, newerSchema, readableFrom, SCHEMA_VERSION } from "./store.js";

// The moves themselves run when ORCHESTRATOR_TEST_DATABASE_URL names a Postgres this suite may
// create and drop databases on, as the store contract does.
const PG_URL = process.env.ORCHESTRATOR_TEST_DATABASE_URL;

const plan = (stored: number, floor: number | null = readableFrom(stored)): SchemaPlan => {
  const pending = MIGRATIONS.filter((m) => m.version > stored);
  return { stored, floor, pending, contract: stored === 0 ? [] : pending.filter((m) => m.kind === "contract") };
};

describe("the migrate command's arguments and plan", () => {
  it("given --check and --contract, when they are read, then both are on, and an argument it does not read is refused with the usage", () => {
    expect(parseMigrateArgs(["--check", "--contract"])).toEqual({ check: true, contract: true });
    expect(parseMigrateArgs([])).toEqual({ check: false, contract: false });
    expect(() => parseMigrateArgs(["postgres://orchestrator:hunter2@db/orchestrator"])).toThrow(SchemaMoveRefused);
    expect(() => parseMigrateArgs(["postgres://orchestrator:hunter2@db/orchestrator"])).not.toThrow(/hunter2/);
  });

  it("given a database one expand step behind, when the move is judged, then it goes ahead and the summary names both versions", () => {
    const behind = plan(SCHEMA_VERSION - 1);
    expect(MIGRATIONS[SCHEMA_VERSION - 1]!.kind).toBe("expand");
    expect(moveRefused(behind, false)).toBeNull();
    expect(describePlan(behind)).toBe(`schema: the database is at ${SCHEMA_VERSION - 1}, this image writes ${SCHEMA_VERSION} and moves it to ${SCHEMA_VERSION}`);
  });

  it("given a database behind a contract step, when the move is judged without --contract, then it is refused naming the step, and with --contract it goes ahead", () => {
    const behind = plan(3);
    expect(moveRefused(behind, false)).toMatch(/^step 4 \(.+\) drops or changes what orchestrators at schema 3 read/);
    expect(moveRefused(behind, true)).toBeNull();
    expect(describePlan(behind)).toContain("contract steps 4");
  });

  it("given a database nothing has written, when the move is judged, then its contract steps need no flag", () => {
    expect(moveRefused(plan(0), false)).toBeNull();
  });

  it("given a newer database, when the move is judged, then it goes ahead only where every change since this image only adds", () => {
    expect(moveRefused(plan(SCHEMA_VERSION + 1, readableFrom(SCHEMA_VERSION)), false)).toBeNull();
    expect(moveRefused(plan(SCHEMA_VERSION + 1, SCHEMA_VERSION + 1), true)).toBe(newerSchema(SCHEMA_VERSION + 1));
    expect(moveRefused(plan(SCHEMA_VERSION + 1, null), true)).toBe(newerSchema(SCHEMA_VERSION + 1));
  });

  it("given no database URL, or a SQLite one, when migrate runs, then it is refused before any connection", async () => {
    const warned: string[] = [];
    expect(await migrateCommand([], () => undefined, (l) => void warned.push(l), {})).toBe(1);
    expect(await migrateCommand([], () => undefined, (l) => void warned.push(l), { ORCHESTRATOR_DATABASE_URL: "sqlite:orchestrator.db" })).toBe(1);
    expect(warned).toHaveLength(2);
    expect(warned.every((l) => l.startsWith("migrate: migrate moves a Postgres database"))).toBe(true);
  });
});

describe.skipIf(!PG_URL)("moving a Postgres database with migrate", () => {
  const dropped: string[] = [];
  afterEach(async () => {
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    for (const name of dropped.splice(0)) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  async function database(): Promise<{ url: string; query: (sql: string) => Promise<pg.QueryResult> }> {
    const name = `orchestrator_test_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    dropped.push(name);
    const url = new URL(PG_URL!);
    url.pathname = `/${name}`;
    const query = async (sql: string) => {
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };
    return { url: url.toString(), query };
  }

  const version = async (query: (sql: string) => Promise<pg.QueryResult>) => Number((await query("SELECT MAX(version) AS v FROM schema_version")).rows[0].v);

  it("given a database one step behind while an orchestrator of the release before holds its organization, when migrate runs, then it moves the schema without waiting for that hold", async () => {
    // given
    const { url, query } = await database();
    const before = await openPostgresStore(url, ["a"], () => undefined);
    await query(`DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION - 1})`);
    const said: string[] = [];

    // when
    const code = await migrateCommand([], (l) => void said.push(l), (l) => void said.push(l), { ORCHESTRATOR_DATABASE_URL: url });
    await before.close();

    // then
    expect(code).toBe(0);
    expect(said).toEqual([`schema: the database is at ${SCHEMA_VERSION - 1}, this image writes ${SCHEMA_VERSION} and moves it to ${SCHEMA_VERSION}`, `migrate: moved the database from schema ${SCHEMA_VERSION - 1} to ${SCHEMA_VERSION}`]);
    expect(await version(query)).toBe(SCHEMA_VERSION);
    expect(Number((await query("SELECT MAX(version) AS v FROM schema_floor")).rows[0].v)).toBe(readableFrom(SCHEMA_VERSION));
  });

  it("given a database behind a contract step, when migrate runs without --contract and with --check, then neither moves it, and --contract does", async () => {
    // given
    const { url, query } = await database();
    await (await openPostgresStore(url, ["a"], () => undefined)).close();
    await query("DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (3)");
    const env = { ORCHESTRATOR_DATABASE_URL: url };
    const quiet = () => undefined;

    // when
    const refused = await migrateCommand([], quiet, quiet, env);
    const checked = await migrateCommand(["--check", "--contract"], quiet, quiet, env);
    const at = await version(query);
    const moved = await migrateCommand(["--contract"], quiet, quiet, env);

    // then
    expect([refused, checked, moved]).toEqual([1, 0, 0]);
    expect(at).toBe(3);
    expect(await version(query)).toBe(SCHEMA_VERSION);
  });

  it("given an orchestrator on cloud terms and a database behind it, when the orchestrator opens it, then it stops asking for migrate and moves nothing", async () => {
    // given
    const { url, query } = await database();
    await (await openPostgresStore(url, ["a"], () => undefined)).close();
    await query(`DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION - 1})`);

    // when
    const opened = openPostgresStore(url, ["a"], () => undefined, { migrate: false });

    // then
    await expect(opened).rejects.toThrow(`this database is at schema ${SCHEMA_VERSION - 1} and this orchestrator writes ${SCHEMA_VERSION}; in ORCHESTRATOR_MODE=cloud only \`node dist/server.js migrate\` moves the schema, so run it first`);
    expect(await version(query)).toBe(SCHEMA_VERSION - 1);
  });
});
