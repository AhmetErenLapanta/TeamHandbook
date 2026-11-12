import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupFindings, doctorCommand, leftoverFindings, newestBackup, permissionFindings, runnerFindings, schemaFindings, sqliteFindings } from "./doctor.js";
import { orgDir, profileFile, saveProfile } from "../runner/profile.js";
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
    expect(backupFindings({ everyHours: null, dir: "/data/backups" }, null, false, now)[0]).toMatchObject({ code: "backup-unscheduled", problem: false });
    expect(backupFindings(settings, null, false, now)[0]).toMatchObject({ code: "backup-none", problem: true });
    expect(backupFindings(settings, new Date("2026-11-01T23:00:00Z"), false, now)[0]).toMatchObject({ code: "backup-stale", problem: true });
    expect(backupFindings(settings, new Date("2026-11-02T07:00:00Z"), true, now)[0]).toMatchObject({ code: "backup", problem: false, say: "the newest copy is 5 hours old (on Postgres the database is pg_dump's, which these copies do not hold)" });
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

  it("given no database file yet, when doctor looks, then it says the first start makes one and creates nothing", () => {
    const dir = scratch();
    expect(sqliteFindings(join(dir, "orchestrator.db"), true, false, quiet)).toEqual([expect.objectContaining({ code: "database-none", problem: false })]);
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

      const code = await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_DATA_DIR: dir });

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
      await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_MODE: "local", ORCHESTRATOR_DATA_DIR: dir });
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

    const code = await doctorCommand([], (l) => void said.push(l), { ORCHESTRATOR_DATA_DIR: dir, ORCHESTRATOR_BACKUP_HOURS: "6" });

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

