import { createHash } from "node:crypto";
import { OrchestratorError } from "./errors.js";
import pg from "pg";
import type { PoolClient } from "pg";
import { createStore, migratePostgres, newerSchema, readingNewerSchema, readSchemaFloor, readsNewerSchema, SCHEMA_FLOOR_TABLE, SCHEMA_VERSION, SCHEMA_VERSION_TABLE } from "./store.js";
import type { SqlDriver, SqlValue, Store } from "./store.js";

/**
 * The same store over Postgres, for an install that keeps its data in a database it already
 * runs and backs up. Every statement is the one SQLite runs; only the placeholders change,
 * from `?` to `$1..$n`.
 */
export function numberPlaceholders(sql: string): string {
  let n = 0;
  let quoted = false;
  let out = "";
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === "?" && !quoted ? `$${++n}` : ch;
  }
  return out;
}

type Queryable = Pick<pg.Pool, "query"> | PoolClient;

function driverOver(conn: Queryable, transaction: SqlDriver["transaction"], close: () => Promise<void>): SqlDriver {
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return (await conn.query(numberPlaceholders(sql), params)).rows as T[];
    },
    async run(sql, params = []) {
      return (await conn.query(numberPlaceholders(sql), params)).rowCount ?? 0;
    },
    transaction,
    async exec(sql) {
      await conn.query(sql);
    },
    close,
  };
}

/** How often the connection holding a tenant is checked, and the longest one check is given. */
const HOLD_CHECK_MS = 10_000;

/** A key of the orchestrator's own for a tenant, so neither another tenant's orchestrator nor another program on the database shares it. */
export function tenantLockKey(tenant: string): string {
  return createHash("sha256").update(`teamhandbook-orchestrator\0${tenant}`).digest().readBigInt64BE(0).toString();
}

/** How long a request waits for another orchestrator's turn on the same repository before it is refused. */
export const REPOSITORY_TURN_MS = 60_000;

/** Another orchestrator of this database held the repository's turn past REPOSITORY_TURN_MS. */
export class RepositoryBusy extends OrchestratorError {
  constructor() {
    super("repository-busy", "another orchestrator on this database is opening a request to this repository; try again in a minute", 409);
  }
}

/** A key of the orchestrator's own for a team repository's address, shared by every tenant's orchestrator on the database. */
function repositoryLockKey(address: string): string {
  return createHash("sha256").update(`teamhandbook-orchestrator-repository\0${address}`).digest().readBigInt64BE(0).toString();
}

/**
 * Makes this process the one orchestrator of each tenant it serves on a database, or refuses to, as
 * `holdDataDir` does for a data directory. A second orchestrator with its own data directory
 * shares nothing on disk with the first, and its start would fail the first one's running
 * tasks and move their branches aside. The hold is a session advisory lock on a connection of
 * its own: the pool closes idle connections, and the lock would go with whichever one took it.
 *
 * The lock lasts as long as that connection, so when the connection goes the orchestrator is told
 * and stops; it does not take the lock again. Its writes to git, task directories and agents are
 * not fenced by the database, and the gap gives another orchestrator the chance to start and set this
 * tenant's work right; a lock taken again says nothing about whether one did. The check catches a
 * connection that dropped without closing, which no event reports.
 *
 * Every tenant's lock sits on the one connection, so the orchestrator serves all of them or none: one
 * refused ends the connection, and the locks already taken go with it.
 */
async function holdTenants(url: string, tenants: readonly string[], onLost: (reason: string) => void): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: url, keepAlive: true, query_timeout: HOLD_CHECK_MS });
  await client.connect();
  for (const tenant of tenants) {
    const { rows } = await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS held", [tenantLockKey(tenant)]);
    if (!rows[0]?.held) {
      await client.end();
      throw new Error(`another orchestrator is running for tenant ${JSON.stringify(tenant)} on this database; this one stops without touching its tasks`);
    }
  }
  let done = false;
  const lost = (reason: string) => {
    if (done) return;
    done = true;
    clearInterval(check);
    onLost(reason);
  };
  const check = setInterval(() => void client.query("SELECT 1").catch((err: Error) => lost(err.message)), HOLD_CHECK_MS);
  check.unref();
  client.on("error", (err) => lost(err.message));
  client.on("end", () => lost("the connection closed"));
  return async () => {
    done = true;
    clearInterval(check);
    await client.end().catch(() => undefined);
  };
}

