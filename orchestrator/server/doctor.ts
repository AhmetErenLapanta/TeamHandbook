import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupSettings } from "./backup.js";
import type { BackupSettings } from "./backup.js";
import { orchestratorDataDir, holdDataDir, privateDataDir } from "./data-lock.js";
import { connectedOrgs, orgDir, profileFile } from "../runner/profile.js";
import { readSecretEnv } from "./secret-env.js";
import { RUNNER_SERVICE, serviceEnvFile, serviceInstalled } from "./service.js";
import { GENERATED_KEY_FILE } from "./vault.js";
import { postgresDriver } from "./store-postgres.js";
import { newerSchema, readSchemaFloor, readsNewerSchema, SCHEMA_FLOOR_TABLE, SCHEMA_VERSION, SCHEMA_VERSION_TABLE } from "./store.js";

/**
 * `node dist/server.js doctor [--fix]`: looks a stopped orchestrator's data over and says what is
 * wrong, each with the line that sets it right. It holds the data directory while it runs, so it
 * refuses beside a running orchestrator and no orchestrator starts under it. --fix does the one repair
 * that needs no orchestrator, reclaiming a SQLite database's free pages; everything a start sets right
 * (a stopped orchestrator's tasks, its task directories, a request cut off) is left to the start.
 */

export interface Finding {
  code: string;
  problem: boolean;
  say: string;
  fix?: string;
}

const BACKUP_NAME = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** What the database's recorded shape means for this image, the same rule the store applies at start. */
export function schemaFindings(stored: number, floor: number | null, cloud: boolean): Finding[] {
  if (stored > SCHEMA_VERSION) {
    return readsNewerSchema(floor)
      ? [{ code: "schema-newer-readable", problem: false, say: `the database is at schema ${stored}, newer than this image's ${SCHEMA_VERSION}; every change since only adds, so this image reads it` }]
      : [{ code: "schema-newer", problem: true, say: newerSchema(stored), fix: "start the newer image again, or restore the copy taken before the upgrade" }];
  }
  if (stored < SCHEMA_VERSION && stored > 0) {
    return [{ code: "schema-behind", problem: false, say: `the database is at schema ${stored} and this image writes ${SCHEMA_VERSION}`, fix: cloud ? "run node dist/server.js migrate before the orchestrator starts" : "the next start moves it, after a copy" }];
  }
  return [{ code: "schema", problem: false, say: `the database is at this image's schema, ${SCHEMA_VERSION}` }];
}

/** The newest of the orchestrator's own copies, by the time in its name. */
export function newestBackup(dir: string): Date | null {
  if (!existsSync(dir)) return null;
  const times = readdirSync(dir).flatMap((name) => {
    const m = BACKUP_NAME.exec(name);
    return m ? [new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)] : [];
  });
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

/** Whether the orchestrator's copies keep up with the schedule ORCHESTRATOR_BACKUP_HOURS sets. */
export function backupFindings(settings: Pick<BackupSettings, "everyHours" | "dir">, newest: Date | null, postgres: boolean, now: Date = new Date()): Finding[] {
  const database = postgres ? " (on Postgres the database is pg_dump's, which these copies do not hold)" : "";
  if (!settings.everyHours) {
    return [{ code: "backup-unscheduled", problem: false, say: `no copy is taken on a schedule${database}`, fix: "set ORCHESTRATOR_BACKUP_HOURS, or take one with SIGUSR2 while the orchestrator runs" }];
  }
  if (!newest) return [{ code: "backup-none", problem: true, say: `ORCHESTRATOR_BACKUP_HOURS is ${settings.everyHours} and ${settings.dir} holds no copy${database}`, fix: "start the orchestrator and send it SIGUSR2, then check the backup lines in its log" }];
  const hours = (now.getTime() - newest.getTime()) / 3_600_000;
  // Two periods: one missed copy is an orchestrator that was stopped, two is a schedule that is not running.
  if (hours > settings.everyHours * 2) {
    return [{ code: "backup-stale", problem: true, say: `the newest copy is ${Math.floor(hours)} hours old and ORCHESTRATOR_BACKUP_HOURS is ${settings.everyHours}${database}`, fix: "check the orchestrator's log for backup lines that say the copy was not written" }];
  }
  return [{ code: "backup", problem: false, say: `the newest copy is ${Math.floor(hours)} hours old${database}` }];
}

