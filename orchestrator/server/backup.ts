import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { localRepoPath } from "./forge/local.js";
import { gitAsync, oneAtATime } from "./git.js";
import { askForBackup, runningAddress } from "./local.js";
import { SCHEMA_VERSION } from "./store.js";
import type { RepoRecord, Store } from "./store.js";

/**
 * A copy of the orchestrator taken while it runs: its SQLite database read as one snapshot, and every
 * team repository it reaches by path as a git bundle. The database is copied first and the
 * repositories after, each while no write to it is under way: a request opened in between leaves
 * a branch the copy's database does not name, which the next start moves aside rather than
 * losing, never a request whose branch is missing. On Postgres the copy holds the repositories
 * alone; the database is pg_dump's, which reads one snapshot of its own.
 */

export interface BackupSettings {
  /** Hours between scheduled copies; null takes none on a schedule. */
  everyHours: number | null;
  /** Copies kept; the oldest beyond it are removed after each new one. */
  keep: number;
  dir: string;
}

export interface Backup {
  path: string;
  database: "sqlite" | "postgres";
  repositories: number;
}

const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export class BackupSettingRefused extends Error {}

function wholeNumber(env: NodeJS.ProcessEnv, name: string, min: number, max: number, offAt0 = false): number | null {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (offAt0 && raw === "0") return 0;
  if (!/^\d+$/.test(raw) || n < min || n > max) throw new BackupSettingRefused(`${name} is a whole number from ${min} to ${max}${offAt0 ? ", or 0 for none" : ""}`);
  return n;
}

/** Hours between the copies a local orchestrator takes when nothing is set: its data is its person's only copy. */
export const LOCAL_BACKUP_HOURS = 24;
/** How long after a start a copy that is due is taken, so the start itself is not slowed. */
export const FIRST_COPY_DELAY_MS = 30_000;

export function backupSettings(env: NodeJS.ProcessEnv, dataDir: string, local = false): BackupSettings {
  const hours = wholeNumber(env, "ORCHESTRATOR_BACKUP_HOURS", 1, 8760, true);
  return {
    everyHours: hours === 0 ? null : (hours ?? (local ? LOCAL_BACKUP_HOURS : null)),
    keep: wholeNumber(env, "ORCHESTRATOR_BACKUP_KEEP", 1, 1000) ?? 7,
    dir: resolve(env.ORCHESTRATOR_BACKUP_DIR || join(dataDir, "backups")),
  };
}

/** The repositories reached by path, once each however many organizations name them, in a fixed order. */
function localRepositories(repos: readonly RepoRecord[]): { path: string; url: string }[] {
  const byPath = new Map<string, string>();
  for (const repo of repos) {
    const path = localRepoPath(repo.url);
    if (path && existsSync(path) && !byPath.has(path)) byPath.set(path, repo.url);
  }
  return [...byPath].sort(([a], [b]) => a.localeCompare(b)).map(([path, url]) => ({ path, url }));
}

/** Runs `work` while each repository's turn is held, taken in a fixed order so two copies never wait on each other. */
function holdingTurns<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
  const [first, ...rest] = paths;
  return first === undefined ? work() : oneAtATime(first, () => holdingTurns(rest, work));
}

