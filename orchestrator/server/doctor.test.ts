import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { agentFindings, backupFindings, doctorCommand, leftoverFindings, newestBackup, permissionFindings, runnerFindings, schemaFindings, sealedFindings, sqliteFindings } from "./doctor.js";
import { createVault, parseSecretKey } from "./vault.js";
import { orgDir, profileFile, saveProfile } from "../runner/profile.js";
import { claudeCodeAdapter, opencodeAdapter } from "./tasks/agents.js";
import { openSqliteStore, readableFrom, SCHEMA_VERSION } from "./store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-doctor-"));
  dirs.push(dir);
  return dir;
};
const quiet = () => undefined;

describe("what doctor says of the database's schema", () => {
  it("given a database at this image's schema, one behind, and one a newer image moved, when it is judged, then only an unreadable newer one is a problem, and cloud mode points at migrate", () => {
    expect(schemaFindings(SCHEMA_VERSION, readableFrom(SCHEMA_VERSION), false)).toEqual([expect.objectContaining({ code: "schema", problem: false })]);
    expect(schemaFindings(SCHEMA_VERSION - 1, 4, true)[0]).toMatchObject({ code: "schema-behind", problem: false, fix: "run node dist/server.js migrate before the orchestrator starts" });
    expect(schemaFindings(SCHEMA_VERSION - 1, 4, false)[0]!.fix).toBe("the next start moves it, after a copy");
    expect(schemaFindings(SCHEMA_VERSION + 1, readableFrom(SCHEMA_VERSION), false)[0]).toMatchObject({ code: "schema-newer-readable", problem: false });
    expect(schemaFindings(SCHEMA_VERSION + 1, SCHEMA_VERSION + 1, false)[0]).toMatchObject({ code: "schema-newer", problem: true });
    expect(schemaFindings(SCHEMA_VERSION + 1, null, false)[0]).toMatchObject({ code: "schema-newer", problem: true });
  });
});

describe("what doctor says of the orchestrator's copies", () => {
  it("given copies named by the time they were taken, when the newest is read, then it is the latest name and other files are left out", () => {
    const dir = scratch();
    for (const name of ["backup-2026-10-30T01-00-00-000Z", "backup-2026-11-01T09-30-00-500Z", "backup-2026-11-02T00-00-00-000Z.partial", "before-schema-12-2026-11-02T00-00-00-000Z.db"]) mkdirSync(join(dir, name));
    expect(newestBackup(dir)?.toISOString()).toBe("2026-11-01T09:30:00.500Z");
    expect(newestBackup(join(dir, "missing"))).toBeNull();
  });

  it("given no schedule, a schedule with no copy, one copy two periods old and a fresh one, when they are judged, then a missing or stale copy under a schedule is a problem", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    const settings = { everyHours: 6, dir: "/data/backups" };
    expect(backupFindings({ everyHours: null, dir: "/data/backups" }, null, false, now)[0]).toMatchObject({ code: "backup-unscheduled", problem: false, say: "no copy is taken on a schedule", fix: expect.stringContaining("ORCHESTRATOR_BACKUP_DIR names another folder") });
    expect(backupFindings({ everyHours: null, dir: "/data/backups" }, new Date("2026-11-02T07:00:00Z"), false, now)[0]).toMatchObject({ code: "backup-unscheduled", problem: false, say: "no copy is taken on a schedule; the newest, asked for, is 5 hours old in /data/backups" });
    expect(backupFindings(settings, null, false, now)[0]).toMatchObject({ code: "backup-none", problem: true });
    expect(backupFindings(settings, new Date("2026-11-01T23:00:00Z"), false, now)[0]).toMatchObject({ code: "backup-stale", problem: true });
    expect(backupFindings(settings, new Date("2026-11-02T07:00:00Z"), true, now)[0]).toMatchObject({ code: "backup", problem: false, say: "the newest copy is 5 hours old, in /data/backups (on Postgres the database is pg_dump's, which these copies do not hold)" });
  });
});

