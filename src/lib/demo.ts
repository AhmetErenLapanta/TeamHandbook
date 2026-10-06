import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DraftRunner } from "./draft.js";
import { collectUnits, shapesFromUnits } from "./mine.js";
import { draftWorkflow, listWorkflows, unitIndexFor, workflowEntries, workflowsFromShapes } from "./mine-command.js";
import type { DraftOutcome } from "./mine-command.js";
import { handbookHome } from "./session-state.js";

/**
 * The guided demo's scratch repository: an invented shop API whose history repeats one piece of
 * work often enough for /handbook:mine to find it at the thresholds the product ships with.
 *
 * Every name in it is invented, people included. Built from scratch on the machine that runs the
 * demo rather than cloned from anywhere, so the demo reads nothing of the user's and fetches nothing.
 */

interface Person {
  name: string;
  email: string;
}

// Surnames no codebase uses as a word: the person screen drops any sentence of a draft carrying a
// part of an author's name, so an author called "Order" would empty the draft of this very API.
const PEOPLE: Person[] = [
  { name: "Alice Doe", email: "alice@example.invalid" },
  { name: "Bruno Roe", email: "bruno@example.invalid" },
  { name: "Carla Poe", email: "carla@example.invalid" },
];

const RESOURCES = ["order", "customer", "product", "supplier", "shipment", "refund", "coupon", "warehouse", "invoice", "payment"];

const SETTINGS = [
  "requestTimeout",
  "maxPageSize",
  "rateLimit",
  "currency",
  "taxRate",
  "retryCount",
  "cacheSeconds",
  "logLevel",
];

/** Small fixes that touch one place each, so the repeated work has ordinary history around it. */
const FIXES: [string, string][] = [
  ["src/lib/logger.ts", "log the request id with every line"],
  ["src/lib/errors.ts", "map a missing record to a not-found response"],
  ["src/lib/db.ts", "close the pool on shutdown"],
  ["src/server.ts", "read the port from the environment"],
  ["src/lib/paging.ts", "stop a negative offset reaching the query"],
  ["src/lib/money.ts", "round half to even when converting"],
  ["src/lib/clock.ts", "use one clock for created and updated times"],
  ["src/middleware/auth.ts", "reject an expired token before the handler runs"],
  ["src/middleware/cors.ts", "allow the admin origin"],
  ["src/lib/ids.ts", "generate sortable ids"],
  ["src/lib/validate.ts", "report every invalid field, not only the first"],
  ["src/lib/http.ts", "send a retry-after header with a rate-limited reply"],
];

function pascal(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1);
}

/**
 * A git that answers to nothing on this machine: a global hook, a signing rule or a template there
 * would otherwise change the commits, or fail them, and the demo would differ from one machine to
 * the next.
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

/**
 * Writes the demo history into `dir`, which must not hold a repository yet, and returns it.
 *
 * Deterministic: the same commits, dates and authors on every run, so the recorded draft the demo
 * ships with is a draft of exactly this history.
 */
