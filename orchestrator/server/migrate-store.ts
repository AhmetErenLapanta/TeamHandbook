import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { holdDataDir } from "./data-lock.js";
import { readSecretEnv } from "./secret-env.js";
import { migratePostgres, newerSchema, SCHEMA_VERSION, SCHEMA_VERSION_TABLE } from "./store.js";
import type { SqlDriver, SqlValue } from "./store.js";
import { numberPlaceholders, tenantLockKey } from "./store-postgres.js";

/**
 * Moves an orchestrator's SQLite database into Postgres, for an install that started on SQLite and
 * grew. Everything happens in one transaction on the target: the tables are created, every row
 * of every tenant is copied, and the counts are read back and compared, so a run that stops
 * half-way - a refused row, a lost connection, Ctrl-C - leaves the target as it was. A dry run
 * does all of it and rolls back. The SQLite file is opened read-only and stays as it was, so
 * going back is starting the orchestrator without ORCHESTRATOR_DATABASE_URL.
 */

export interface MigrateOptions {
  /** The SQLite database file. */
  from: string;
  /** The Postgres connection URL. */
  to: string;
  dryRun: boolean;
}

export interface MigrateReport {
  dryRun: boolean;
  tenants: string[];
  tables: { table: string; rows: number }[];
}

/** The move did not start, or stopped and was rolled back, for a reason the operator acts on. */
export class MigrateRefused extends Error {}

export const MIGRATE_USAGE = "usage: ORCHESTRATOR_DATABASE_URL=<postgres:// URL> migrate-store --from sqlite:<path to orchestrator.db> [--dry-run]";

/** Rows sent in one INSERT, kept well under Postgres's 65535 parameters for the widest table. */
const BATCH_PARAMETERS = 30_000;

/**
 * The target is the database ORCHESTRATOR_DATABASE_URL names, the one the orchestrator runs on afterwards,
 * and never an argument: a command line is shown to every process on the machine and kept in the
 * shell's history, and the URL carries the database's password. An argument this command does not
 * read is refused without being repeated, since a mistyped `--to=` is that URL.
 */
export function parseMigrateArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): MigrateOptions {
  let from: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--from") {
      const value = argv[++i];
      if (!value) throw new MigrateRefused(`--from needs a value; ${MIGRATE_USAGE}`);
      from = value;
    } else if (arg === "--to" || arg.startsWith("--to=")) {
      throw new MigrateRefused(`the target is not given on the command line, where its password is seen by every process and kept in the shell's history; set ORCHESTRATOR_DATABASE_URL to it; ${MIGRATE_USAGE}`);
    } else throw new MigrateRefused(`migrate-store does not read one of its arguments; ${MIGRATE_USAGE}`);
  }
  let to: string | undefined;
  try {
    to = readSecretEnv(env, "ORCHESTRATOR_DATABASE_URL");
  } catch (err) {
    throw new MigrateRefused(`${(err as Error).message}; ${MIGRATE_USAGE}`);
  }
  if (!from?.startsWith("sqlite:") || from.length === "sqlite:".length) throw new MigrateRefused(`--from names the SQLite database as sqlite:<path>; ${MIGRATE_USAGE}`);
  if (!to || !/^postgres(ql)?:\/\//.test(to)) throw new MigrateRefused(`ORCHESTRATOR_DATABASE_URL names the Postgres database to move into, as a postgres:// URL; ${MIGRATE_USAGE}`);
  return { from: resolve(from.slice("sqlite:".length)), to, dryRun };
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The source's tables and their columns, as SQLite reports them, without the version and floor tables the migrations keep. */
function sourceShape(db: DatabaseSync): Map<string, string[]> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_version', 'schema_floor') ORDER BY name").all() as { name: string }[];
  return new Map(tables.map(({ name }) => [name, (db.prepare(`PRAGMA table_info(${quote(name)})`).all() as { name: string }[]).map((c) => c.name).sort()]));
}

