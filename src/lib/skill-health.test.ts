import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture } from "./mine-fixture.js";
import type { Fixture, FixtureRepo } from "./mine-fixture.js";
import { readUnitIndex } from "./draft.js";
import {
  checkRows,
  fileMapRows,
  fitTrend,
  formatSkillHealth,
  gatherSkillHealth,
  overlappingSkills,
  OVERLAP_THRESHOLD,
  repoTree,
  trendOf,
  triggerWords,
  wordOverlap,
} from "./skill-health.js";
import type { MapRow, SkillHealth } from "./skill-health.js";

let fixture: Fixture;
let home: string;
/** A user home and a project with no skills of their own, for the cases that are not about overlap. */
let empty: string;

beforeEach(() => {
  fixture = createFixture();
  home = mkdtempSync(join(tmpdir(), "handbook-health-"));
  empty = mkdtempSync(join(tmpdir(), "handbook-empty-"));
});

afterEach(() => {
  fixture.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

function skillText(name: string, cells: string[], description = `Does ${name}. Use when asked to ${name}.`): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `# ${name} - a workflow`,
    "",
    "## 1. Do it",
    "1. Edit the files.",
    "",
    "## File map (10 past changes)",
    "| File (pattern) | Touched in | Note |",
    "|---|---|---|",
    ...cells.map((cell) => `| ${cell} | 10/10 | why |`),
    "",
    "## Verification",
    "- [ ] `npm test` exits 0",
    "",
  ].join("\n");
}

const AREAS = ["orders", "billing", "users", "stock", "cart"];

/** One file of every pattern kind a map carries, under `base` so the same layout can sit inside a larger checkout. */
function layout(base = ""): Record<string, string> {
  const files: Record<string, string> = {
    [`${base}src/routes/index.ts`]: "routes\n",
    [`${base}src/api/orderTypes.ts`]: "order\n",
    [`${base}src/api/userTypes.ts`]: "user\n",
    [`${base}src/i18n/messages_en.properties`]: "a=b\n",
    [`${base}src/i18n/messages_de.properties`]: "a=b\n",
  };
  for (const area of AREAS) {
    const type = area[0]!.toUpperCase() + area.slice(1);
    files[`${base}src/controller/${area}/${type}Controller.kt`] = `class ${type}Controller\n`;
    files[`${base}src/middleware/${area}/index.ts`] = `export const ${area} = 1\n`;
  }
  return files;
}

const LAYOUT_CELLS = [
  "Route table (`src/routes/index.ts`)",
  "`api/*Types.ts`",
  "`controller/*Controller.kt`",
  "`middleware/*/index.ts`",
  "Messages (`i18n/messages_{locale}.properties`)",
];

function seeded(name = "shop", base = ""): FixtureRepo {
  const repo = fixture.repo(name);
  repo.commit({ files: layout(base), subject: "TEAM-1 initial layout", author: "Ada" });
  return repo;
}

function staleness(root: string, cells: string[] = LAYOUT_CELLS, base = ""): (boolean | null)[] {
  const tree = repoTree(root, "shop")!;
  return checkRows(fileMapRows(skillText("x", cells)), () => ({ tree, base })).map((row) => row.stale);
}

describe("fileMapRows", () => {
  it("given the cells a drafted map actually carries, when read, then every quoted pattern and repository label is kept", () => {
    const rows = fileMapRows(
      skillText("x", [
        "Type definitions (`types/*d.ts`, `test/types/*test-d.ts`)",
        "orders-api: `dto/*Request.kt`",
        "`orders-web:src/forms/*Form.tsx`",
        "`docs/Reference/Errors.md`",
        "A sentence with no path in it",
      ]),
    );

    expect(rows.map(({ label, patterns }) => ({ label, patterns }))).toEqual([
      { label: null, patterns: ["types/*d.ts", "test/types/*test-d.ts"] },
      { label: "orders-api", patterns: ["dto/*Request.kt"] },
      { label: "orders-web", patterns: ["src/forms/*Form.tsx"] },
      { label: null, patterns: ["docs/Reference/Errors.md"] },
    ]);
  });

  it("given a skill with no file map, when read, then there are no rows", () => {
    expect(fileMapRows("---\nname: x\ndescription: d\n---\n# x\n\n## Steps\n1. go\n")).toEqual([]);
  });
});