describe("what doctor says of a SQLite database", () => {
  function bloated(): string {
    const file = join(scratch(), "orchestrator.db");
    openSqliteStore(file).close();
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE filler (x BLOB)");
    const insert = db.prepare("INSERT INTO filler (x) VALUES (?)");
    for (let i = 0; i < 400; i++) insert.run(Buffer.alloc(8192));
    db.exec("DELETE FROM filler");
    db.close();
    return file;
  }

  it("given a database with megabytes of free pages, when doctor looks without --fix, then it says how much and changes nothing, and with --fix it gives the space back", () => {
    const file = bloated();
    const before = statSync(file).size;

    const looked = sqliteFindings(file, false, false, quiet);
    const after = statSync(file).size;
    const fixed = sqliteFindings(file, true, false, quiet);

    expect(looked).toContainEqual(expect.objectContaining({ code: "space-reclaimable", problem: false }));
    expect(after).toBe(before);
    expect(fixed).toContainEqual(expect.objectContaining({ code: "space" }));
    expect(statSync(file).size).toBeLessThan(before / 2);
  });

  it("given a file that is not a whole database, when doctor looks, then it is a problem pointing at the copies", () => {
    const file = join(scratch(), "orchestrator.db");
    writeFileSync(file, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, 7)]));
    expect(sqliteFindings(file, false, false, quiet)[0]).toMatchObject({ code: "database-damaged", problem: true, fix: "restore the newest copy from the backup directory" });
  });

  it.each([
    ["a quarter in", 0.25],
    ["half way", 0.5],
    ["three quarters in", 0.75],
  ])("given a whole database with 8 KiB overwritten %s, when doctor looks, then SQLite's own complaint is a finding pointing at the copies and not a crash", (_where, at) => {
    // given
    const file = join(scratch(), "orchestrator.db");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE schema_version (version INTEGER); CREATE TABLE filler (id INTEGER PRIMARY KEY, x TEXT); CREATE INDEX filler_x ON filler(x); BEGIN");
    const insert = db.prepare("INSERT INTO filler (x) VALUES (?)");
    for (let i = 0; i < 3000; i++) insert.run(`row ${i}${" ".repeat(100)}`);
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const fd = openSync(file, "r+");
    writeSync(fd, Buffer.alloc(8192), 0, 8192, Math.floor((statSync(file).size * at) / 4096) * 4096);
    closeSync(fd);

    // when
    const findings = sqliteFindings(file, false, false, quiet);

    // then
    expect(findings).toEqual([expect.objectContaining({ code: "database-damaged", problem: true, fix: "restore the newest copy from the backup directory" })]);
  });

  it("given a damaged database and a backup folder with none, a damaged newest copy over an older whole one, when doctor looks and then fixes, then it says there is nothing to put back, and with the copies puts the older whole one back, keeps the damaged file beside it and finds the restored database whole", () => {
    // given
    const dir = scratch();
    const file = join(dir, "orchestrator.db");
    const backups = join(dir, "backups");
    writeFileSync(file, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, 7)]));
    const said: string[] = [];

    // when
    const none = sqliteFindings(file, true, false, (l) => void said.push(l), backups);
    const copy = (name: string, whole: boolean) => {
      mkdirSync(join(backups, name), { recursive: true });
      const db = join(backups, name, "orchestrator.db");
      if (whole) {
        openSqliteStore(db).close();
      } else writeFileSync(db, Buffer.alloc(4096, 9));
    };
    copy("backup-2026-11-10T08-00-00-000Z", true);
    copy("backup-2026-11-11T08-00-00-000Z", false);
    const offered = sqliteFindings(file, false, false, quiet, backups);
    const fixed = sqliteFindings(file, true, false, (l) => void said.push(l), backups);

    // then
    expect(none[0]).toMatchObject({ code: "database-damaged", problem: true, fix: expect.stringContaining("holds no whole copy") });
    expect(offered[0]).toMatchObject({ code: "database-damaged", fix: expect.stringContaining("doctor --fix") });
    expect(fixed.map((f) => f.code)).toEqual(["database-restored", "schema", "space"]);
    expect(readdirSync(dir).filter((n) => n.startsWith("orchestrator.db.damaged-"))).toHaveLength(1);
    expect(said.join("\n")).toContain(join(backups, "backup-2026-11-10T08-00-00-000Z", "orchestrator.db"));
    expect(fixed.some((f) => f.problem)).toBe(false);
  });

  it("given no database file yet, when doctor looks, then it says the first start makes one and creates nothing", () => {
    const dir = scratch();
    expect(sqliteFindings(join(dir, "orchestrator.db"), true, false, quiet)).toEqual([expect.objectContaining({ code: "database-none", problem: false })]);
  });
});