async function targetShape(db: SqlDriver): Promise<Map<string, string[]>> {
  const rows = await db.all<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name NOT IN ('schema_version', 'schema_floor')",
  );
  const shape = new Map<string, string[]>();
  for (const r of rows) shape.set(r.table_name, [...(shape.get(r.table_name) ?? []), r.column_name]);
  for (const columns of shape.values()) columns.sort();
  return shape;
}

/** One connection's statements as the store's driver, with a transaction that is the one already open on it. */
function clientDriver(client: pg.Client): SqlDriver {
  const driver: SqlDriver = {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return (await client.query(numberPlaceholders(sql), params)).rows as T[];
    },
    async run(sql, params = []) {
      return (await client.query(numberPlaceholders(sql), params)).rowCount ?? 0;
    },
    transaction: (fn) => fn(driver),
    async exec(sql) {
      await client.query(sql);
    },
    close: async () => undefined,
  };
  return driver;
}

function countsBy(rows: { tenant: string; n: number | string }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.tenant, Number(r.n)]));
}

export async function migrateStore(options: MigrateOptions, say: (line: string) => void = () => undefined): Promise<MigrateReport> {
  if (!existsSync(options.from)) throw new MigrateRefused(`there is no SQLite database at ${options.from}`);
  // An orchestrator still running on the directory would go on writing to the file being moved.
  holdDataDir(dirname(options.from), `an orchestrator is running on ${dirname(options.from)}; stop it before moving its database`);
  const source = new DatabaseSync(options.from, { readOnly: true });
  try {
    source.exec("PRAGMA query_only = ON");
    const versioned = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
    const stored = versioned ? Number((source.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null }).version ?? 0) : 0;
    if (stored > SCHEMA_VERSION) throw new MigrateRefused(newerSchema(stored));
    if (stored < SCHEMA_VERSION) throw new MigrateRefused(`this database is at schema ${stored} and this orchestrator writes ${SCHEMA_VERSION}; start this orchestrator on it once so it moves up, stop it, then move it`);
    const shape = sourceShape(source);
    // The identity tables a cloud orchestrator keeps belong to no one organization, and a cloud orchestrator
    // runs on Postgres from its start; a SQLite file holding a row of them is not one to move.
    for (const [table, columns] of shape) {
      if (columns.includes("tenant")) continue;
      if (source.prepare(`SELECT 1 FROM ${quote(table)} LIMIT 1`).get()) throw new MigrateRefused(`the table ${table} holds rows that belong to no one organization; only an organization's rows are moved`);
      shape.delete(table);
    }
    const sourceCounts = new Map([...shape.keys()].map((table) => [table, countsBy(source.prepare(`SELECT tenant, COUNT(*) AS n FROM ${quote(table)} GROUP BY tenant`).all() as { tenant: string; n: number }[])]));
    const tenants = [...new Set([...sourceCounts.values()].flatMap((c) => [...c.keys()]))].sort();
    if (!tenants.length) throw new MigrateRefused("the SQLite database holds no organization's rows; there is nothing to move");
    say(`Moving ${tenants.length === 1 ? "tenant" : "tenants"} ${tenants.join(", ")} from ${options.from} into Postgres${options.dryRun ? " (dry run: rolled back at the end)" : ""}.`);

    const client = new pg.Client({ connectionString: options.to });
    // The URL carries a password, so neither it nor the driver's text about it is repeated.
    await client.connect().catch(() => {
      throw new MigrateRefused("the target Postgres database did not accept the connection; check the URL and that the database exists");
    });
    client.on("error", () => undefined);
    try {
      // The same lock an orchestrator takes for its tenant, so no orchestrator runs on these tenants in the target while they move.
      for (const tenant of tenants) {
        const { rows } = await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS held", [tenantLockKey(tenant)]);
        if (!rows[0]?.held) throw new MigrateRefused(`an orchestrator is running for tenant ${JSON.stringify(tenant)} on the target database; stop it before moving into it`);
      }
      const db = clientDriver(client);
      const targetCounts = async (table: string) => countsBy((await client.query<{ tenant: string; n: string }>(`SELECT tenant, COUNT(*) AS n FROM ${quote(table)} WHERE tenant = ANY($1) GROUP BY tenant`, [tenants])).rows);
      await client.query("BEGIN");
      try {
        await db.exec(SCHEMA_VERSION_TABLE);
        const targetVersion = Number((await db.all<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version"))[0]?.version ?? 0);
        if (targetVersion > SCHEMA_VERSION) throw new MigrateRefused(newerSchema(targetVersion));
        await migratePostgres(db);
        const target = await targetShape(db);
        for (const [table, columns] of shape) {
          const there = target.get(table);
          if (!there || there.join() !== columns.join()) throw new MigrateRefused(`the table ${table} is not the same in both databases; nothing was moved`);
        }
        for (const table of shape.keys()) {
          const taken = [...(await targetCounts(table)).keys()];
          if (taken.length) throw new MigrateRefused(`the target database already holds ${table} rows of ${taken.join(", ")}; move into a database without these organizations`);
        }

        const report: MigrateReport = { dryRun: options.dryRun, tenants, tables: [] };
        for (const [table, columns] of shape) {
          const select = source.prepare(`SELECT rowid AS "__rowid", ${columns.map(quote).join(", ")} FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`);
          const batch = Math.max(1, Math.floor(BATCH_PARAMETERS / columns.length));
          let after = 0;
          let copied = 0;
          for (;;) {
            const rows = select.all(after, batch) as Record<string, SqlValue>[];
            if (!rows.length) break;
            after = Number(rows[rows.length - 1]!.__rowid);
            const params = rows.flatMap((row) => columns.map((c) => row[c] ?? null));
            const values = rows.map((_, r) => `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(", ")})`).join(", ");
            await client.query(`INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES ${values}`, params);
            copied += rows.length;
          }
          report.tables.push({ table, rows: copied });
          say(`  ${table}: ${copied} ${copied === 1 ? "row" : "rows"}`);
        }

        // Read back before the commit: a count that differs from the source's rolls everything back.
        for (const [table, expected] of sourceCounts) {
          const got = await targetCounts(table);
          for (const tenant of tenants) {
            if ((got.get(tenant) ?? 0) !== (expected.get(tenant) ?? 0)) {
              throw new MigrateRefused(`${table} of ${tenant} has ${got.get(tenant) ?? 0} rows in Postgres and ${expected.get(tenant) ?? 0} in SQLite; nothing was moved`);
            }
          }
        }
        say("The counts match in every table for every organization.");
        await client.query(options.dryRun ? "ROLLBACK" : "COMMIT");
        return report;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  } finally {
    source.close();
  }
}

/** `node dist/server.js migrate-store ...`: prints what it did and answers the exit code. */
export async function migrateStoreCommand(argv: readonly string[], say: (line: string) => void = console.log, warn: (line: string) => void = console.error, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const report = await migrateStore(parseMigrateArgs(argv, env), say);
    say(
      report.dryRun
        ? "Dry run: the target database is as it was. Run again without --dry-run to move."
        : "Moved. Start the orchestrator with ORCHESTRATOR_DATABASE_URL set to this database, the same ORCHESTRATOR_DATA_DIR (the mirrors and file:// repositories stay there) and the same ORCHESTRATOR_SECRET_KEY. The SQLite file is unchanged: starting without ORCHESTRATOR_DATABASE_URL goes back to it.",
    );
    return 0;
  } catch (err) {
    if (err instanceof MigrateRefused) {
      warn(`migrate-store: ${err.message}`);
      return 1;
    }
    // A row or a statement Postgres refused: the transaction is rolled back, and its text can hold a value from a row, so it is not shown.
    warn(`migrate-store: Postgres refused the move (${(err as { code?: string }).code ?? "no code"}); it was rolled back and the target database is as it was`);
    return 1;
  }
}