export function buildDemoRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  let day = 0;
  const nextDate = () => new Date(Date.UTC(2025, 2, 3, 10) + day++ * 86_400_000).toISOString();
  const git = (args: string[], date = nextDate()) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv(date), stdio: ["ignore", "pipe", "pipe"] });

  const write = (files: Record<string, string>, appends: Record<string, string> = {}) => {
    for (const [file, content] of Object.entries({ ...files, ...appends })) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      (file in files ? writeFileSync : appendFileSync)(join(dir, file), content);
    }
  };
  const commit = (subject: string, person: Person) => {
    git(["add", "-A"]);
    git(["-c", `user.name=${person.name}`, "-c", `user.email=${person.email}`, "commit", "-q", "-m", subject]);
  };
  const by = (i: number) => PEOPLE[i % PEOPLE.length]!;

  git(["init", "-q", "-b", "main"]);
  write({
    "README.md": "# shop-api\n\nThe HTTP API behind the shop.\n",
    "package.json": '{ "name": "shop-api", "private": true }\n',
    "src/app.ts": 'import { createServer } from "./server.js";\n\nexport const app = createServer();\n',
    "src/server.ts": "export function createServer() {\n  return { routes: [] as unknown[] };\n}\n",
    "docs/api.md": "# Endpoints\n",
  });
  commit("initial", by(0));
  for (const [file] of FIXES) write({ [file]: `export {};\n` });
  commit("lay out the shared helpers", by(1));

  const fixes = [...FIXES];
  let ticket = 100;
  RESOURCES.forEach((resource, i) => {
    const type = pascal(resource);
    const key = `SHOP-${++ticket}`;
    write(
      {
        [`src/routes/${resource}Routes.ts`]: `export const ${resource}Routes = ["GET /${resource}s", "POST /${resource}s"];\n`,
        [`src/schemas/${resource}Schema.ts`]: `export interface ${type} {\n  id: string;\n}\n`,
        ...(i % 3 === 0 ? { [`test/routes/${resource}Routes.test.ts`]: `import "../../src/routes/${resource}Routes.js";\n` } : {}),
      },
      {
        "src/app.ts": `import { ${resource}Routes } from "./routes/${resource}Routes.js";\napp.routes.push(...${resource}Routes);\n`,
        "docs/api.md": `\n## ${type}s\n\n- GET /${resource}s\n- POST /${resource}s\n`,
      },
    );
    commit(`${key} add the ${resource} endpoints`, by(i));

    if (i < SETTINGS.length) {
      const setting = SETTINGS[i]!;
      const settingKey = `SHOP-${++ticket}`;
      write(
        {},
        {
          "src/config/schema.ts": `export const ${setting} = "number";\n`,
          "src/config/defaults.ts": `export const ${setting} = 0;\n`,
          ".env.example": `${setting.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}=\n`,
          "docs/configuration.md": `\n## ${setting}\n`,
        },
      );
      commit(`${settingKey} make ${setting} configurable`, by(i + 1));
    }

    for (const [file, what] of fixes.splice(0, 2)) {
      write({}, { [file]: `// ${what}\n` });
      commit(`SHOP-${++ticket} ${what}`, by(i + 2));
    }
  });
  return dir;
}

/**
 * Left beside every scratch repository the demo builds. The demo drafts only where it finds one:
 * pointed at a real project by mistake, it would otherwise queue that project's own work.
 */
const DEMO_MARKER = ".handbook-demo";

/** A fresh scratch repository under `root`, never one that already exists, so nothing is overwritten. */
export function createDemo(root: string = tmpdir()): string {
  const base = mkdtempSync(join(root, "handbook-demo-"));
  writeFileSync(join(base, DEMO_MARKER), "");
  return buildDemoRepo(join(base, "shop-api"));
}

export function isDemoRepo(repo: string): boolean {
  return existsSync(join(dirname(repo), DEMO_MARKER));
}

/** What the demo prints once the repository is built: the product's own list, then the two ways on. */
export function demoListing(repo: string, script: string): string {
  const { workflows, repos } = listWorkflows([repo]);
  return [
    "Built a scratch repository for the demo: an invented shop API, its history written to order.",
    `  ${repo}`,
    "",
    ...workflowEntries(workflows, repos),
    "Nothing has been sent anywhere: this read the scratch repository's history and nothing else.",
    "",
    "A draft of the first workflow can come either way below, and both land in /handbook:review:",
    "",
    `  node "${script}" recorded "${repo}"`,
    "      a draft written earlier from this same history, put through the checks a fresh one",
    "      has to pass. No model call.",
    "",
    `  node "${script}" live "${repo}"`,
    "      a fresh draft from your own claude CLI. One model call, about a minute.",
  ].join("\n");
}

/**
 * Draft the first workflow of a demo repository and queue it for review, exactly as
 * /handbook:mine does, so the review screen the demo ends on is the real one.
 *
 * `run` is the only thing that differs between the two ways: the recorded draft is handed in as
 * the reply, and goes through the same format gate and screen as a reply from the model would.
 * Left undefined, it is the user's own claude CLI.
 */
export async function draftDemoWorkflow(
  repo: string,
  run: DraftRunner | undefined,
  home: string = handbookHome(),
  now?: () => string,
): Promise<DraftOutcome> {
  const mined = shapesFromUnits(collectUnits([repo]));
  const [workflow] = workflowsFromShapes(mined.shapes);
  const shape = mined.shapes.find((s) => s.id === workflow?.id);
  if (!workflow || !shape) return { ok: false, rank: 1, reasons: ["no repeating work in this repository"] };
  return draftWorkflow(workflow, unitIndexFor([repo]), shape, run, home, now, repo);
}