describe("staleness", () => {
  it("given every mapped kind of pattern still in the tree, when checked, then no row is stale", () => {
    const repo = seeded();

    expect(staleness(repo.path)).toEqual([false, false, false, false, false]);
  });

  it("given the project inside a larger checkout, when its map is checked knowing where the project sits, then no row is stale", () => {
    const repo = seeded("mono", "packages/shop/");

    expect(staleness(repo.path, LAYOUT_CELLS, "packages/shop")).toEqual([false, false, false, false, false]);
  });

  it("given the route table deleted while a vendored package and a deeper copy still carry one, when checked, then the row is stale", () => {
    const repo = seeded();
    repo.commit({
      files: { "src/routes/index.ts": null, "vendor/pkg/src/routes/index.ts": "theirs\n", "tools/copy/src/routes/index.ts": "copy\n" },
      subject: "TEAM-2 x",
      author: "Ada",
    });

    expect(staleness(repo.path)[0]).toBe(true);
  });

  it("given the type files deleted while one unrelated directory still holds a file of that kind, when checked, then the row is stale", () => {
    const repo = seeded();
    repo.commit({
      files: {
        "src/api/orderTypes.ts": null,
        "src/api/userTypes.ts": null,
        "node/vendored/api/v2/generatedTypes.ts": "x\n",
        "gen/api/v2/schemaTypes.ts": "x\n",
      },
      subject: "TEAM-2 x",
      author: "Ada",
    });

    expect(staleness(repo.path)[1]).toBe(true);
  });

  it("given a role the miner names by the directory a file sits in, deep in a source tree, when checked, then the row is live", () => {
    const repo = fixture.repo("orders");
    repo.commit({ files: { "src/main/kotlin/acme/orders/service/OrderService.kt": "class OrderService\n" }, subject: "TEAM-1 x", author: "Ada" });

    expect(staleness(repo.path, ["`service/*Service.kt`", "`**/acme/orders/service/OrderService.kt`", "`service/OrderService.kt`"])).toEqual([false, false, true]);
  });

  it("given one of five area controllers deleted, when checked, then the row still finds the four that remain", () => {
    const repo = seeded();
    repo.commit({ files: { "src/controller/cart/CartController.kt": null }, subject: "TEAM-2 drop cart", author: "Ada" });

    expect(staleness(repo.path)[2]).toBe(false);
  });

  // The ten artificial stalings the detector is measured on: each removes or moves what one row
  // names, and only that row may turn stale.
  const stalings: { name: string; row: number; change: (repo: FixtureRepo) => void }[] = [
    { name: "the route table deleted", row: 0, change: (r) => r.commit({ files: { "src/routes/index.ts": null }, subject: "TEAM-2 x", author: "Ada" }) },
    { name: "the route table moved", row: 0, change: (r) => r.commit({ files: {}, renames: { "src/routes/index.ts": "src/router/table.ts" }, subject: "TEAM-2 x", author: "Ada" }) },
    {
      name: "every type file deleted",
      row: 1,
      change: (r) => r.commit({ files: { "src/api/orderTypes.ts": null, "src/api/userTypes.ts": null }, subject: "TEAM-2 x", author: "Ada" }),
    },
    {
      name: "the type files moved to another directory",
      row: 1,
      change: (r) =>
        r.commit({ files: {}, renames: { "src/api/orderTypes.ts": "src/schema/orderTypes.ts", "src/api/userTypes.ts": "src/schema/userTypes.ts" }, subject: "TEAM-2 x", author: "Ada" }),
    },
    {
      name: "the type files renamed to another suffix",
      row: 1,
      change: (r) =>
        r.commit({ files: {}, renames: { "src/api/orderTypes.ts": "src/api/orderModel.ts", "src/api/userTypes.ts": "src/api/userModel.ts" }, subject: "TEAM-2 x", author: "Ada" }),
    },
    {
      name: "every area controller deleted",
      row: 2,
      change: (r) =>
        r.commit({
          files: Object.fromEntries(AREAS.map((a) => [`src/controller/${a}/${a[0]!.toUpperCase()}${a.slice(1)}Controller.kt`, null])),
          subject: "TEAM-2 x",
          author: "Ada",
        }),
    },
    {
      name: "the area controllers moved to handlers",
      row: 2,
      change: (r) =>
        r.commit({
          files: {},
          renames: Object.fromEntries(
            AREAS.map((a) => {
              const type = a[0]!.toUpperCase() + a.slice(1);
              return [`src/controller/${a}/${type}Controller.kt`, `src/handler/${a}/${type}Handler.kt`];
            }),
          ),
          subject: "TEAM-2 x",
          author: "Ada",
        }),
    },
    {
      name: "every middleware entry deleted",
      row: 3,
      change: (r) => r.commit({ files: Object.fromEntries(AREAS.map((a) => [`src/middleware/${a}/index.ts`, null])), subject: "TEAM-2 x", author: "Ada" }),
    },
    {
      name: "the middleware flattened into single files",
      row: 3,
      change: (r) =>
        r.commit({
          files: {},
          renames: Object.fromEntries(AREAS.map((a) => [`src/middleware/${a}/index.ts`, `src/middleware/${a}.ts`])),
          subject: "TEAM-2 x",
          author: "Ada",
        }),
    },
    {
      name: "the translations deleted",
      row: 4,
      change: (r) =>
        r.commit({ files: { "src/i18n/messages_en.properties": null, "src/i18n/messages_de.properties": null }, subject: "TEAM-2 x", author: "Ada" }),
    },
  ];

  it.each(stalings)("given $name, when checked, then that row and only that row is stale", ({ row, change }) => {
    const repo = seeded();
    change(repo);

    const expected = LAYOUT_CELLS.map((_, i) => i === row);
    expect(staleness(repo.path)).toEqual(expected);
  });

  it("given a row naming a repository nothing on this machine is known as, when checked, then it is left unchecked rather than called stale", () => {
    const repo = seeded();
    const tree = repoTree(repo.path, "shop")!;
    const rows = fileMapRows(skillText("x", ["`src/routes/index.ts`", "orders-api: `dto/*Request.kt`"]));

    const checked = checkRows(rows, (label) => (label === null || label === "shop" ? { tree, base: "" } : null));

    expect(checked.map((c) => c.stale)).toEqual([false, null]);
  });
});

