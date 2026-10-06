import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A TEST FIXTURE, not product code: real git repositories with a history written to order, so the
 * miner is measured against the bytes git actually prints rather than against a parser's idea of
 * them. Every name in it is invented; nothing here describes a real codebase.
 */

export interface FixtureCommit {
  /** Files to write, path to content. A null content deletes the file. */
  files: Record<string, string | null>;
  subject: string;
  author: string;
  /** Renames to perform before the files are written, old path to new path. */
  renames?: Record<string, string>;
  /** When the commit happened, for a history that has to span months. Defaults to the fixture's clock. */
  date?: string;
}

export interface FixtureRepo {
  path: string;
  commit(change: FixtureCommit): string;
  /** Opens a branch at the current tip, runs `work` on it, and merges it back with a merge commit. */
  branch(name: string, work: () => void, author: string): void;
}

export interface Fixture {
  root: string;
  repo(name: string): FixtureRepo;
  cleanup(): void;
}

/**
 * A clean environment for git. The suite must not depend on the machine running it: a global
 * commit.gpgsign, a hooks path or a default template there would otherwise fail these commits,
 * or make them differ from one machine to the next.
 */
function gitEnv(date: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
}

export function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mine-fixture-"));
  // One clock for every repository, so the history reads in the order the test wrote it.
  let tick = 0;
  const nextDate = () => {
    tick++;
    return new Date(Date.UTC(2025, 0, 1) + tick * 3_600_000).toISOString();
  };

  const repo = (name: string): FixtureRepo => {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    const git = (args: string[], date = nextDate()) =>
      execFileSync("git", ["-C", path, ...args], { encoding: "utf8", env: gitEnv(date), stdio: ["ignore", "pipe", "pipe"] });
    const created = nextDate();
    git(["init", "-q", "-b", "master"], created);
    // Automatic maintenance off: a commit can start a background gc that is still writing under
    // .git/objects while cleanup deletes the tree, and the delete then fails with ENOTEMPTY. Set
    // at the init's own time, so the clock every commit date is read from does not move.
    git(["config", "gc.auto", "0"], created);
    git(["config", "maintenance.auto", "false"], created);

    const commit = (change: FixtureCommit): string => {
      for (const [from, to] of Object.entries(change.renames ?? {})) {
        mkdirSync(dirname(join(path, to)), { recursive: true });
        git(["mv", from, to]);
      }
      for (const [file, content] of Object.entries(change.files)) {
        const target = join(path, file);
        if (content === null) {
          rmSync(target, { force: true });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git(["add", "-A"]);
      const email = `${change.author.toLowerCase()}@acme.example`;
      git(
        ["-c", `user.name=${change.author}`, "-c", `user.email=${email}`, "commit", "-q", "--allow-empty", "-m", change.subject],
        change.date ?? nextDate(),
      );
      return git(["rev-parse", "HEAD"]).trim();
    };

    const branch = (branchName: string, work: () => void, author: string) => {
      git(["checkout", "-q", "-b", branchName]);
      work();
      git(["checkout", "-q", "master"]);
      const email = `${author.toLowerCase()}@acme.example`;
      git([
        "-c",
        `user.name=${author}`,
        "-c",
        `user.email=${email}`,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        `Merge branch '${branchName}' into 'master'`,
        branchName,
      ]);
    };

    return { path, commit, branch };
  };

  return {
    root,
    repo,
    // Retried briefly for the same race, in case a git process these settings do not reach is
    // still finishing when the tree goes.
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  };
}

/**
 * The workflow the fixture hides: adding a field to a record type, which in this invented product
 * takes the same five roles in two repositories every time, and names a different type in every
 * ticket. Grouping by path finds nothing here; grouping by role has to find it.
 */
export const HIDDEN_WORKFLOW_ROLES = [
  "acme-api:dto/*Request.kt",
  "acme-api:service/*Service.kt",
  "acme-api:db/*migration.sql",
  "acme-app:api/*Types.ts",
  "acme-app:forms/*Form.tsx",
];

const ENTITIES = ["Invoice", "Order", "Customer", "Product", "Supplier", "Shipment"];
const AUTHORS = ["Ada", "Grace", "Linus"];

/**
 * Builds the standard two-repository history: the hidden workflow six times over, and enough
 * noise of every excluded kind that a filter which stopped working would change the result.
 */
export function seedStandardHistory(fixture: Fixture): { api: FixtureRepo; app: FixtureRepo } {
  const api = fixture.repo("acme-api");
  const app = fixture.repo("acme-app");

  api.commit({ files: { "README.md": "# acme-api\n", "build.gradle.kts": "v1\n" }, subject: "initial", author: "Ada" });
  app.commit({ files: { "README.md": "# acme-app\n", "package.json": "{}\n", "package-lock.json": "{}\n" }, subject: "initial", author: "Ada" });

  ENTITIES.forEach((entity, i) => {
    const ticket = `TEAM-${11 + i}`;
    const author = AUTHORS[i % AUTHORS.length]!;
    const field = `dueDate${i}`;
    api.commit({
      files: {
        [`src/dto/Create${entity}Request.kt`]: `class Create${entity}Request(val ${field}: String)\n`,
        [`src/service/${entity}Service.kt`]: `class ${entity}Service { fun ${field}() {} }\n`,
        ["db/migration.sql"]: `-- ${ticket}\n`.repeat(i + 1),
      },
      subject: `${ticket} add ${field} to ${entity}`,
      author,
    });
    app.commit({
      files: {
        [`src/api/${entity.toLowerCase()}Types.ts`]: `export type ${entity} = { ${field}: string }\n`,
        [`src/forms/${entity}Form.tsx`]: `export const ${entity}Form = () => "${field}"\n`,
      },
      subject: `${ticket} show ${field} on the ${entity} form`,
      author,
    });
  });

  // Dependency bumps, by two people so that the ranking's "more than one author" test cannot be
  // what keeps them down: with the filters off they must win on support alone.
  for (let i = 0; i < 8; i++) {
    app.commit({
      files: {
        "package.json": `{"v": ${i}}\n`,
        "package-lock.json": `{"lock": ${i}}\n`,
        "packages/ui/package.json": `{"ui": ${i}}\n`,
      },
      subject: `chore: bump dependencies ${i}`,
      author: i % 2 ? "Renovate" : "Ada",
    });
  }

  api.commit({ files: { "docs/guide.md": "guide\n" }, subject: "document the api", author: "Grace" });
  api.commit({ files: { ".gitlab-ci.yml": "stages: [test]\n" }, subject: "pipeline", author: "Grace" });

  // A reformat under an ordinary subject: only the shape of the diff gives it away.
  const reformat: Record<string, string> = {};
  for (let i = 0; i < 6; i++) reformat[`src/util/Helper${i}Util.kt`] = `object Helper${i}\n`;
  api.commit({ files: reformat, subject: "seed helpers", author: "Linus" });
  const touched: Record<string, string> = {};
  for (let i = 0; i < 6; i++) touched[`src/util/Helper${i}Util.kt`] = `object Helper${i} \n`;
  api.commit({ files: touched, subject: "tidy helpers", author: "Linus" });

  // A rename sweep: twenty files moved, which is not a workflow however often it happens.
  const moved: Record<string, string> = {};
  for (let i = 0; i < 20; i++) moved[`legacy/Old${i}Thing.kt`] = `class Old${i}\n`;
  api.commit({ files: moved, subject: "add legacy things", author: "Linus" });
  const renames: Record<string, string> = {};
  for (let i = 0; i < 20; i++) renames[`legacy/Old${i}Thing.kt`] = `core/Old${i}Thing.kt`;
  api.commit({ files: {}, renames, subject: "move legacy into core", author: "Linus" });

  // "UTF-8" in both repositories. It looks like a ticket key and is not one; were it treated as
  // one, these two unrelated commits would become a single cross-repository unit.
  api.commit({ files: { "src/util/Encoding.kt": "utf8\n" }, subject: "fix UTF-8 handling", author: "Ada" });
  app.commit({ files: { "src/util/encoding.ts": "utf8\n" }, subject: "fix UTF-8 handling", author: "Ada" });

  // An issue number in both repositories: #12 is a different issue in each.
  api.commit({ files: { "src/util/Retry.kt": "retry\n" }, subject: "retry on timeout #12", author: "Grace" });
  app.commit({ files: { "src/util/retry.ts": "retry\n" }, subject: "retry on timeout #12", author: "Grace" });

  // A branch whose own commits carry no key; the merge subject is the only place it is recorded.
  api.branch(
    "TEAM-40",
    () => {
      api.commit({ files: { "src/report/SalesReport.kt": "a\n" }, subject: "start sales report", author: "Grace" });
      api.commit({ files: { "src/report/SalesReportQuery.kt": "b\n" }, subject: "finish sales report", author: "Grace" });
    },
    "Grace",
  );

  api.commit({
    files: { "src/util/Encoding.kt": "utf8 again\n" },
    subject: "Revert \"fix UTF-8 handling\"",
    author: "Ada",
  });

  return { api, app };
}
