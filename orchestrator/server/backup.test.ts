import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupSettings, BackupSettingRefused, takeBackup } from "./backup.js";
import { oneAtATime } from "./git.js";
import { newId } from "./ids.js";
import { openSqliteStore, SCHEMA_VERSION } from "./store.js";
import type { Store } from "./store.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-backup-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const IDENTITY = { GIT_AUTHOR_NAME: "Lab", GIT_AUTHOR_EMAIL: "lab@example.invalid", GIT_COMMITTER_NAME: "Lab", GIT_COMMITTER_EMAIL: "lab@example.invalid" };
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();

/** A team repository reached by path, with a request's branch and the description the local forge keeps as a note. */
function teamRepository(root: string): string {
  const bare = join(root, "team-skills.git");
  git(["init", "--quiet", "--bare", "--initial-branch=main", bare], root);
  const work = join(root, "work");
  git(["clone", "--quiet", bare, work], root);
  writeFileSync(join(work, "README.md"), "Team skills.\n");
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", "first"], work);
  git(["checkout", "--quiet", "-b", "handbook/orchestrator-add-a-skill"], work);
  writeFileSync(join(work, "skill.md"), "A skill.\n");
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", "add a skill"], work);
  git(["notes", "--ref", "orchestrator/handbook/orchestrator-add-a-skill", "add", "-m", "The request's description.", "HEAD"], work);
  git(["push", "--quiet", "origin", "main", "handbook/orchestrator-add-a-skill", "refs/notes/orchestrator/handbook/orchestrator-add-a-skill"], work);
  return bare;
}

async function orchestratorWith(root: string, bare: string): Promise<Store> {
  const store = openSqliteStore(join(root, "data", "orchestrator.db"));
  cleanups.push(() => store.close());
  await store.insertUser({ tenant: "acme", id: newId("usr"), email: "owner@acme.example.invalid", name: "Owner", role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() });
  await store.upsertRepo({ tenant: "acme", id: "team-skills", team: "Core", name: "team-skills", url: `file://${bare}` });
  return store;
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the backup settings", () => {
  it("given none set, when they are read, then nothing is scheduled and seven copies are kept under the data directory", () => {
    // given
    const env = {};

    // when
    const settings = backupSettings(env, "/srv/orchestrator-data");

    // then
    expect(settings).toEqual({ everyHours: null, keep: 7, dir: "/srv/orchestrator-data/backups" });
  });

  it("given an interval of zero, one written with a unit, or no copies kept, when they are read, then each is refused by name", () => {
    // given
    const cases = [{ ORCHESTRATOR_BACKUP_HOURS: "0" }, { ORCHESTRATOR_BACKUP_HOURS: "24h" }, { ORCHESTRATOR_BACKUP_KEEP: "0" }];

    // when
    const refused = cases.map((env) => {
      try {
        backupSettings(env, "/srv/orchestrator-data");
        return null;
      } catch (err) {
        return err as Error;
      }
    });

    // then
    expect(refused.map((e) => [e instanceof BackupSettingRefused, e?.message])).toEqual([
      [true, "ORCHESTRATOR_BACKUP_HOURS is a whole number from 1 to 8760"],
      [true, "ORCHESTRATOR_BACKUP_HOURS is a whole number from 1 to 8760"],
      [true, "ORCHESTRATOR_BACKUP_KEEP is a whole number from 1 to 1000"],
    ]);
  });
});