/**
 * Opens the store for an orchestrator of the tenants it serves, holding them before anything is
 * written: a refused second orchestrator does not even add a column. `onLost` is called once if the
 * hold goes while the orchestrator runs.
 */
/** A driver over a pool of its own; `after` runs once the pool has ended, so nothing of it lands after. */
export function postgresDriver(url: string, after: () => Promise<void> = async () => undefined): SqlDriver {
  const pool = new pg.Pool({ connectionString: url });
  const transaction = async <T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    // A statement inside the callback runs on this one connection, so it sees and commits
    // with the rest of the transaction; a nested transaction call reuses it rather than
    // checking out a second connection that would not.
    const tx: SqlDriver = driverOver(client, (inner) => inner(tx), async () => undefined);
    try {
      await client.query("BEGIN");
      const value = await fn(tx);
      await client.query("COMMIT");
      return value;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };
  return driverOver(pool, transaction, async () => {
    await pool.end();
    await after();
  });
}

export interface PostgresOptions {
  /**
   * Whether a start moves the schema up. False in ORCHESTRATOR_MODE=cloud, where `migrate` moves it
   * once for every node and an orchestrator behind the database stops instead.
   */
  migrate?: boolean;
}

export async function openPostgresStore(url: string, tenants: readonly string[], onLost: (reason: string) => void, options: PostgresOptions = {}): Promise<Store> {
  const release = await holdTenants(url, tenants, onLost);
  // The pool ends before the hold does, so no statement of this orchestrator lands after it.
  const driver = postgresDriver(url, release);
  await driver.exec(SCHEMA_VERSION_TABLE);
  await driver.exec(SCHEMA_FLOOR_TABLE);
  const stored = Number((await driver.all<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version"))[0]?.version ?? 0);
  const floor = await readSchemaFloor(driver);
  if (stored > SCHEMA_VERSION) {
    if (!readsNewerSchema(floor)) {
      await driver.close();
      throw new Error(newerSchema(stored));
    }
    console.log(readingNewerSchema(stored));
  }
  // Orchestrators of several tenants share a database and may start together; the lock makes the
  // second wait and find the shape already moved up, so no row is rewritten twice.
  // The orchestrator holds no pg_dump; the copy before an upgrade is the operator's, and this says when it mattered.
  if (stored > 0 && stored < SCHEMA_VERSION) console.log(`start: this database moves from schema ${stored} to ${SCHEMA_VERSION}; a pg_dump taken before this start is the way back`);
  if (stored < SCHEMA_VERSION && options.migrate === false) {
    await driver.close();
    throw new Error(`this database is at schema ${stored} and this orchestrator writes ${SCHEMA_VERSION}; in ORCHESTRATOR_MODE=cloud only \`node dist/server.js migrate\` moves the schema, so run it first`);
  }
  if (stored < SCHEMA_VERSION || (stored === SCHEMA_VERSION && floor === null && options.migrate !== false)) await migratePostgres(driver);
  // A session lock on a connection of its own, outside the pool: holding a pool connection for
  // each turn while its work waited for another one let ten turns at once take every connection
  // and stop the orchestrator, sign-in included. A turn waits at most REPOSITORY_TURN_MS for another.
  const holdRepository = async <T>(address: string, work: () => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString: url });
    client.on("error", () => undefined);
    await client.connect();
    const key = repositoryLockKey(address);
    try {
      await client.query(`SET statement_timeout = ${REPOSITORY_TURN_MS}`);
      try {
        await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
      } catch {
        throw new RepositoryBusy();
      }
      try {
        return await work();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]).catch(() => undefined);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  };
  return Object.assign(createStore(driver), { holdRepository });
}
