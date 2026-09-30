import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRoleResolver,
  classifyCommit,
  clusterUnits,
  learnTicketPrefixes,
  mineShapes,
  repoFamilies,
  repoLabels,
  shapesFromUnits,
  stemSuffix,
  unitKeyOf,
  type MineResult,
  type Shape,
  type UnitCollection,
  type WorkUnit,
} from "./mine.js";
import type { CommitFile, RawCommit } from "./git-log.js";
import { createFixture, HIDDEN_WORKFLOW_ROLES, seedStandardHistory, type Fixture } from "./mine-fixture.js";

/** The repository root, so a test can run the bundle that ships rather than the source it is built from. */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const modified = (path: string, added = 5, removed = 1): CommitFile => ({ status: "M", path, added, removed });
// The fixture repeats its workflow six times, below the default floor a real history is mined at.
const SMALL = { minRecurrence: 5 };
const commitOf = (subject: string, files: CommitFile[], parents = ["p"]): RawCommit => ({
  sha: "abc",
  parents,
  authorEmail: "dev@acme.example",
  date: "2025-01-01T00:00:00Z",
  subject,
  files,
});

describe("mineShapes on a two-repository history with one hidden workflow", () => {
  let fixture: Fixture;
  let repos: string[];
  let result: MineResult;

  beforeAll(() => {
    fixture = createFixture();
    const { api, app } = seedStandardHistory(fixture);
    repos = [api.path, app.path];
    result = mineShapes(repos, SMALL);
  });
  afterAll(() => fixture.cleanup());

  it("finds the workflow first, joined across both repositories by its ticket keys", () => {
    // given the standard history (seeded above)
    // when it is mined with the defaults
    const [top] = result.shapes;

    // then the top shape is the hidden workflow, with every role and every ticket
    expect(top!.coreFiles.map((f) => f.role).sort()).toEqual([...HIDDEN_WORKFLOW_ROLES].sort());
    expect(top!.repos).toEqual(["acme-api", "acme-app"]);
    expect(top!.recurrence).toBe(6);
    expect(top!.authors).toBe(3);
    expect(top!.memberUnits).toEqual(["TEAM-11", "TEAM-12", "TEAM-13", "TEAM-14", "TEAM-15", "TEAM-16"]);
  });

  it("says for each core file how many units touched it and shows a concrete path", () => {
    // given the top shape
    const [top] = result.shapes;

    // when its file map is read
    const service = top!.coreFiles.find((f) => f.role === "acme-api:service/*Service.kt");

    // then the count is k of N and the examples are real paths, labelled by repository
    expect(service).toMatchObject({ units: 6, share: 1 });
    expect(service!.examples[0]).toMatch(/^acme-api\/src\/service\/[A-Z]\w+Service\.kt$/);
  });

  it("counts every excluded commit under the reason that excluded it", () => {
    // given the noise the fixture seeds: eight bumps, a doc, a pipeline, a reformat, a rename
    // sweep, a merge and a revert
    // when the exclusions are read
    const excluded = result.stats.excludedCommits;

    // then each one is counted by name
    expect(excluded).toMatchObject({
      "version-bump": 8,
      "docs-only": 1,
      "ci-only": 1,
      format: 1,
      "mass-rename": 1,
      merge: 1,
      revert: 1,
    });
    expect(result.shapes.some((s) => s.coreFiles.some((f) => /package\.json/.test(f.role)))).toBe(false);
  });

  it("lets the noise into the list once the filters are off, which is what they are worth", () => {
    // given the same history
    // when it is mined with the filters off
    const unfiltered = mineShapes(repos, { ...SMALL, filters: false });

    // then the dependency bump is a shape of its own, more repeated than the workflow it buries
    const bump = unfiltered.shapes.find((s) => s.coreFiles.some((f) => /package\.json/.test(f.role)));
    expect(bump!.coreFiles.map((f) => f.role)).toEqual(
      expect.arrayContaining(["acme-app:./*package.json", "acme-app:./*lock.json"]),
    );
    expect(bump!.recurrence).toBeGreaterThan(6);
    expect(unfiltered.shapes.some((s) => s.memberUnits.join() === "TEAM-11,TEAM-12,TEAM-13,TEAM-14,TEAM-15,TEAM-16")).toBe(
      true,
    );
  });

  it("learns TEAM as this history's ticket key and does not mistake UTF-8 for one", () => {
    // given subjects that mention both
    // when the learned prefixes are read
    // then only the real one is there
    expect(result.stats.ticketPrefixes).toEqual(["TEAM"]);
  });

  it("joins a branch's unkeyed commits into the unit its merge names", () => {
    // given a TEAM-40 branch whose two commits carry no key
    // when the history is mined with every threshold lowered so a one-ticket shape can surface
    const loose = mineShapes(repos, { minRecurrence: 1, minProposers: 1, rareRoleUnits: 1, minRoles: 2 });

    // then TEAM-40 is one unit holding both of its files
    const report = loose.shapes.find((s) => s.memberUnits.includes("TEAM-40"));
    expect(report!.coreFiles.map((f) => f.role).sort()).toEqual(["acme-api:report/*Query.kt", "acme-api:report/*Report.kt"]);
  });

  it("never writes an author's email into the result", () => {
    // given authors whose addresses all end in the fixture's domain
    // when the whole result is serialised
    const serialised = JSON.stringify(result);

    // then no address survives, and only the count does
    expect(serialised).not.toContain("acme.example");
    expect(result.stats.authors).toBeGreaterThanOrEqual(4);
  });

  it("returns the same shapes on a second run", () => {
    // given the same history
    // when it is mined again, with a different per-run salt
    const again = mineShapes(repos, SMALL);

    // then nothing about the shapes depends on the salt or on the order of reading
    const summary = (r: MineResult) => r.shapes.map((s) => [s.id, s.memberUnits.join()]);
    expect(summary(again)).toEqual(summary(result));
  });
});