describe("a copy of a running orchestrator", () => {
  it("given an orchestrator on SQLite with a team repository by path, when a copy is taken, then its database and the repository's branches and notes restore, and only its owner reads them", async () => {
    // given
    const root = scratch();
    const bare = teamRepository(root);
    const store = await orchestratorWith(root, bare);
    const dir = join(root, "backups");

    // when
    const backup = await takeBackup(store, await store.listRepos("acme"), { dir, keep: 7 }, "asked");

    // then the database opens with the same people and repository
    expect(backup).toMatchObject({ database: "sqlite", repositories: 1 });
    const copy = new DatabaseSync(join(backup.path, "orchestrator.db"), { readOnly: true });
    expect(copy.prepare("SELECT email FROM users").all()).toEqual([{ email: "owner@acme.example.invalid" }]);
    copy.close();

    // and the bundle restores the branch and its description
    const manifest = JSON.parse(readFileSync(join(backup.path, "manifest.json"), "utf8")) as { reason: string; schema: number; repositories: { path: string; bundle: string }[] };
    expect([manifest.reason, manifest.schema, manifest.repositories[0]!.path]).toEqual(["asked", SCHEMA_VERSION, bare]);
    const restored = join(root, "restored.git");
    git(["clone", "--quiet", "--mirror", join(backup.path, manifest.repositories[0]!.bundle), restored], root);
    expect(git(["rev-parse", "refs/heads/handbook/orchestrator-add-a-skill"], restored)).toBe(git(["rev-parse", "refs/heads/handbook/orchestrator-add-a-skill"], bare));
    expect(git(["notes", "--ref", "orchestrator/handbook/orchestrator-add-a-skill", "show", "refs/heads/handbook/orchestrator-add-a-skill"], restored)).toBe("The request's description.");

    // and the files are the owner's alone
    expect([mode(dir), mode(join(backup.path, "orchestrator.db")), mode(join(backup.path, "manifest.json"))]).toEqual([0o700, 0o600, 0o600]);
  });

  it("given rows in every table the identity, task stage and spend migrations added, when a copy is taken and opened as an orchestrator's database elsewhere, then each row reads back the same", async () => {
    // given
    const root = scratch();
    const store = await orchestratorWith(root, teamRepository(root));
    const at = "2026-11-02T10:00:00.000Z";
    await store.insertIdentity({ id: "idn_a", email: "ada@example.invalid", name: "Ada", emailVerifiedAt: at, termsUrl: "https://terms.example.invalid", termsAcceptedAt: at, createdAt: at }, { provider: "google", subject: "g-1", identityId: "idn_a", email: "ada@example.invalid", addedAt: at });
    await store.addLogin({ provider: "github", subject: "h-1", identityId: "idn_a", email: "ada@example.invalid", addedAt: at });
    await store.saveIdentitySession({ tokenHash: "h1", identityId: "idn_a", csrf: "c1", method: "google", domain: "example.invalid", authenticatedAt: at, expiresAt: "2026-11-02T22:00:00.000Z" });
    await store.savePendingSignIn({ state: "s1", provider: "github", purpose: "link", nonce: "n", verifier: "v", identityId: "idn_a", inviteId: null, expiresAt: "2026-11-02T10:10:00.000Z" });
    await store.insertOrg({ tenant: "acme", name: "Acme", createdBy: "idn_a", createdAt: at, quotas: { members: 5, tasksPerMonth: 100, concurrentTasks: 2 }, deletedAt: null });
    await store.insertOrg({ tenant: "gone", name: "Gone", createdBy: "idn_a", createdAt: at, quotas: { members: null, tasksPerMonth: null, concurrentTasks: null }, deletedAt: at });
    const member = { tenant: "acme", id: newId("usr"), email: "ada@example.invalid", name: "Ada", role: "member" as const, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: at, identityId: "idn_a" };
    await store.insertUser(member);
    await store.deleteSessions("acme", member.id);
    const revokedAt = (await store.getUser("acme", member.id))!.sessionsRevokedAt;
    await store.createTask({ tenant: "acme", id: "tsk_a", repoId: "team-skills", team: "Core", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "running", createdBy: "ada@example.invalid", createdAt: at, startedAt: at, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null, stage: "tests", skills: ["release-checklist"], targetMode: "pinned" });
    await store.setTaskTargets("acme", "tsk_a", [{ repoId: "team-skills", status: "tests", reason: "named", baseSha: null, branch: "b", tests: null, requestNumber: null, error: null, cost: { usd: 1, inputTokens: 2, outputTokens: 3 } }]);
    await store.recordExtraSpend({ tenant: "acme", id: "spend_a", createdBy: "ada@example.invalid", repoId: "team-skills", team: "Core", at, kind: "skill-suggestion", usd: 0.25, inputTokens: 10, outputTokens: 20 });
    await store.saveInvite({ tenant: "acme", id: "inv_a", email: "new@example.invalid", role: "member", teams: ["Core"], tokenHash: "token-a", invitedBy: "owner@acme.example.invalid", createdAt: at, expiresAt: "2026-11-09T10:00:00.000Z" });

    // when
    const backup = await takeBackup(store, [], { dir: join(root, "backups"), keep: 7 }, "asked");
    const elsewhere = join(root, "restored", "orchestrator.db");
    mkdirSync(join(root, "restored"));
    writeFileSync(elsewhere, readFileSync(join(backup.path, "orchestrator.db")));
    const restored = openSqliteStore(elsewhere);
    cleanups.push(() => restored.close());

    // then
    expect(await restored.getIdentityByLogin("github", "h-1")).toMatchObject({ id: "idn_a", termsUrl: "https://terms.example.invalid" });
    expect((await restored.listLogins("idn_a")).map((l) => l.provider).sort()).toEqual(["github", "google"]);
    expect(await restored.getIdentitySession("h1")).toMatchObject({ identityId: "idn_a", domain: "example.invalid" });
    expect(await restored.takePendingSignIn("s1", "2026-11-02T10:05:00.000Z")).toMatchObject({ purpose: "link", identityId: "idn_a" });
    expect((await restored.getOrg("acme"))?.quotas).toEqual({ members: 5, tasksPerMonth: 100, concurrentTasks: 2 });
    expect((await restored.getOrg("gone"))?.deletedAt).toBe(at);
    expect(await restored.getUserByIdentity("acme", "idn_a")).toMatchObject({ id: member.id, sessionsRevokedAt: revokedAt });
    expect(await restored.getTask("acme", "tsk_a")).toMatchObject({ stage: "tests", skills: ["release-checklist"], targetMode: "pinned", targets: [{ repoId: "team-skills", status: "tests", branch: "b", cost: { usd: 1, inputTokens: 2, outputTokens: 3 } }] });
    expect(await restored.extraSpendRows("acme", {})).toEqual([{ repoId: "team-skills", team: "Core", createdBy: "ada@example.invalid", usd: 0.25, tasks: 0, unknownCost: 0, largestUsd: 0.25 }]);
    expect((await restored.listInvitesByEmail("new@example.invalid", at)).map((i) => [i.tenant, i.id, i.teams])).toEqual([["acme", "inv_a", ["Core"]]]);
  });

  it("given a write to the repository under way, when a copy is asked for meanwhile, then the copy waits for it and holds what it wrote", async () => {
    // given
    const root = scratch();
    const bare = teamRepository(root);
    const store = await orchestratorWith(root, bare);
    let release!: () => void;
    const writing = oneAtATime(bare, async () => {
      await new Promise<void>((resolve) => (release = resolve));
      git(["branch", "handbook/orchestrator-written-meanwhile", "main"], bare);
    });

    // when
    const copying = takeBackup(store, await store.listRepos("acme"), { dir: join(root, "backups"), keep: 7 }, "asked");
    await new Promise((r) => setTimeout(r, 50));
    release();
    await writing;
    const backup = await copying;

    // then
    const restored = join(root, "restored.git");
    git(["clone", "--quiet", "--mirror", join(backup.path, "repos", "1.bundle"), restored], root);
    expect(git(["branch", "--list", "handbook/orchestrator-written-meanwhile"], restored)).toContain("handbook/orchestrator-written-meanwhile");
  });

  it("given a backup folder that already exists open to everyone, when a copy is taken, then the folder is closed to all but the orchestrator's own user", async () => {
    // given
    const root = scratch();
    const store = await orchestratorWith(root, teamRepository(root));
    const dir = join(root, "backups");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);

    // when
    await takeBackup(store, await store.listRepos("acme"), { dir, keep: 7 }, "asked");

    // then
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("given more copies than are kept and one cut off half-way, when another is taken, then the oldest and the cut-off one are gone", async () => {
    // given
    const root = scratch();
    const store = await orchestratorWith(root, teamRepository(root));
    const dir = join(root, "backups");
    const repos = await store.listRepos("acme");
    for (const at of ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]) await takeBackup(store, repos, { dir, keep: 2 }, "scheduled", new Date(at));
    const cutOff = join(dir, "backup-2026-01-03T12-00-00-000Z.partial");
    execFileSync("mkdir", ["-p", cutOff]);

    // when
    await takeBackup(store, repos, { dir, keep: 2 }, "scheduled", new Date("2026-01-04T00:00:00.000Z"));

    // then
    expect(readdirSync(dir).sort()).toEqual(["backup-2026-01-03T00-00-00-000Z", "backup-2026-01-04T00-00-00-000Z"]);
  });

  it("given a store with no SQLite snapshot, as on Postgres, when a copy is taken, then it holds the repositories and its manifest sends the database to pg_dump", async () => {
    // given
    const root = scratch();
    const sqlite = await orchestratorWith(root, teamRepository(root));
    const postgresLike: Store = { ...sqlite, snapshotTo: undefined };

    // when
    const backup = await takeBackup(postgresLike, await sqlite.listRepos("acme"), { dir: join(root, "backups"), keep: 7 }, "scheduled");

    // then
    expect(backup).toMatchObject({ database: "postgres", repositories: 1 });
    expect(existsSync(join(backup.path, "orchestrator.db"))).toBe(false);
    expect(JSON.parse(readFileSync(join(backup.path, "manifest.json"), "utf8")).database).toBe("postgres: not in this copy; back it up with pg_dump");
  });
});