describe("fitTrend", () => {
  const entity = (n: number) => `entity${n}`;
  const mapped = (repo: FixtureRepo, n: number) =>
    repo.commit({
      files: {
        [`src/api/${entity(n)}Types.ts`]: `export type E${n} = {}\n`,
        [`src/forms/${entity(n)}Form.tsx`]: `export const F${n} = 1\n`,
        "src/routes/index.ts": `routes ${n}\n`,
      },
      subject: `TEAM-${n} add ${entity(n)}`,
      author: "Ada",
    });
  // The work moved: forms became views, and a store slice joined every change. Neither is on the map.
  const drifted = (repo: FixtureRepo, n: number) =>
    repo.commit({
      files: {
        [`src/api/${entity(n)}Types.ts`]: `export type E${n} = {}\n`,
        [`src/views/${entity(n)}View.tsx`]: `export const V${n} = 1\n`,
        [`src/store/${entity(n)}Slice.ts`]: `export const S${n} = 1\n`,
        "src/routes/index.ts": `routes ${n}\n`,
      },
      subject: `TEAM-${n} add ${entity(n)}`,
      author: "Ada",
    });
  const rows: MapRow[] = fileMapRows(skillText("add-entity", ["`api/*Types.ts`", "`forms/*Form.tsx`", "`src/routes/index.ts`"]));

  function trendOf(repo: FixtureRepo) {
    const tree = repoTree(repo.path, "shop")!;
    return fitTrend(rows, [tree], () => ({ tree, base: "" }), readUnitIndex([repo.path]));
  }

  it("given the last ten tickets touching files the map does not list, when the trend is read, then it falls", () => {
    const repo = fixture.repo("shop");
    for (let n = 1; n <= 10; n++) mapped(repo, n);
    for (let n = 11; n <= 20; n++) drifted(repo, n);

    expect(trendOf(repo)).toEqual({ trend: "down", units: 20, recent: 0.5, prior: 1 });
  });

  it("given twenty tickets that all follow the map, when the trend is read, then it is flat", () => {
    const repo = fixture.repo("shop");
    for (let n = 1; n <= 20; n++) mapped(repo, n);

    expect(trendOf(repo)).toEqual({ trend: "flat", units: 20, recent: 1, prior: 1 });
  });

  it("given work that drifted and then came back to the map, when the trend is read, then it rises", () => {
    const repo = fixture.repo("shop");
    for (let n = 1; n <= 10; n++) drifted(repo, n);
    for (let n = 11; n <= 20; n++) mapped(repo, n);

    expect(trendOf(repo).trend).toBe("up");
  });

  it("given too few tickets to fill two windows, when the trend is read, then no arrow is drawn", () => {
    const repo = fixture.repo("shop");
    for (let n = 1; n <= 5; n++) mapped(repo, n);

    expect(trendOf(repo)).toEqual({ trend: null, units: 5, recent: null, prior: null });
  });
});