/** What a SQLite database file says of itself: whether it is whole, and the space a VACUUM gives back. */
export function sqliteFindings(file: string, fix: boolean, cloud: boolean, say: (line: string) => void): Finding[] {
  if (!existsSync(file)) return [{ code: "database-none", problem: false, say: `${file} does not exist yet; the first start makes it` }];
  const damaged = (detail: string): Finding[] => [{ code: "database-damaged", problem: true, say: `${file} fails SQLite's check: ${detail}`, fix: "restore the newest copy from the backup directory" }];
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
    db.exec(SCHEMA_VERSION_TABLE + SCHEMA_FLOOR_TABLE);
  } catch (err) {
    return damaged((err as Error).message);
  }
  try {
    const checked = (db.prepare("PRAGMA quick_check").all() as { quick_check: string }[]).map((r) => r.quick_check);
    if (checked.join() !== "ok") return damaged(checked.slice(0, 3).join("; "));
    const stored = Number((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0);
    const floorRow = (db.prepare("SELECT MAX(version) AS v FROM schema_floor").get() as { v: number | null }).v;
    const findings = schemaFindings(stored, floorRow === null ? null : Number(floorRow), cloud);
    const page = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const free = Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
    const bytes = page * free;
    if (bytes < 1024 * 1024) return [...findings, { code: "space", problem: false, say: "the database has no space worth reclaiming" }];
    const mb = (bytes / 1024 / 1024).toFixed(1);
    if (!fix) return [...findings, { code: "space-reclaimable", problem: false, say: `${mb} MB of the database is free pages`, fix: "run doctor --fix to give it back" }];
    // The orchestrator keeps its database in WAL mode, where the file shrinks only once the log is written back.
    db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    say(`doctor: reclaimed ${mb} MB with VACUUM`);
    return [...findings, { code: "space", problem: false, say: `${mb} MB given back` }];
  } finally {
    db.close();
  }
}

/**
 * Whether others on this machine can read the data: the directory holds the database and, on a
 * orchestrator only its one user reaches, the key that seals its tokens and secrets.
 */
export function permissionFindings(dataDir: string): Finding[] {
  if (!existsSync(dataDir)) return [];
  const findings: Finding[] = [];
  if (statSync(dataDir).mode & 0o077) findings.push({ code: "data-dir-open", problem: true, say: `others on this machine can reach ${dataDir}`, fix: `chmod 700 ${JSON.stringify(dataDir)}` });
  const key = join(dataDir, GENERATED_KEY_FILE);
  if (existsSync(key) && statSync(key).mode & 0o077) findings.push({ code: "key-open", problem: true, say: `others on this machine can read ${key}, the key that seals its tokens and secrets`, fix: `chmod 600 ${JSON.stringify(key)}` });
  return findings.length ? findings : [{ code: "permissions", problem: false, say: "the data directory and its key are this user's alone" }];
}

/** The directories a stopped orchestrator's tasks left, which the next start clears. */
export function leftoverFindings(dataDir: string): Finding[] {
  const tasks = join(dataDir, "tasks");
  if (!existsSync(tasks)) return [];
  const left = readdirSync(tasks).flatMap((tenant) => (statSync(join(tasks, tenant)).isDirectory() ? readdirSync(join(tasks, tenant)) : []));
  return left.length ? [{ code: "task-dirs", problem: false, say: `${left.length} task ${left.length === 1 ? "directory" : "directories"} left by an orchestrator that stopped`, fix: "the next start ends those tasks and clears them" }] : [];
}

/** What doctor knows of this login's services, apart from the data directory. */
export interface ServiceFacts {
  /** Whether the runner's own service is installed for this user. */
  runnerService: boolean;
  /** ~/.handbook-orchestrator/service.env, which every service starts with. */
  envFile: string;
}

/** Whether a process with this id is alive; a test hands one that answers from a list. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * The runner on this machine: the organizations it is connected to, whether a runner runs for
 * each, the files that hold each connection's key, and a runner service with nothing to run for,
 * which would only start and stop again.
 */
