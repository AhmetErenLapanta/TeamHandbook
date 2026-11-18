import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import { backupSettings } from "./backup.js";
import { manages } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { localMode } from "./mode.js";
import { route } from "./route-scopes.js";

/*
 * How much room the orchestrator's own data takes on this machine, in a few plain parts, so a
 * person who is told old task copies and logs are cleared by time can also see what is left.
 */

export type DataPart = "database" | "task-folders" | "attachments" | "copies" | "repositories" | "other";

export interface DataSize {
  total: number;
  parts: Record<DataPart, number>;
  /** The walk stopped at its cap: the numbers are a floor. */
  partial: boolean;
  /** Where the data lives, and how many copies are kept there: what the line says beside the sizes. */
  path: string;
  keep: number;
}

const PART_OF: Record<string, DataPart> = {
  tasks: "task-folders",
  "task-git": "task-folders",
  // A task's turns, and the turns of tasks that worked in a project's own folder: each is cleared with the task's log.
  "task-turns": "task-folders",
  shadow: "task-folders",
  work: "task-folders",
  attachments: "attachments",
  backups: "copies",
  mirrors: "repositories",
  "skill-sources": "repositories",
};
/** Entries one walk reads at most; a data folder is far smaller, and a runaway one still answers. */
const WALK_ENTRIES = 200_000;
const KEPT_MS = 60_000;

async function sizeOf(path: string, budget: { left: number }): Promise<number> {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) {
    if (budget.left-- <= 0) return total;
    total += await sizeOf(join(path, name), budget);
  }
  return total;
}

/** The data directory's size by part: the database with its log, each kind of folder, and the rest. */
export async function dataSize(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<DataSize> {
  const parts: Record<DataPart, number> = { database: 0, "task-folders": 0, attachments: 0, copies: 0, repositories: 0, other: 0 };
  const budget = { left: WALK_ENTRIES };
  for (const name of await readdir(dataDir).catch(() => [] as string[])) {
    const part: DataPart = name.startsWith("orchestrator.db") ? "database" : (PART_OF[name] ?? "other");
    parts[part] += await sizeOf(join(dataDir, name), budget);
  }
  // A setting that does not read stops the start, so here it always does; the default stands in for a test's bare environment.
  const keep = (() => {
    try {
      return backupSettings(env, dataDir).keep;
    } catch {
      return 7;
    }
  })();
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts, partial: budget.left <= 0, path: dataDir, keep };
}

const kept = new Map<string, { at: number; size: DataSize }>();

/** The size for the owner of a local orchestrator, read at most once a minute. */
export function dataSizeRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/data/size", async (c) => {
    const user = c.get("user");
    if (!localMode()) return c.json({ error: "the size of the data is shown on a local orchestrator", code: "local-only" }, 404);
    if (user.key || !manages(user)) return c.json({ error: "only this machine's owner sees what its data takes", code: "not-allowed" }, 403);
    const known = kept.get(ctx.dataDir);
    if (known && Date.now() - known.at < KEPT_MS) return c.json(known.size);
    const size = await dataSize(ctx.dataDir);
    kept.set(ctx.dataDir, { at: Date.now(), size });
    return c.json(size);
  });
  return app;
}