describe("trendOf", () => {
  it("given windows that differ by more than the band but scatter more than they moved, when read, then it is flat", () => {
    const prior = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    const recent = [1, 1, 0, 1, 1, 0, 1, 1, 0, 1];

    expect(trendOf([...prior, ...recent])).toEqual({ trend: "flat", units: 20, recent: 0.7, prior: 0.5 });
  });

  it("given a steady drop larger than the band, when read, then it falls", () => {
    expect(trendOf([...Array(10).fill(0.9), ...Array(10).fill(0.6)]).trend).toBe("down");
  });

  it("given a steady drop inside the band, when read, then it is flat", () => {
    expect(trendOf([...Array(10).fill(0.9), ...Array(10).fill(0.7)]).trend).toBe("flat");
  });

  it("given eight units, when read, then two windows of four are compared", () => {
    expect(trendOf([1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5])).toEqual({ trend: "down", units: 8, recent: 0.5, prior: 1 });
  });
});

describe("overlap", () => {
  it("given the words every description is written with, when reduced, then only the subject is left", () => {
    expect([...triggerWords("Use when the user asks. Also when it fails. Triggers: \"add endpoints\".")]).toEqual(["user", "fail", "add", "endpoint"]);
  });

  it("given two skills with the same description, when compared, then they are reported as overlapping each other", () => {
    const description = "Exposes a new route through the gateway. Use when a ticket opens an endpoint. Triggers: \"open an endpoint\".";
    const found = overlappingSkills(
      [{ name: "add-route", description }],
      [
        { name: "add-route", description },
        { name: "open-endpoint", description },
        { name: "release-notes", description: "Writes the release notes. Use when a version is tagged." },
      ],
    );

    expect(found.get("add-route")).toEqual(["open-endpoint"]);
  });

  it("given two skills for different work in one codebase, when compared, then the vocabulary they share does not flag them", () => {
    const a = triggerWords(
      "Adds or changes an error code consistently across the error definitions, the TypeScript typings and the error reference docs. " +
        "Use when a request introduces, renames or removes an `ACME_ERR_*` code, or replaces a native error with a coded one. " +
        'Also when a code exists in the error table but is missing from the typings or the docs. Triggers: "add error code", "ACME_ERR".',
    );
    const b = triggerWords(
      "Adds a server option end to end: its default and validation schema, the code that reads it, the typings and the server reference docs. " +
        "Use when a request introduces or changes a server-level option. " +
        'Also when an option is accepted at runtime but rejected by the type checker. Triggers: "add server option", "expose a setting".',
    );

    expect(wordOverlap(a, b)).toBeLessThan(OVERLAP_THRESHOLD);
  });
});