export function runnerFindings(dataDir: string, services: ServiceFacts, isAlive: (pid: number) => boolean = alive): Finding[] {
  const findings: Finding[] = [];
  const orgs = connectedOrgs(dataDir);
  if (services.runnerService && !orgs.length) {
    findings.push({ code: "runner-service-unconnected", problem: true, say: "the runner service is installed but this machine is connected to no orchestrator, so it starts and stops again", fix: "handbook-orchestrator runner service uninstall, or connect the machine with runner connect" });
  }
  for (const org of orgs) {
    const profile = profileFile(dataDir, org);
    if (statSync(profile).mode & 0o077) findings.push({ code: "runner-key-open", problem: true, say: `others on this machine can read ${profile}, which holds this machine's key for ${org}`, fix: `chmod 600 ${JSON.stringify(profile)}` });
    const lock = join(orgDir(dataDir, org), "runner.lock");
    const pid = existsSync(lock) ? Number(readFileSync(lock, "utf8")) : 0;
    const running = pid > 0 && isAlive(pid);
    findings.push(
      running
        ? { code: "runner", problem: false, say: `connected to ${org}; a runner runs its tasks here (process ${pid})` }
        : { code: "runner-stopped", problem: false, say: `connected to ${org}; no runner runs its tasks now${pid ? ", and the lock a stopped one left is taken over by the next" : ""}`, fix: services.runnerService ? "the runner service starts one; handbook-orchestrator runner service status says why it does not" : "handbook-orchestrator runner start, or runner service install to keep one running" },
    );
  }
  if (existsSync(services.envFile) && statSync(services.envFile).mode & 0o077) {
    findings.push({ code: "service-env-open", problem: true, say: `others on this machine can reach ${services.envFile}, so a service refuses to start with it`, fix: `chmod 600 ${JSON.stringify(services.envFile)}` });
  }
  return findings;
}

export async function doctorCommand(argv: readonly string[], say: (line: string) => void = console.log, env: NodeJS.ProcessEnv = process.env, services: ServiceFacts = thisLoginsServices()): Promise<number> {
  const unknown = argv.filter((a) => a !== "--fix");
  if (unknown.length) {
    say("doctor: usage: node dist/server.js doctor [--fix]");
    return 2;
  }
  const fix = argv.includes("--fix");
  const dataDir = orchestratorDataDir(env);
  try {
    // A folder this makes first is made as a start would make it, so doctor never reports its own as open.
    privateDataDir(dataDir, env);
    holdDataDir(dataDir, `an orchestrator is running on ${dataDir}; stop it before doctor looks its data over`);
  } catch (err) {
    say(`doctor: ${(err as Error).message}`);
    return 1;
  }
  const cloud = env.ORCHESTRATOR_MODE === "cloud";
  const findings: Finding[] = [];
  try {
    const url = readSecretEnv(env, "ORCHESTRATOR_DATABASE_URL");
    if (url) {
      const db = postgresDriver(url);
      try {
        await db.exec(SCHEMA_VERSION_TABLE);
        await db.exec(SCHEMA_FLOOR_TABLE);
        const stored = Number((await db.all<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version"))[0]?.v ?? 0);
        findings.push(...schemaFindings(stored, await readSchemaFloor(db), cloud));
      } catch (err) {
        // A driver's text about a connection can repeat the URL's password, so only its code is said.
        findings.push({ code: "database-unreachable", problem: true, say: `Postgres did not answer (${(err as { code?: string }).code ?? "no code"})`, fix: "check ORCHESTRATOR_DATABASE_URL and that the database runs" });
      } finally {
        await db.close().catch(() => undefined);
      }
    } else {
      findings.push(...sqliteFindings(join(dataDir, "orchestrator.db"), fix, cloud, say));
    }
    findings.push(...backupFindings(backupSettings(env, dataDir), newestBackup(backupSettings(env, dataDir).dir), Boolean(url)));
  } catch (err) {
    say(`doctor: ${(err as Error).message}`);
    return 1;
  }
  findings.push(...permissionFindings(dataDir), ...leftoverFindings(dataDir), ...runnerFindings(dataDir, services));
  for (const f of findings) say(`doctor: ${f.problem ? "PROBLEM" : "ok     "} ${f.code}: ${f.say}${f.fix ? `; ${f.fix}` : ""}`);
  return findings.some((f) => f.problem) ? 1 : 0;
}

function thisLoginsServices(): ServiceFacts {
  return { runnerService: serviceInstalled(process.platform, homedir(), RUNNER_SERVICE), envFile: serviceEnvFile(homedir()) };
}