describe("what doctor says of the sealed values in a database", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const OTHER = Buffer.alloc(32, 9).toString("base64");

  /** A data directory holding a database with one task secret sealed under KEY, and, when asked, the key file beside it. */
  async function sealedIn(keyFile: string | null): Promise<{ dir: string; file: string }> {
    const dir = scratch();
    const file = join(dir, "orchestrator.db");
    const store = openSqliteStore(file);
    await store.putSecret("default", "task.secret.repo.notes.NOTES_TOKEN", createVault(parseSecretKey(KEY)).seal("default", "task.secret.repo.notes.NOTES_TOKEN", "token-value-0123456789"), "owner@example.invalid");
    store.close();
    if (keyFile !== null) writeFileSync(join(dir, "secret.key"), `${keyFile}\n`, { mode: 0o600 });
    return { dir, file };
  }

  it("given a database with a sealed value and the data directory's key it was sealed with, when doctor looks, then it is fine", async () => {
    const { dir, file } = await sealedIn(KEY);
    expect(sealedFindings(file, dir, {})).toEqual([expect.objectContaining({ code: "sealed", problem: false })]);
  });

  it("given a database restored from a copy into a directory with no key, when doctor looks, then it is a problem saying a start would make a key that opens none, with the two ways back", async () => {
    const { dir, file } = await sealedIn(null);
    expect(sealedFindings(file, dir, {})).toEqual([expect.objectContaining({ code: "sealed-no-key", problem: true, say: expect.stringContaining("would make a new one that opens none of them"), fix: expect.stringContaining("secret.key") })]);
  });

  it("given a key that is not the one the value was sealed with, whether kept in the directory or set in the environment, when doctor looks, then the lost values are counted and are a problem", async () => {
    const kept = await sealedIn(OTHER);
    const set = await sealedIn(null);
    expect(sealedFindings(kept.file, kept.dir, {})).toEqual([expect.objectContaining({ code: "sealed-lost", problem: true, say: "the sealed value (a forge token or a task secret) in this database does not open with the key in use" })]);
    expect(sealedFindings(set.file, set.dir, { ORCHESTRATOR_SECRET_KEY: OTHER })).toEqual([expect.objectContaining({ code: "sealed-lost", problem: true })]);
    expect(sealedFindings(set.file, set.dir, { ORCHESTRATOR_SECRET_KEY: KEY })).toEqual([expect.objectContaining({ code: "sealed", problem: false })]);
  });

  it("given a database with nothing sealed or none yet, when doctor looks, then it says nothing of keys", () => {
    const dir = scratch();
    expect(sealedFindings(join(dir, "orchestrator.db"), dir, {})).toEqual([]);
    openSqliteStore(join(dir, "orchestrator.db")).close();
    expect(sealedFindings(join(dir, "orchestrator.db"), dir, {})).toEqual([]);
  });
});

describe("what doctor says of who can read the data", () => {
  it("given a data directory and key only their user reaches, then one that others reach, when doctor looks, then only the open ones are problems, each with its chmod", () => {
    const dir = scratch();
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "secret.key"), "k", { mode: 0o600 });
    expect(permissionFindings(dir)).toEqual([expect.objectContaining({ code: "permissions", problem: false })]);

    chmodSync(dir, 0o755);
    chmodSync(join(dir, "secret.key"), 0o644);

    expect(permissionFindings(dir)).toEqual([
      expect.objectContaining({ code: "data-dir-open", problem: true, fix: `chmod 700 ${JSON.stringify(dir)}` }),
      expect.objectContaining({ code: "key-open", problem: true, fix: `chmod 600 ${JSON.stringify(join(dir, "secret.key"))}` }),
    ]);
  });
});

describe("doctor on a data directory", () => {
  it("given task directories a stopped orchestrator left, when doctor looks, then it counts them and leaves them to the next start", () => {
    const dir = scratch();
    mkdirSync(join(dir, "tasks", "acme", "aaaaaaaaaaaa"), { recursive: true });
    mkdirSync(join(dir, "tasks", "beta", "bbbbbbbbbbbb"), { recursive: true });
    expect(leftoverFindings(dir)).toEqual([expect.objectContaining({ code: "task-dirs", problem: false, say: "2 task directories left by an orchestrator that stopped" })]);
    expect(statSync(join(dir, "tasks", "acme", "aaaaaaaaaaaa")).isDirectory()).toBe(true);
  });

  it("given an orchestrator holding the data directory, when doctor runs, then it refuses and looks at nothing", async () => {
    const dir = scratch();
    const holder = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(join(dir, "orchestrator.lock"))}); db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); console.log("held"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
      const said: string[] = [];

      const code = await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_DATA_DIR: dir }, undefined, async () => []);

      expect(code).toBe(1);
      expect(said).toEqual([`doctor: an orchestrator is running on ${dir}; stop it before doctor looks its data over`]);
    } finally {
      holder.kill();
    }
  });

  it("given a data directory that does not exist yet and an open umask, when doctor runs on a local orchestrator, then it makes the directory private and does not report its own as open", async () => {
    // given
    const dir = join(scratch(), "fresh");
    const said: string[] = [];
    const before = process.umask(0o022);

    // when
    try {
      await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_MODE: "local", ORCHESTRATOR_DATA_DIR: dir }, undefined, async () => []);
    } finally {
      process.umask(before);
    }

    // then
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(said.join("\n")).not.toContain("data-dir-open");
  });

  it("given a stopped orchestrator's data with a schedule and no copy, when doctor runs, then it reports the problem and exits 1", async () => {
    const dir = scratch();
    openSqliteStore(join(dir, "orchestrator.db")).close();
    const said: string[] = [];

    const code = await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_DATA_DIR: dir, ORCHESTRATOR_BACKUP_HOURS: "6" }, undefined, async () => []);

    expect(code).toBe(1);
    expect(said.some((l) => l.startsWith("doctor: PROBLEM backup-none:"))).toBe(true);
    expect(said.some((l) => l.startsWith("doctor: ok      schema:"))).toBe(true);
  });
});