describe("gatherSkillHealth", () => {
  const NOW = "2026-10-06T12:00:00.000Z";

  function deliver(repo: FixtureRepo, slug: string, text: string, fingerprint = `mine:shape-${slug}`) {
    const target = join(repo.path, ".claude", "skills", slug);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), text);
    mkdirSync(join(home, "candidates", slug), { recursive: true });
    writeFileSync(
      join(home, "candidates", slug, "candidate.json"),
      JSON.stringify({
        slug,
        status: "approved",
        createdAt: "2026-09-01T00:00:00.000Z",
        scope: "project",
        description: "d",
        fingerprint,
        sessionId: "",
        cwd: repo.path,
        gate: null,
        origin: "mine",
        deliveredMode: "solo",
        deliveredTo: target,
      }),
    );
  }

  it("given a delivered skill whose workflow was done three times and its skill called once, when gathered, then both numbers are reported apart", () => {
    const repo = seeded();
    deliver(repo, "add-route", skillText("add-route", ["`src/routes/index.ts`", "`api/*Types.ts`"]));
    writeFileSync(
      join(home, "workflows.jsonl"),
      ["s1", "s2", "s3", "s3"].map((session) => JSON.stringify({ ts: "2026-10-01T10:00:00.000Z", session, shape: "shape-add-route", match: "shape" })).join("\n") + "\n",
    );
    writeFileSync(
      join(home, "skill-usage.json"),
      JSON.stringify({ "add-route": { count: 4, lastAt: "2026-10-02T10:00:00.000Z", days: { "2026-08-01": 3, "2026-10-02": 1 } } }),
    );

    const [health] = gatherSkillHealth(home, { now: NOW, userHome: empty, cwd: empty });

    expect(health).toEqual({
      name: "add-route",
      map: { rows: 2, checked: 2, stale: 0 },
      uses: 1,
      workflowSessions: 3,
      trend: null,
      overlaps: [],
    });
  });

  it("given a skill delivered into a repository nested inside a larger checkout, when gathered, then its map is read from the checkout's top level", () => {
    const repo = seeded("mono", "packages/shop/");
    const nested = { ...repo, path: join(repo.path, "packages", "shop") };
    deliver(nested, "add-route", skillText("add-route", LAYOUT_CELLS));

    const [health] = gatherSkillHealth(home, { now: NOW, userHome: empty, cwd: empty });

    expect(health!.map).toEqual({ rows: 5, checked: 5, stale: 0 });
  });

  it("given session recording switched off, when gathered, then calls and workflow sessions are not reported as zero", () => {
    const repo = seeded();
    deliver(repo, "add-route", skillText("add-route", ["`src/routes/index.ts`"]));
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessions: { detect: false } }));

    const health = gatherSkillHealth(home, { now: NOW, userHome: empty, cwd: empty });

    expect(health[0]).toMatchObject({ uses: null, workflowSessions: null });
    expect(formatSkillHealth(health)[1]).toBe("  add-route  map 0/1 stale · usage not recorded");
  });

  it("given rows labelled with two repositories the miner recorded, when gathered, then each row is read against its own repository", () => {
    const api = fixture.repo("orders-api");
    const web = fixture.repo("orders-web");
    for (let n = 1; n <= 6; n++) {
      api.commit({ files: { [`src/dto/item${n}Request.ts`]: `r${n}\n` }, subject: `TEAM-${n} add item${n}`, author: "Ada" });
      web.commit({ files: { [`src/forms/item${n}Form.tsx`]: `f${n}\n` }, subject: `TEAM-${n} add item${n}`, author: "Ada" });
    }
    // The record names each repository by its real path, which on a temporary directory is not the path as written.
    writeFileSync(
      join(home, "mined-workflows.json"),
      JSON.stringify({
        version: 1,
        at: NOW,
        repos: [api, web].map((r) => ({ root: realpathSync(r.path), label: r.path.split("/").pop(), family: r.path.split("/").pop() })),
        resolver: { mirrors: [], templates: [], areas: [], compiled: [] },
        prefixes: ["TEAM"],
        shapes: [],
      }),
    );
    deliver(api, "add-item", skillText("add-item", ["orders-api: `dto/*Request.ts`", "orders-web: `forms/*Form.tsx`", "`src/dto/item1Request.ts`"]));

    const [fresh] = gatherSkillHealth(home, { now: NOW, userHome: empty, cwd: empty });
    web.commit({ files: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`src/forms/item${n}Form.tsx`, null])), subject: "TEAM-7 drop forms", author: "Ada" });
    const [stale] = gatherSkillHealth(home, { now: NOW, userHome: empty, cwd: empty });

    expect(fresh).toMatchObject({ map: { rows: 3, checked: 3, stale: 0 }, trend: "flat" });
    expect(stale!.map).toEqual({ rows: 3, checked: 3, stale: 1 });
  });

  it("given a skill delivered through a link to a repository the miner recorded by its real path, when gathered, then that history is read once", () => {
    const api = fixture.repo("orders-api");
    for (let n = 1; n <= 6; n++) {
      api.commit({ files: { [`src/dto/item${n}Request.ts`]: `r${n}\n`, [`src/forms/item${n}Form.tsx`]: `f${n}\n` }, subject: `TEAM-${n} add item${n}`, author: "Ada" });
    }
    const link = join(fixture.root, "api-link");
    symlinkSync(api.path, link);
    writeFileSync(
      join(home, "mined-workflows.json"),
      JSON.stringify({
        version: 1,
        at: NOW,
        repos: [{ root: realpathSync(api.path), label: "orders-api", family: "orders-api" }],
        resolver: { mirrors: [], templates: [], areas: [], compiled: [] },
        prefixes: ["TEAM"],
        shapes: [],
      }),
    );
    deliver({ ...api, path: link }, "add-item", skillText("add-item", ["orders-api: `dto/*Request.ts`", "`forms/*Form.tsx`"]));
    const read: string[][] = [];

    gatherSkillHealth(home, {
      now: NOW,
      userHome: empty, cwd: empty,
      units: (roots) => {
        read.push(roots);
        return readUnitIndex(roots);
      },
    });

    expect(read).toEqual([[realpathSync(api.path)]]);
  });

  it("given nothing delivered, when gathered, then no repository is listed and nothing is reported", () => {
    let listed = 0;

    const health = gatherSkillHealth(home, {
      tracked: () => {
        listed++;
        return [];
      },
    });

    expect(health).toEqual([]);
    expect(listed).toBe(0);
  });

  it("given a skill in the user's own directory and one in the project answering the same request as a delivered skill, when gathered, then both are named", () => {
    const route = 'Exposes a new route through the gateway and the service behind it. Use when a ticket opens an endpoint. Triggers: "open an endpoint".';
    const repo = seeded();
    deliver(repo, "add-route", skillText("add-route", ["`src/routes/index.ts`"], route));
    const userHome = mkdtempSync(join(tmpdir(), "handbook-user-"));
    const project = mkdtempSync(join(tmpdir(), "handbook-project-"));
    try {
      for (const [root, name, description] of [
        [userHome, "open-endpoint", route],
        [project, "expose-route", route],
        [project, "release-notes", "Writes the release notes. Use when a version is tagged."],
      ]) {
        mkdirSync(join(root!, ".claude", "skills", name!), { recursive: true });
        writeFileSync(join(root!, ".claude", "skills", name!, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
      }

      const [health] = gatherSkillHealth(home, { now: NOW, userHome, cwd: project });

      expect(health!.overlaps).toEqual(["expose-route", "open-endpoint"]);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("formatSkillHealth", () => {
  it("given five skills in different states, when printed, then each is one line of numbers and one suggestion follows", () => {
    const five: SkillHealth[] = [
      { name: "add-error-code", map: { rows: 3, checked: 3, stale: 0 }, uses: 4, workflowSessions: 3, trend: "flat", overlaps: [] },
      { name: "add-server-option", map: { rows: 5, checked: 5, stale: 2 }, uses: 0, workflowSessions: 3, trend: "down", overlaps: [] },
      { name: "open-endpoint", map: { rows: 4, checked: 4, stale: 0 }, uses: 2, workflowSessions: null, trend: "up", overlaps: ["add-route"] },
      { name: "release-notes", map: { rows: 0, checked: 0, stale: 0 }, uses: 7, workflowSessions: null, trend: null, overlaps: [] },
      { name: "deploy-runbook", map: { rows: 2, checked: 0, stale: 0 }, uses: 0, workflowSessions: null, trend: null, overlaps: ["ship-it", "release-notes"] },
    ];

    expect(formatSkillHealth(five).join("\n")).toMatchInlineSnapshot(`
      "Skill health:    last 30 days; nothing here is changed for you
        add-error-code     map 0/3 stale · used 4 · workflow done 3× · fit to new work →
        add-server-option  map 2/5 stale · used 0 · workflow done 3× · fit to new work ↓
        open-endpoint      map 0/4 stale · used 2 · fit to new work ↑ · overlaps add-route
        release-notes      no file map · used 7
        deploy-runbook     map not checkable here · used 0 · overlaps ship-it +1
        Stale map or falling fit: run /handbook:mine and draft that workflow again. Overlap: reword one of the two descriptions."
    `);
  });

  it("given healthy skills only, when printed, then no suggestion is added", () => {
    const lines = formatSkillHealth([
      { name: "add-error-code", map: { rows: 3, checked: 3, stale: 0 }, uses: 4, workflowSessions: null, trend: "flat", overlaps: [] },
    ]);

    expect(lines).toHaveLength(2);
  });

  it("given no delivered skills, when printed, then the section is left out", () => {
    expect(formatSkillHealth([])).toEqual([]);
  });
});