describe("the copy before an upgrade", () => {
  /** A database an earlier orchestrator left: its shape, marked one step behind this orchestrator's. */
  async function olderDatabase(root: string): Promise<string> {
    const file = join(root, "data", "orchestrator.db");
    const store = openSqliteStore(file);
    await store.insertUser({ tenant: "acme", id: newId("usr"), email: "owner@acme.example.invalid", name: "Owner", role: "owner", passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() });
    await store.close();
    const db = new DatabaseSync(file);
    db.exec(`DELETE FROM schema_version; INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION - 1});`);
    db.close();
    return file;
  }

  it("given a database an earlier orchestrator wrote, when this orchestrator opens it, then a copy at the earlier schema is written first and the start says where", async () => {
    // given
    const root = scratch();
    const file = await olderDatabase(root);
    const said: string[] = [];

    // when
    const store = openSqliteStore(file, { backupDir: join(root, "backups"), say: (line) => said.push(line) });
    cleanups.push(() => store.close());

    // then
    const [copy] = readdirSync(join(root, "backups"));
    expect(copy).toMatch(new RegExp(`^before-schema-${SCHEMA_VERSION}-.+\\.db$`));
    const old = new DatabaseSync(join(root, "backups", copy!), { readOnly: true });
    expect((old.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(SCHEMA_VERSION - 1);
    expect(old.prepare("SELECT email FROM users").all()).toEqual([{ email: "owner@acme.example.invalid" }]);
    old.close();
    expect(said).toEqual([`start: copied the database at schema ${SCHEMA_VERSION - 1} to ${join(root, "backups", copy!)} before moving it to schema ${SCHEMA_VERSION}`]);
  });

  it("given a database from before versions were recorded, and a new one, when this orchestrator opens each, then the first is copied and the new one is not", async () => {
    // given
    const root = scratch();
    const file = await olderDatabase(root);
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM schema_version;");
    db.close();
    const fresh = join(root, "fresh", "orchestrator.db");

    // when
    const unversioned = openSqliteStore(file, { backupDir: join(root, "backups") });
    const created = openSqliteStore(fresh, { backupDir: join(root, "fresh-backups") });
    cleanups.push(() => unversioned.close(), () => created.close());

    // then
    expect(readdirSync(join(root, "backups"))).toEqual([expect.stringMatching(new RegExp(`^before-schema-${SCHEMA_VERSION}-`))]);
    expect(existsSync(join(root, "fresh-backups"))).toBe(false);
  });

  it("given a copy that cannot be written, when this orchestrator opens an earlier database, then it stops with the reason and the database keeps its earlier schema", () => {
    // given
    const root = scratch();
    return olderDatabase(root).then((file) => {
      const blocked = join(root, "not-a-directory");
      writeFileSync(blocked, "a file where the backups would go\n");

      // when
      const opening = () => openSqliteStore(file, { backupDir: blocked });

      // then
      expect(opening).toThrow(`the copy taken before moving this database from schema ${SCHEMA_VERSION - 1} to ${SCHEMA_VERSION} was not written`);
      const db = new DatabaseSync(file, { readOnly: true });
      expect((db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v).toBe(SCHEMA_VERSION - 1);
      db.close();
    });
  });
});
