import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localDataDir } from "./local.js";
import { localMode } from "./mode.js";

const held = new Map<string, DatabaseSync>();

/**
 * The orchestrator's data directory from its environment. An empty value is the default, for the
 * orchestrator and the demo seed alike: the system's application data place for a local one,
 * so a start from any folder finds the same data, and ./data for a team's.
 */
export function orchestratorDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCHESTRATOR_DATA_DIR) return resolve(env.ORCHESTRATOR_DATA_DIR);
  return localMode(env) ? localDataDir(env) : resolve("data");
}

/**
 * Where a start says its data lives. A team's default is the data folder of the directory it was
 * started from, so a start from another directory, or a fresh clone, opens an empty one: its key and
 * every sign-in sealed with it are new together. The sentence says so where the person reads it.
 */
export function dataDirSentence(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromHere = !env.ORCHESTRATOR_DATA_DIR && !localMode(env);
  return `Data and sealed sign-ins are kept in ${dataDir}${fromHere ? ", the data folder of the directory this was started from; start it from the same directory, or set ORCHESTRATOR_DATA_DIR, to find them again" : ""}.`;
}

/**
 * Makes the data directory this user's alone, since it holds the sessions and the sealed tokens:
 * a new one is made 0700 whatever the umask, and a local orchestrator's existing one is closed
 * again, as an earlier start left it open. A team's is left as its operator mounted it.
 */
export function privateDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (localMode(env)) chmodSync(dataDir, 0o700);
}

/**
 * Makes this process the one orchestrator on a data directory, or refuses to. Everything a start
 * does to what a previous orchestrator left - ending its agents, deleting its task directories -
 * is right only when no other orchestrator is still running on the same directory, and a second
 * start (a second `npm start`, a `docker compose run` on the same volume) would otherwise do
 * it to a live one. The lock is SQLite's exclusive lock on a file in the directory, held for
 * the life of the process: the system releases it when the process dies, however it dies, so
 * no stale lock is left to clear, and it holds across containers sharing a volume, where a
 * pid file would not (every container's orchestrator is pid 1).
 */
export function holdDataDir(dataDir: string, refusal = `another orchestrator is running on ${resolve(dataDir)}; this one stops without touching its tasks`): void {
  const file = join(resolve(dataDir), "orchestrator.lock");
  if (held.has(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    throw new Error(refusal);
  }
  held.set(file, db);
}