describe("the runner on this machine", () => {
  const connect = (dataDir: string, org: string) => saveProfile(dataDir, { address: "https://orchestrator.example.com/", org, machineId: "m1", token: "t", privateKey: "k" });

  it("given a runner service and no connection, when doctor looks, then it is a problem with the two ways out", () => {
    // given
    const dataDir = scratch();

    // when
    const findings = runnerFindings(dataDir, { runnerService: true, envFile: join(dataDir, "none.env") });

    // then
    expect(findings).toEqual([{ code: "runner-service-unconnected", problem: true, say: "the runner service is installed but this machine is connected to no orchestrator, so it starts and stops again", fix: "handbook-orchestrator runner service uninstall, or connect the machine with runner connect" }]);
  });

  it("given two connections, one whose runner is alive and one whose lock a stopped runner left, when doctor looks, then it says which runs and that the left lock is taken over", () => {
    // given
    const dataDir = scratch();
    connect(dataDir, "acme");
    connect(dataDir, "globex");
    writeFileSync(join(orgDir(dataDir, "acme"), "runner.lock"), "4242");
    writeFileSync(join(orgDir(dataDir, "globex"), "runner.lock"), "4343");

    // when
    const findings = runnerFindings(dataDir, { runnerService: false, envFile: join(dataDir, "none.env") }, (pid) => pid === 4242);

    // then
    expect(findings.map((f) => [f.code, f.problem, f.say])).toEqual([
      ["runner", false, "connected to acme; a runner runs its tasks here (process 4242)"],
      ["runner-stopped", false, "connected to globex; no runner runs its tasks now, and the lock a stopped one left is taken over by the next"],
    ]);
  });

  it("given a connection's key file or service.env others can read, when doctor looks, then each is a problem with the chmod that closes it", () => {
    // given
    const dataDir = scratch();
    connect(dataDir, "acme");
    chmodSync(profileFile(dataDir, "acme"), 0o644);
    const envFile = join(dataDir, "service.env");
    writeFileSync(envFile, "PATH=/usr/bin\n");
    chmodSync(envFile, 0o640);

    // when
    const problems = runnerFindings(dataDir, { runnerService: true, envFile }, () => false).filter((f) => f.problem);

    // then
    expect(problems.map((f) => [f.code, f.fix])).toEqual([
      ["runner-key-open", `chmod 600 ${JSON.stringify(profileFile(dataDir, "acme"))}`],
      ["service-env-open", `chmod 600 ${JSON.stringify(envFile)}`],
    ]);
  });
});

describe("what doctor says of the agents this machine would run", () => {
  it("given Claude Code installed but older than checked and signed out, and OpenCode not installed, when doctor looks, then each is said in the task form's codes with the command that repairs it, and only the sign-in is a problem", () => {
    // given
    const adapters = [claudeCodeAdapter("claude-stand-in"), opencodeAdapter("opencode-stand-in")];

    // when
    const findings = agentFindings([
      { id: "claude-code", installed: true, version: "2.0.3", supported: "update", signIn: "signed-out" },
      { id: "opencode", installed: false, version: null, supported: "update", signIn: "unknown" },
    ], adapters);

    // then
    expect(findings.map((f) => [f.code, f.problem, f.fix ?? null])).toEqual([
      ["version-older", false, "claude update"],
      ["signin-missing", true, "claude auth login"],
      ["program-missing", false, "curl -fsSL https://opencode.ai/install | bash"],
    ]);
  });
});