export async function takeBackup(store: Store, repos: readonly RepoRecord[], settings: Pick<BackupSettings, "dir" | "keep">, reason: string, now: Date = new Date()): Promise<Backup> {
  mkdirSync(settings.dir, { recursive: true, mode: 0o700 });
  // A mode given to mkdir is for a folder it makes; one already there keeps whatever it had, and
  // a folder others read lists the copies and their manifests. One that cannot be closed is not
  // written into.
  chmodSync(settings.dir, 0o700);
  // A copy cut off by a stop is left as .partial and never mistaken for a whole one.
  for (const name of readdirSync(settings.dir)) if (name.endsWith(".partial")) rmSync(join(settings.dir, name), { recursive: true, force: true });
  const name = `backup-${now.toISOString().replace(/[:.]/g, "-")}`;
  const partial = join(settings.dir, `${name}.partial`);
  mkdirSync(join(partial, "repos"), { recursive: true, mode: 0o700 });
  const database = store.snapshotTo ? "sqlite" : "postgres";
  if (store.snapshotTo) {
    await store.snapshotTo(join(partial, "orchestrator.db"));
    chmodSync(join(partial, "orchestrator.db"), 0o600);
  }
  const local = localRepositories(repos);
  const bundles: { url: string; path: string; bundle: string | null }[] = [];
  await holdingTurns(
    local.map((r) => r.path),
    async () => {
      for (const [i, repo] of local.entries()) {
        const bundle = `repos/${i + 1}.bundle`;
        // A repository with no commit has nothing to bundle; the manifest says so.
        const made = await gitAsync(["bundle", "create", join(partial, bundle), "--all"], repo.path).then(
          () => true,
          () => false,
        );
        if (made) chmodSync(join(partial, bundle), 0o600);
        bundles.push({ url: repo.url, path: repo.path, bundle: made ? bundle : null });
      }
    },
  );
  const manifest = {
    takenAt: now.toISOString(),
    reason,
    schema: SCHEMA_VERSION,
    database: database === "sqlite" ? "orchestrator.db" : "postgres: not in this copy; back it up with pg_dump",
    repositories: bundles,
  };
  writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  const path = join(settings.dir, name);
  renameSync(partial, path);
  const kept = readdirSync(settings.dir).filter((n) => BACKUP_NAME.test(n)).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - settings.keep))) rmSync(join(settings.dir, old), { recursive: true, force: true });
  return { path, database, repositories: bundles.length };
}

/**
 * Takes a copy every `everyHours`, and one whenever the process gets SIGUSR2 - `docker compose
 * kill -s SIGUSR2 orchestrator` - so an operator takes one now without stopping anything. One copy
 * runs at a time; a second asked for meanwhile is skipped and says so.
 */
/** The newest of the orchestrator's own copies, by the time in its name. */
export function newestBackup(dir: string): Date | null {
  if (!existsSync(dir)) return null;
  const times = readdirSync(dir).flatMap((name) => {
    const m = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
    return m ? [new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`)] : [];
  });
  return times.length ? new Date(Math.max(...times.map((t) => t.getTime()))) : null;
}

/** Starts the schedule and the SIGUSR2 copy; returns how to take a copy now, answering where it was written or null when none was. */
export function startBackups(store: Store, repos: () => Promise<RepoRecord[]>, settings: BackupSettings, say: (line: string) => void, warn: (line: string) => void): () => Promise<string | null> {
  let running = false;
  const take = async (reason: string): Promise<string | null> => {
    if (running) return say(`backup: one is already being written; the ${reason} one is skipped`), null;
    running = true;
    try {
      const done = await takeBackup(store, await repos(), settings, reason);
      say(`backup: ${reason} copy written to ${done.path} (${done.database === "sqlite" ? "the database and " : "no database, pg_dump's; "}${done.repositories} ${done.repositories === 1 ? "repository" : "repositories"})`);
      return done.path;
    } catch (err) {
      warn(`backup: the ${reason} copy was not written: ${(err as Error).message}`);
      return null;
    } finally {
      running = false;
    }
  };
  process.on("SIGUSR2", () => void take("asked"));
  if (settings.everyHours) {
    // A copy is due when the newest is older than the interval, so a person who starts the orchestrator for an hour a day still gets one.
    const everyMs = settings.everyHours * 3_600_000;
    const check = () => {
      const newest = newestBackup(settings.dir);
      if (!newest || Date.now() - newest.getTime() >= everyMs) void take("scheduled");
    };
    setTimeout(check, FIRST_COPY_DELAY_MS).unref();
    setInterval(check, Math.min(everyMs, 3_600_000)).unref();
  }
  return () => take("asked");
}

/**
 * `handbook-orchestrator backup`: asks the orchestrator running on this machine for a copy of its
 * database now and says where it is. It reaches that orchestrator the way a second start does, over
 * loopback with the secret in the data directory, so no process is signalled and no other user or
 * page can ask.
 */
export async function backupCommand(dataDir: string, say: (line: string) => void = console.log, fetcher: typeof fetch = fetch): Promise<number> {
  const running = runningAddress(dataDir);
  if (!running) {
    say(`backup: no orchestrator is running on ${dataDir}; start it, then run this again`);
    return 1;
  }
  const done = await askForBackup(dataDir, running, fetcher);
  if ("refused" in done) {
    say(`backup: ${done.refused}`);
    return 1;
  }
  say(`backup: the copy is in ${done.path}`);
  return 0;
}
