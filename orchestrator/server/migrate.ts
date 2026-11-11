import { readSecretEnv } from "./secret-env.js";
import { postgresDriver } from "./store-postgres.js";
import { MIGRATIONS, migratePostgres, newerSchema, readSchemaFloor, readsNewerSchema, SCHEMA_FLOOR_TABLE, SCHEMA_VERSION, SCHEMA_VERSION_TABLE } from "./store.js";
import type { Migration, SqlDriver } from "./store.js";

/**
 * `node dist/server.js migrate`: moves a Postgres database to this image's schema and exits,
 * serving nothing and holding no organization, so it runs while the orchestrators of the release
 * before go on serving. A release moves the schema here, and only here, in ORCHESTRATOR_MODE=cloud.
 */

export const MIGRATE_USAGE = "usage: ORCHESTRATOR_DATABASE_URL=<postgres:// URL> migrate [--check] [--contract]";

export class SchemaMoveRefused extends Error {}

export interface SchemaPlan {
  stored: number;
  floor: number | null;
  /** The steps this image runs, in order. */
  pending: Migration[];
  /** The pending steps an orchestrator of the stored schema stops on; none for a database nothing has written. */
  contract: Migration[];
}

export async function schemaPlan(db: SqlDriver): Promise<SchemaPlan> {
  await db.exec(SCHEMA_VERSION_TABLE);
  await db.exec(SCHEMA_FLOOR_TABLE);
  const stored = Number((await db.all<{ version: number | null }>("SELECT MAX(version) AS version FROM schema_version"))[0]?.version ?? 0);
  const floor = await readSchemaFloor(db);
  const pending = MIGRATIONS.filter((m) => m.version > stored);
  return { stored, floor, pending, contract: stored === 0 ? [] : pending.filter((m) => m.kind === "contract") };
}

/** The plan's one-line summary, the line a release reads; it names versions and never the database. */
export function describePlan(plan: SchemaPlan): string {
  const moves = plan.pending.length ? `moves it to ${SCHEMA_VERSION}` : "moves nothing";
  return `schema: the database is at ${plan.stored}, this image writes ${SCHEMA_VERSION} and ${moves}${plan.contract.length ? `; contract steps ${plan.contract.map((m) => m.version).join(", ")}` : ""}`;
}

export function parseMigrateArgs(argv: readonly string[]): { check: boolean; contract: boolean } {
  const options = { check: false, contract: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--contract") options.contract = true;
    else throw new SchemaMoveRefused(`migrate does not read one of its arguments; ${MIGRATE_USAGE}`);
  }
  return options;
}

/**
 * What a move of this plan is refused for, or null. A contract step is refused without
 * --contract: the orchestrators of the release before stop on it, so the release has no way back
 * but the dump, and it ships only after the code that stopped using what it removes.
 */
export function moveRefused(plan: SchemaPlan, contract: boolean): string | null {
  if (plan.stored > SCHEMA_VERSION) return readsNewerSchema(plan.floor) ? null : newerSchema(plan.stored);
  if (plan.contract.length && !contract) {
    const steps = plan.contract.map((m) => `${m.version} (${m.name})`).join(", ");
    return `step ${steps} drops or changes what orchestrators at schema ${plan.stored} read, so they stop on it and the way back is the dump; run migrate --contract once no orchestrator before it serves`;
  }
  return null;
}

export async function migrateCommand(argv: readonly string[], say: (line: string) => void = console.log, warn: (line: string) => void = console.error, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let db: SqlDriver | null = null;
  try {
    const options = parseMigrateArgs(argv);
    let url: string | undefined;
    try {
      url = readSecretEnv(env, "ORCHESTRATOR_DATABASE_URL");
    } catch (err) {
      throw new SchemaMoveRefused((err as Error).message);
    }
    if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new SchemaMoveRefused(`migrate moves a Postgres database, named by ORCHESTRATOR_DATABASE_URL as a postgres:// URL; an orchestrator on SQLite moves its own at start; ${MIGRATE_USAGE}`);
    db = postgresDriver(url);
    const plan = await schemaPlan(db);
    say(describePlan(plan));
    const refused = moveRefused(plan, options.contract);
    if (refused) throw new SchemaMoveRefused(refused);
    if (plan.stored > SCHEMA_VERSION) {
      say(`migrate: the database is newer than this image and every change since ${SCHEMA_VERSION} only adds; this image reads it as it is`);
      return 0;
    }
    if (options.check) return 0;
    await migratePostgres(db);
    say(plan.pending.length ? `migrate: moved the database from schema ${plan.stored} to ${SCHEMA_VERSION}` : `migrate: the database is at schema ${SCHEMA_VERSION} already`);
    return 0;
  } catch (err) {
    if (err instanceof SchemaMoveRefused) {
      warn(`migrate: ${err.message}`);
      return 1;
    }
    // The URL carries a password, and a driver's text about a connection can repeat it.
    warn(`migrate: Postgres refused (${(err as { code?: string }).code ?? "no code"}); a move under way was rolled back`);
    return 1;
  } finally {
    await db?.close().catch(() => undefined);
  }
}