describe("mineShapes and a path that is not a readable repository", () => {
  it("reads the rest, and names each path it could not read with the reason", () => {
    // given the standard history, a repository with no commits yet, and a plain directory
    const fixture = createFixture();
    try {
      const { api, app } = seedStandardHistory(fixture);
      const empty = fixture.repo("acme-empty").path;
      const plain = join(fixture.root, "acme-notes");
      mkdirSync(plain);

      // when all four are mined together
      const result = mineShapes([api.path, empty, app.path, plain], SMALL);

      // then the two real repositories are mined as if alone, and the other two are recorded
      expect(result.shapes[0]!.memberUnits).toEqual(["TEAM-11", "TEAM-12", "TEAM-13", "TEAM-14", "TEAM-15", "TEAM-16"]);
      expect(result.stats.repos).toBe(2);
      expect(result.stats.unreadableRepos).toEqual([
        { path: empty, reason: expect.stringMatching(/^no commits on any of /) },
        { path: plain, reason: "not a git repository" },
      ]);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("mineShapes and a ticket that never closes", () => {
  it("sets an epic spanning half a year aside as an umbrella and counts it", () => {
    // given the standard history plus one key that collected commits over two hundred days
    const fixture = createFixture();
    try {
      const { api, app } = seedStandardHistory(fixture);
      for (let i = 0; i < 5; i++) {
        api.commit({
          files: { [`src/cleanup/Step${i}Cleanup.kt`]: `${i}\n` },
          subject: `TEAM-70 cleanup step ${i}`,
          author: "Ada",
          date: new Date(Date.UTC(2025, 1, 1) + i * 50 * 86_400_000).toISOString(),
        });
      }

      // when it is mined
      const result = mineShapes([api.path, app.path], SMALL);

      // then the epic is counted under its own reason and supports nothing
      expect(result.stats.excludedUnits.umbrella).toBe(1);
      expect(result.shapes.some((s) => s.memberUnits.includes("TEAM-70"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("mineShapes and commit subjects that hold a secret or an address", () => {
  it("withholds the subject, counts it, and keeps the shape", () => {
    // given the workflow, one of whose tickets pasted a token into its subject and another of
    // which credits a contributor by address
    const fixture = createFixture();
    try {
      const api = fixture.repo("acme-api");
      const app = fixture.repo("acme-app");
      const token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a";
      ["Invoice", "Order", "Customer", "Product", "Supplier"].forEach((entity, i) => {
        const subject =
          i === 0
            ? `TEAM-${i + 1} add a field, deploy with ${token}`
            : i === 1
              ? `TEAM-${i + 1} add a field. Thanks to Sam <sam@contributor.example>`
              : `TEAM-${i + 1} add a field to ${entity}`;
        api.commit({
          files: {
            [`src/dto/Create${entity}Request.kt`]: `${i}\n`,
            [`src/service/${entity}Service.kt`]: `${i}\n`,
            "db/migration.sql": `${i}\n`,
          },
          subject,
          author: "Ada",
        });
        app.commit({ files: { [`src/api/${entity}Types.ts`]: `${i}\n` }, subject, author: "Grace" });
      });

      // when it is mined
      const result = mineShapes([api.path, app.path], SMALL);

      // then the shape survives without either subject, and each withholding is counted
      const [top] = result.shapes;
      expect(top!.recurrence).toBe(5);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain("contributor.example");
      expect(result.stats.subjectsWithheld.email).toBeGreaterThanOrEqual(1);
      expect(result.stats.subjectsWithheld.secret).toBeGreaterThanOrEqual(1);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("classifyCommit", () => {
  it.each([
    ["a merge, by its parents rather than its empty file list", commitOf("Merge branch 'x'", [], ["a", "b"]), "merge"],
    ["a revert", commitOf('Revert "TEAM-1 add a field"', [modified("src/A.kt")]), "revert"],
    ["a lockfile-only change", commitOf("TEAM-1 relock", [modified("package-lock.json")]), "lockfile"],
    ["a build-files-only change", commitOf("TEAM-1 pin", [modified("package.json"), modified("yarn.lock")]), "version-bump"],
    ["a formatting subject", commitOf("run ktlint", [modified("src/A.kt"), modified("src/B.kt")]), "format"],
    ["a docs-only change", commitOf("TEAM-1 explain", [modified("docs/a.md")]), "docs-only"],
    ["a CI-only change", commitOf("TEAM-1 pipeline", [modified(".gitlab-ci.yml")]), "ci-only"],
    ["a conflict resolution", commitOf("resolve merge conflicts", [modified("src/A.kt")]), "merge-resolution"],
    ["a release that edits a version constant", commitOf("Bumped v5.9.0", [modified("fastify.js"), modified("package.json"), modified("lib/a.js")]), "version-bump"],
    ["a release named by its version alone", commitOf("v5.7.2", [modified("src/version.ts"), modified("package.json")]), "version-bump"],
    ["ordinary work", commitOf("TEAM-1 add a field", [modified("src/A.kt"), modified("src/B.kt")]), "work"],
  ])("files %s", (_label, commit, expected) => {
    // given the commit
    // when it is classified
    // then it lands in the expected class
    expect(classifyCommit(commit)).toBe(expected);
  });

  it("reads a wide edit of a line or two per file as a reformat, even under an ordinary subject", () => {
    // given six files each changed by one line
    const files = Array.from({ length: 6 }, (_, i) => modified(`src/F${i}.kt`, 1, 1));

    // when classified
    // then the diff shape decides it
    expect(classifyCommit(commitOf("TEAM-9 tidy", files))).toBe("format");
  });

  it("does not read scaffolding six small new files as a reformat", () => {
    // given six added files of one line each
    const files = Array.from({ length: 6 }, (_, i): CommitFile => ({ status: "A", path: `src/F${i}.kt`, added: 1, removed: 0 }));

    // when classified
    // then it is work
    expect(classifyCommit(commitOf("TEAM-9 scaffold", files))).toBe("work");
  });

  it("reads twenty files, most of them renamed, as a rename sweep", () => {
    // given twenty renamed files
    const files = Array.from({ length: 20 }, (_, i): CommitFile => ({ status: "R100", path: `core/F${i}.kt`, added: 0, removed: 0 }));

    // when classified
    // then it is excluded as a sweep
    expect(classifyCommit(commitOf("move", files))).toBe("mass-rename");
  });

  it("reads eighty files as a sweep whatever the subject says", () => {
    // given eighty modified files with real edits
    const files = Array.from({ length: 80 }, (_, i) => modified(`src/F${i}.kt`, 20, 4));

    // when classified
    // then it is excluded as a mass change
    expect(classifyCommit(commitOf("TEAM-9 migrate", files))).toBe("mass-change");
  });
});

describe("learnTicketPrefixes and unitKeyOf", () => {
  it("learns a prefix only once it appears with several distinct numbers", () => {
    // given one real key family and several lookalikes
    const subjects = [
      ...Array.from({ length: 5 }, (_, i) => `TEAM-${i + 1} work`),
      ...Array.from({ length: 30 }, () => "fix UTF-8 handling"),
      "CVE-2023 patch",
      "CVE-2024 patch",
      "CVE-2025 patch",
      "CVE-2026 patch",
      "CVE-2027 patch",
      "OPS-1 one-off",
    ];

    // when prefixes are learned
    // then only the real family survives
    expect([...learnTicketPrefixes(subjects)]).toEqual(["TEAM"]);
  });

  it("joins ticket keys across repositories and keeps issue numbers apart", () => {
    // given the same ticket key and the same issue number in two repositories
    const prefixes = new Set(["TEAM"]);
    const keyed = commitOf("TEAM-7 add a field", []);
    const issue = commitOf("fix retry #12", []);

    // when each is keyed in both repositories
    // then the ticket joins and the issue number does not
    expect(unitKeyOf(keyed, "acme-api", prefixes)).toBe(unitKeyOf(keyed, "acme-app", prefixes));
    expect(unitKeyOf(issue, "acme-api", prefixes)).toBe("acme-api#12");
    expect(unitKeyOf(issue, "acme-app", prefixes)).toBe("acme-app#12");
  });

  it("reads the pull request number a squash merge writes in parentheses", () => {
    // given a squash-merged subject
    // when it is keyed
    // then the pull request is the unit
    expect(unitKeyOf(commitOf("feat: add a route option (#6909)", []), "acme-api", new Set())).toBe("acme-api#6909");
  });

  it("does not use a Conventional Commits scope as a unit key", () => {
    // given two unrelated commits in the same scope
    const prefixes = new Set<string>();

    // when each is keyed
    // then neither gets a key, so they do not become one unit
    expect(unitKeyOf(commitOf("fix(core): handle nulls", []), "acme-api", prefixes)).toBeNull();
    expect(unitKeyOf(commitOf("fix(core): speed up startup", []), "acme-api", prefixes)).toBeNull();
  });
});

describe("roles", () => {
  it("names a file by its directory and the last word of its name", () => {
    // given file names in the common conventions
    // when their suffix is taken
    // then it is the word that says what the file is for
    expect(stemSuffix("CreateInvoiceRequest.kt")).toEqual({ suffix: "Request", ext: "kt" });
    expect(stemSuffix("messages_de.properties")).toEqual({ suffix: "de", ext: "properties" });
    expect(stemSuffix("invoice-types.ts")).toEqual({ suffix: "types", ext: "ts" });
  });

  it("gives two entities' files the same role, and drops tests and lockfiles", () => {
    // given paths from two tickets that did the same thing to different entities
    const role = buildRoleResolver([]);

    // when each is resolved
    // then they share a role, and the noise roles are named as such
    expect(role("src/dto/CreateInvoiceRequest.kt")).toBe(role("src/dto/UpdateOrderRequest.kt"));
    expect(role("src/test/kotlin/InvoiceServiceTest.kt")).toBe("test");
    expect(role("package-lock.json")).toBe("lock");
  });

  it("detects a generated mirror directory and a sibling template", () => {
    // given a src tree, its generated copy, and five middleware directories sharing index.ts
    const names = ["cors", "etag", "jwt", "logger", "timing"];
    const paths = [
      ...Array.from({ length: 12 }, (_, i) => `src/lib/f${i}.ts`),
      ...Array.from({ length: 12 }, (_, i) => `deno_dist/lib/f${i}.ts`),
      ...names.map((n) => `src/middleware/${n}/index.ts`),
    ];

    // when a resolver is built from them
    const role = buildRoleResolver(paths);

    // then the copy is a mirror and the middleware layout is one role
    expect(role.mirrors).toEqual(new Set(["deno_dist"]));
    expect(role("deno_dist/lib/f1.ts")).toBe("mirror");
    expect(role("src/middleware/cors/index.ts")).toBe("middleware/*/index.ts");
  });

  it("reads one file kept in several languages as one role", () => {
    // given translation files in the common layouts, and a file whose name merely ends in two letters
    const role = buildRoleResolver([]);

    // when each is resolved
    // then the language is not part of the role, and the lookalike keeps its own
    expect(role("src/main/resources/messages/messages_en.properties")).toBe("messages/messages_{locale}.properties");
    expect(role("src/main/resources/messages/messages_de.properties")).toBe("messages/messages_{locale}.properties");
    expect(role("src/locales/de.json")).toBe(role("src/locales/fr.json"));
    expect(role("src/i18n/strings.en-US.json")).toBe("i18n/strings.{locale}.json");
    expect(role("src/config/app_db.yml")).toBe("config/*db.yml");
  });

  it("folds a package-per-area layout into one role per kind of file", () => {
    // given controllers spread over five area directories, and one directly under controller/
    const areas = ["orders", "billing", "shipping", "catalog", "users"];
    const paths = areas.map((a) => `src/controller/${a}/${a[0]!.toUpperCase()}${a.slice(1)}Controller.kt`);

    // when a resolver is built from them
    const role = buildRoleResolver(paths);

    // then the area is not part of the role, so one workflow is one role wherever it lands
    expect(role("src/controller/orders/OrdersController.kt")).toBe("controller/*Controller.kt");
    expect(role("src/controller/billing/BillingController.kt")).toBe(role("src/controller/HealthController.kt"));
  });

  it("keeps the area when area templates are off", () => {
    // given the same layout
    const paths = ["orders", "billing", "shipping", "catalog", "users"].map((a) => `src/controller/${a}/XController.kt`);

    // when area templates are turned off
    const role = buildRoleResolver(paths, { areaTemplates: false, minSiblings: 99 });

    // then the area directory is the role's directory
    expect(role("src/controller/orders/XController.kt")).toBe("orders/*Controller.kt");
  });
});

describe("shapesFromUnits", () => {
  const resolver = buildRoleResolver([]);
  const unit = (key: string, paths: string[]): WorkUnit => ({
    key,
    files: new Map([["acme-api", new Set(paths)]]),
    created: new Map(),
    authors: new Set([key]),
    subjects: [`${key} work`],
    conventionalTypes: new Set(),
    commits: 1,
    firstAt: "2025-01-01T00:00:00Z",
    lastAt: "2025-01-01T00:00:00Z",
    touchesTest: false,
  });
  const collection = (list: WorkUnit[]): UnitCollection => ({
    units: new Map(list.map((u) => [u.key, u])),
    resolver,
    families: new Map([["acme-api", "acme-api"]]),
    creditFiles: 0,
    repos: 1,
    unreadable: [],
    commits: list.length,
    allUnits: list.length,
    authors: list.length,
    prefixes: new Set(["TEAM"]),
    excludedCommits: {},
    excludedUnits: {},
    readMs: 0,
  });
  const WORKFLOW = ["dto/ARequest.kt", "service/AService.kt", "db/migration.sql"];
  const OTHER = ["report/AQuery.kt", "report/AReport.kt", "views/AView.sql", "table/ATable.kt"];

  it("counts a unit that did the workflow even when clustering put it somewhere else", () => {
    // given six units doing the workflow, three doing something else, and one doing both, which
    // sits closer to the second group and is clustered there
    const units = [
      ...Array.from({ length: 6 }, (_, i) => unit(`TEAM-${i + 1}`, WORKFLOW)),
      ...Array.from({ length: 3 }, (_, i) => unit(`TEAM-${i + 20}`, OTHER)),
      unit("TEAM-99", [...WORKFLOW, ...OTHER]),
    ];

    // when shapes are formed with thresholds small enough that the other group is kept
    const result = shapesFromUnits(collection(units), { minRecurrence: 3, minProposers: 3, rareRoleUnits: 3 });

    // then the workflow's support includes the unit that also did other work
    const workflow = result.shapes.find((s) => s.coreFiles.some((f) => f.role === "acme-api:dto/*Request.kt"))!;
    expect(workflow.memberUnits).toContain("TEAM-99");
    expect(workflow.recurrence).toBe(7);
  });

  it("applies the recurrence floor to the workflow's support, not to the cluster that proposed it", () => {
    // given five units doing only the workflow, and five more doing it alongside other work that
    // pulls them into a different cluster
    const units = [
      ...Array.from({ length: 5 }, (_, i) => unit(`TEAM-${i + 1}`, WORKFLOW)),
      ...Array.from({ length: 5 }, (_, i) => unit(`TEAM-${i + 10}`, [...WORKFLOW, ...OTHER])),
      ...Array.from({ length: 3 }, (_, i) => unit(`TEAM-${i + 20}`, OTHER)),
    ];

    // when shapes are formed with a floor of eight, above the size of either workflow cluster
    const result = shapesFromUnits(collection(units), { minRecurrence: 8 });

    // then the workflow, done ten times in all, is reported
    const workflow = result.shapes.find((s) => s.coreFiles.some((f) => f.role === "acme-api:dto/*Request.kt"))!;
    expect(workflow.recurrence).toBe(10);
  });

  it("only adds shapes as the recurrence floor is lowered", () => {
    // given nine units doing one workflow, each also touching four files that exactly three units
    // share, laid out as the lines of a 3x3 grid so that any two units share exactly one of them
    const units = Array.from({ length: 9 }, (_, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const lines = [`r${row}`, `c${col}`, `d${(row + col) % 3}`, `a${(row + 2 * col) % 3}`];
      return unit(`TEAM-${i + 1}`, [...WORKFLOW, ...lines.map((line) => `${line}/Line${line}Extra.kt`)]);
    });

    // when the floor is lowered from 8 to 3
    const counts = [8, 5, 3].map((n) => shapesFromUnits(collection(units), { minRecurrence: n }).stats.shapesBeforeLimit);

    // then no floor loses the workflow the higher one found
    expect(counts).toEqual([1, 1, 1]);
    // and with the rare-role cut still derived from the floor, as it once was, the lower floor lets
    // the shared extras back in, no two units are alike enough to cluster, and the workflow is gone
    expect(shapesFromUnits(collection(units), { minRecurrence: 5, rareRoleUnits: Math.ceil(0.6 * 5) }).shapes).toEqual([]);
  });

  it("does not let each unit's one-off files keep a repeated workflow from clustering", () => {
    // given six units doing the workflow, each also touching two files nobody else touches
    const units = Array.from({ length: 6 }, (_, i) =>
      unit(`TEAM-${i + 1}`, [...WORKFLOW, `misc${i}/Only${i}Alpha.kt`, `misc${i}/Only${i}Beta.kt`]),
    );

    // when shapes are formed
    const result = shapesFromUnits(collection(units), { minRecurrence: 5 });

    // then the one-off files do not count against similarity, and the workflow is found
    expect(result.shapes).toHaveLength(1);
    expect(result.shapes[0]!.coreFiles.map((f) => f.role).sort()).toEqual(
      ["acme-api:db/*migration.sql", "acme-api:dto/*Request.kt", "acme-api:service/*Service.kt"],
    );
  });

  it("reports whether the core files span repositories, not just the units", () => {
    // given the workflow in one repository
    const units = Array.from({ length: 6 }, (_, i) => unit(`TEAM-${i + 1}`, WORKFLOW));

    // when shapes are formed
    const [shape] = shapesFromUnits(collection(units), { minRecurrence: 5 }).shapes;

    // then its core is in one repository
    expect(shape!.coreRepos).toEqual(["acme-api"]);
  });
});

describe("repository names", () => {
  it("keeps two repositories with one basename apart", () => {
    // given two services that share a basename in different groups
    const paths = ["/code/libs/config-service", "/code/services/config-service", "/code/services/orders-service"];

    // when they are labelled
    const labels = repoLabels(paths);

    // then the shared basename is qualified and the unique one is not
    expect([...labels.values()]).toEqual(["libs/config-service", "services/config-service", "orders-service"]);
  });

  it("folds repositories that share a suffix into a family once there are enough of them", () => {
    // given three services and a lone proxy
    // when families are formed
    const families = repoFamilies(["orders-service", "billing-service", "shipping-service", "edge-proxy"]);

    // then the services share a name and the proxy keeps its own
    expect(families.get("orders-service")).toBe("*-service");
    expect(families.get("billing-service")).toBe("*-service");
    expect(families.get("edge-proxy")).toBe("edge-proxy");
  });
});

describe("clusterUnits", () => {
  it("does not chain two workflows together through a file both of them touch", () => {
    // given two workflows that share only the changelog, and enough of each to form a cluster
    const roleSets = new Map<string, Set<string>>();
    for (let i = 0; i < 6; i++) roleSets.set(`A-${i}`, new Set(["a:*Request.kt", "a:*Service.kt", "a:*changelog.xml"]));
    for (let i = 0; i < 6; i++) roleSets.set(`B-${i}`, new Set(["a:*View.sql", "a:*Table.kt", "a:*changelog.xml"]));
    // and one unit that bridges them, close to each group by one file
    roleSets.set("BRIDGE", new Set(["a:*Request.kt", "a:*changelog.xml", "a:*Table.kt"]));

    // when the units are clustered
    const clusters = clusterUnits(roleSets, { similarity: 0.5 });

    // then the two workflows stay two clusters
    const withA = clusters.find((c) => c.includes("A-0"))!;
    const withB = clusters.find((c) => c.includes("B-0"))!;
    expect(withA).not.toBe(withB);
    expect(withA.filter((k) => k.startsWith("B-"))).toEqual([]);
  });
});

/** Units in the nested-core history; six of them take the wider shape, which is just over 0.4. */
const NESTED_UNITS = 14;

describe("choosing which shapes a reader meets first", () => {
  let fixture: Fixture;
  let repos: string[];
  let nested: string;

  beforeAll(() => {
    fixture = createFixture();
    const api = fixture.repo("acme-api");
    const app = fixture.repo("acme-app");
    const ops = fixture.repo("acme-ops");
    api.commit({ files: { "README.md": "# acme-api\n" }, subject: "initial", author: "Ada" });
    app.commit({ files: { "README.md": "# acme-app\n" }, subject: "initial", author: "Ada" });
    ops.commit({ files: { "README.md": "# acme-ops\n" }, subject: "initial", author: "Ada" });

    // A narrow workflow done often, in one repository.
    for (let i = 0; i < 20; i++) {
      api.commit({
        files: { [`src/service/Item${i}Service.kt`]: `s${i}\n`, [`src/response/Item${i}Response.kt`]: `r${i}\n`, "db/changelog.xml": `<c>${i}</c>\n` },
        subject: `TEAM-${100 + i} widen the ${i} response`,
        author: i % 2 ? "Ada" : "Grace",
      });
    }
    // A wide workflow done rarely, across three repositories.
    for (let i = 0; i < 6; i++) {
      api.commit({
        files: { [`src/controller/Page${i}Controller.kt`]: `c${i}\n`, [`src/service/Page${i}Service.kt`]: `s${i}\n` },
        subject: `TEAM-${200 + i} add the ${i} page`,
        author: i % 2 ? "Ada" : "Linus",
      });
      app.commit({ files: { [`src/pages/Page${i}Page.tsx`]: `p${i}\n` }, subject: `TEAM-${200 + i} add the ${i} page`, author: i % 2 ? "Ada" : "Linus" });
      ops.commit({ files: { [`routes/page${i}.routes.json`]: `{"${i}":1}\n` }, subject: `TEAM-${200 + i} add the ${i} page`, author: i % 2 ? "Ada" : "Linus" });
    }
    // Ordinary maintenance across a dozen unrelated corners, so that the files it touches are
    // neither rare enough to be dropped nor alike enough to fold into one role.
    const CORNERS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa", "Lambda", "Nu"];
    const chores = (mark: string) => {
      const files: Record<string, string> = {};
      // Every line rewritten, so that a commit touching all of them reads as work and not as a reformat.
      for (const corner of CORNERS) {
        files[`src/${corner.toLowerCase()}/Job${corner}.kt`] = Array.from({ length: 8 }, (_, line) => `${corner} ${mark} line ${line}`).join("\n");
      }
      return files;
    };
    for (let i = 0; i < 4; i++) api.commit({ files: chores(`c${i}`), subject: `TEAM-${300 + i} tidy the jobs`, author: "Grace" });

    // A ticket that did the narrow workflow and a third as much again beside it: the shipped unit
    // share has to keep this one, or the rule is cutting ordinary work rather than sweeps.
    api.commit({
      files: {
        "src/service/Item1Service.kt": "one\ntwo\nthree\nfour\nfive\n",
        "src/response/Item1Response.kt": "one\ntwo\nthree\nfour\nfive\n",
        "db/changelog.xml": "<f/>\n<g/>\n<h/>\n<i/>\n<j/>\n",
        ...Object.fromEntries(Object.entries(chores("beside")).slice(0, 7)),
      },
      subject: "TEAM-800 widen the 1 response and tidy what it touched",
      author: "Grace",
    });

    // One ticket that rebuilt half the codebase: it touches both workflows' files among a dozen others.
    api.commit({
      files: {
        "src/service/Item0Service.kt": "one\ntwo\nthree\nfour\nfive\n",
        "src/response/Item0Response.kt": "one\ntwo\nthree\nfour\nfive\n",
        "db/changelog.xml": "<a/>\n<b/>\n<c/>\n<d/>\n<e/>\n",
        ...chores("sweep"),
      },
      subject: "TEAM-900 move everything onto the new runtime",
      author: "Linus",
    });

    repos = [api.path, app.path, ops.path];

    // A second history, for the pair whose cores nest: the wider shape's members are just over
    // four tenths of the narrower one's, which is the side of the shipped overlap they fall on.
    const inner = fixture.repo("acme-nested");
    inner.commit({ files: { "README.md": "# acme-nested\n" }, subject: "initial", author: "Ada" });
    for (let i = 0; i < NESTED_UNITS; i++) {
      const files: Record<string, string> = {
        [`src/service/Item${i}Service.kt`]: `s${i}\n`,
        [`src/response/Item${i}Response.kt`]: `r${i}\n`,
        "db/changelog.xml": `<c>${i}</c>\n`,
      };
      if (i < 6) {
        files[`src/mapper/Item${i}Mapper.kt`] = `m${i}\n`;
        files[`src/client/Item${i}Client.kt`] = `c${i}\n`;
      }
      inner.commit({ files, subject: `TEAM-${400 + i} widen the ${i} response`, author: i % 2 ? "Ada" : "Grace" });
    }
    nested = inner.path;
  });
  afterAll(() => fixture.cleanup());

  const mine = (options = {}) => mineShapes(repos, { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3, ...options });

  it("reports the four parts of a shape's score and the number they make", () => {
    // given the history
    // when it is mined
    const [top] = mine().shapes;

    // then the shape says why it is where it is
    expect(top!.score.support).toBeCloseTo(Math.log2(1 + top!.recurrence), 1);
    expect(top!.score.repos).toBe(top!.coreRepos.length);
    expect(top!.score.authors).toBe(top!.authors);
    expect(top!.score.total).toBeCloseTo(top!.score.support * top!.score.repos, 1);
  });

  it("puts the workflow that crosses repositories above the one done more often in a single repository", () => {
    // given a workflow done 6 times across three repositories and one done 20 times in one
    // when the history is mined
    const shapes = mine().shapes;

    // then the wide one is met first, although the narrow one has more than three times its support
    const wide = shapes.findIndex((s) => s.coreRepos.length === 3);
    const narrow = shapes.findIndex((s) => s.coreRepos.length === 1 && s.recurrence >= 20);
    expect(wide).toBeGreaterThanOrEqual(0);
    expect(narrow).toBeGreaterThan(wide);
  });

  it("does not count a ticket that touched half the codebase as having done a workflow it only brushed", () => {
    // given the sweep ticket, whose dozen other files dwarf the narrow workflow's three
    const narrow = (shapes: Shape[]) => shapes.find((s) => s.coreRepos.length === 1 && s.recurrence >= 20)!;

    // when the history is mined with the unit share on, and again with it off
    const withRule = mine().shapes;
    const without = mine({ unitShare: 0 }).shapes;

    // then the rule keeps it out of that workflow, and turning the rule off lets it back in
    expect(narrow(withRule).memberUnits).not.toContain("TEAM-900");
    expect(narrow(without).memberUnits).toContain("TEAM-900");
  });

  it("lets an operator running the bundle turn each of the three new rules off", () => {
    // given the shipped bundle, which is what an operator runs
    const run = (extra: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [join(repoRoot, "dist", "mine.js"), ...repos, "--min-recurrence", "5", "--min-proposers", "5", "--rare-role-cut", "3", ...extra],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
        ),
      ) as MineResult;

    // when each rule is turned off from the command line
    const narrow = (r: MineResult) => r.shapes.find((s) => s.coreRepos.length === 1 && s.recurrence >= 20)!;

    // then the unit share stops excluding the sweep ticket
    expect(narrow(run([])).memberUnits).not.toContain("TEAM-900");
    expect(narrow(run(["--unit-share", "0"])).memberUnits).toContain("TEAM-900");
    // the variant merge stops merging, on the history that has a pair to merge
    const nestedRun = (extra: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [join(repoRoot, "dist", "mine.js"), nested, "--min-recurrence", "5", "--min-proposers", "5", "--rare-role-cut", "3", "--similarity", "0.8", ...extra],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ),
      ) as MineResult;
    expect(nestedRun([]).shapes).toHaveLength(1);
    expect(nestedRun(["--variant-overlap", "0"]).shapes).toHaveLength(2);
    // and the floor on roles the history does not mostly touch starts excluding
    const strict = run(["--min-distinct-roles", "20"]);
    expect(strict.shapes).toEqual([]);
    expect(strict.stats.excludedShapes["below-distinct-roles"]).toBeGreaterThan(0);
  });

  it("keeps a ticket that did this workflow and a little else, which is the same rule's other side", () => {
    // given a ticket whose roles are the narrow workflow's three and seven more
    // when the history is mined with the shipped unit share
    const narrow = mine().shapes.find((s) => s.coreRepos.length === 1 && s.recurrence >= 20)!;

    // then it is still counted as having done the workflow
    expect(narrow.memberUnits).toContain("TEAM-800");
  });

  it("offers the smallest members first, so an example quotes a ticket that did this work and little else", () => {
    // given a history whose shapes have members of very different sizes
    // when it is mined with the unit share off, so the sweep ticket is still a member
    const shape = mine({ unitShare: 0 }).shapes.find((s) => s.coreRepos.length === 1 && s.recurrence >= 20)!;

    // then the ticket that did a dozen other things is last in the list an example would be taken from
    expect(shape.memberUnits[shape.memberUnits.length - 1]).toBe("TEAM-900");
  });

  it("merges the same workflow written down twice, once with an extra file", () => {
    // given a history where a wider version of one workflow forms its own shape
    const mineWider = (variantOverlap: number) =>
      mineShapes([nested], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3, similarity: 0.8, unitShare: 0, variantOverlap }).shapes;

    // when it is mined with the merge off, and again with it loose enough to catch the pair
    const apart = mineWider(0);
    const merged = mineWider(0.3);

    // then both are reported apart, and the merge leaves the one that ranks higher
    expect(apart).toHaveLength(2);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.recurrence).toBe(NESTED_UNITS);
  });

  it("merges that pair at the overlap it ships with, and not at the next value up", () => {
    // given the same history, whose two shapes share just over four tenths of their units
    // when it is mined with nothing overridden but the clustering the fixture needs
    const shipped = mineShapes([nested], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3, similarity: 0.8 });

    // then the shipped default merges them, and a looser one does not
    expect(shipped.shapes).toHaveLength(1);
    expect(shipped.shapes[0]!.recurrence).toBe(NESTED_UNITS);
    // Twice, because each view found the wider shape and the merge caught both.
    expect(shipped.stats.excludedShapes.variant).toBe(2);
    expect(
      mineShapes([nested], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3, similarity: 0.8, variantOverlap: 0.5 }).shapes,
    ).toHaveLength(2);
  });

  it("counts a core role that the whole history touches as no evidence, once asked to", () => {
    // given a floor on core roles that are not files most of the work touches
    // when the history is mined with it set above what any shape here can meet
    const shapes = mine({ minDistinctRoles: 20 }).shapes;

    // then nothing survives, and the reason is counted by name
    expect(shapes).toEqual([]);
    expect(mine({ minDistinctRoles: 20 }).stats.excludedShapes["below-distinct-roles"]).toBeGreaterThan(0);
  });
});

describe("roles that are not work", () => {
  let fixture: Fixture;

  beforeAll(() => (fixture = createFixture()));
  afterAll(() => fixture.cleanup());

  const seed = (name: string, compiledContent: string, extra: Record<string, string> = {}) => {
    const repo = fixture.repo(name);
    repo.commit({ files: { "README.md": "# acme\n" }, subject: "initial", author: "Ada" });
    for (let i = 0; i < 8; i++) {
      repo.commit({
        files: {
          [`locale/lang${i}/strings.po`]: `msgid "${i}"\n`,
          [`locale/lang${i}/strings.mo`]: compiledContent,
          AUTHORS: `contributor ${i}\n`,
          ...Object.fromEntries(Object.entries(extra).map(([path, body]) => [path, `${body}${i}\n`])),
        },
        subject: `TEAM-${300 + i} add the lang${i} translation`,
        author: i % 2 ? "Ada" : "Grace",
      });
    }
    return repo;
  };

  it("drops a compiled file that sits beside its source, and the roll of contributors with it", () => {
    // given a history whose every unit commits a translation, its compiled form and the contributor roll
    const repo = seed("acme-i18n", "\u0000\u0001compiled\u0000");

    // when it is mined
    const result = mineShapes([repo.path], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3 });

    // then neither the compiled twin nor the roll is a role, so what is left is one file and no shape
    const roles = result.shapes.flatMap((s) => s.coreFiles.map((f) => f.role));
    expect(roles.some((r) => /\.mo$/.test(r))).toBe(false);
    expect(roles.some((r) => /AUTHORS/.test(r))).toBe(false);
    expect(result.shapes).toEqual([]);
    // and each drop is counted, because a shape a filter empties never forms and so is never
    // counted under a reason of its own
    expect(result.stats.compiledRoles).toEqual(["locale/*/strings.mo"]);
    expect(result.stats.creditFiles).toBe(1);

    // and with the filters off both are roles again, the shape they make comes back, and the two
    // counts report nothing, because with the filters off nothing was dropped
    const unfiltered = mineShapes([repo.path], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3, filters: false });
    const back = unfiltered.shapes.flatMap((s) => s.coreFiles.map((f) => f.role));
    expect(back.some((r) => /\.mo$/.test(r))).toBe(true);
    expect(back.some((r) => /AUTHORS/.test(r))).toBe(true);
    expect(unfiltered.stats.compiledRoles).toEqual([]);
    expect(unfiltered.stats.creditFiles).toBe(0);
  });

  it("keeps a file that only looks like a compiled twin, which is what tells the two apart", () => {
    // given the same history, except that the second file is text git reports line counts for
    const repo = seed("acme-i18n-text", "not compiled at all\n", { "docs/guide.txt": "guide " });

    // when it is mined
    const result = mineShapes([repo.path], { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3 });

    // then it stays a role of its own and the three files make a shape
    const roles = result.shapes.flatMap((s) => s.coreFiles.map((f) => f.role));
    expect(roles).toContain("acme-i18n-text:locale/*/strings.mo");
    expect(result.shapes).not.toEqual([]);
  });
});
