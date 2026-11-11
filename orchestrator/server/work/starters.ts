import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import type { WorkStarter } from "../../shared/work.js";
import { localRepoPath } from "../forge/local.js";
import { shown } from "../integrations/issue-preview.js";
import { projectFolder } from "../projects.js";
import { canStartOnTeam } from "../tasks/guards.js";

/** How much of a folder is read for starters: enough for a project's own code, never a whole disk. Every entry counts, so a folder of data stops the walk as soon as one of code does. */
const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 8;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_NOTES = 3;
/** Folders no one writes notes for: dependencies, builds, caches and version control. */
const SKIPPED = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage", "__pycache__", "venv", "Pods", "DerivedData"]);
const CODE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".cs", ".swift", ".c", ".cc", ".cpp", ".h", ".scala", ".vue", ".svelte"]);
const NOTE = /\b(TODO|FIXME)\b[:\s(-]*(.{3,160})/;

export class StartersRefused extends Error {}

/**
 * Tasks to start a project with, read off its folder: the TODO and FIXME notes in its code first,
 * then the checks its manifest names (tests, lint), the kinds of work agents finish most often.
 * Nothing runs: the folder is only read, a bounded number of its own files and none in a
 * dependency, build or version-control folder, and a note that reads like a secret is withheld.
 */
export async function startersFor(ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir">, user: Principal, projectId: string, home?: string): Promise<WorkStarter[]> {
  const repo = await ctx.store.getRepo(ctx.tenant, projectId);
  const path = repo ? localRepoPath(repo.url) : null;
  if (!repo || !path || !canStartOnTeam(user, repo.team)) throw new StartersRefused("no such project");
  const folder = await projectFolder(path, { dataDir: ctx.dataDir, ...(home ? { home } : {}) });
  if ("refused" in folder) throw new StartersRefused(folder.message);
  const notes = await readNotes(folder.real);
  return [...notes, ...(await checks(folder.real))];
}

async function readNotes(root: string): Promise<WorkStarter[]> {
  const notes: WorkStarter[] = [];
  let entriesSeen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || notes.length >= MAX_NOTES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (notes.length >= MAX_NOTES || ++entriesSeen > MAX_ENTRIES) return;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !CODE.has(extname(entry.name))) continue;
      if (((await stat(full).catch(() => null))?.size ?? Infinity) > MAX_FILE_BYTES) continue;
      const lines = (await readFile(full, "utf8").catch(() => "")).split("\n");
      for (let i = 0; i < lines.length && notes.length < MAX_NOTES; i++) {
        const found = NOTE.exec(lines[i]!);
        if (!found) continue;
        const note = shown(found[2]!.replace(/\*\/\s*$|-->\s*$/, "").trim(), []);
        const where = `${relative(root, full)}:${i + 1}`;
        // The note is the file's text, not the person's: it goes to the agent quoted, as what the file says, never as what to do.
        notes.push({ kind: "todo", title: `Resolve the ${found[1]} in ${where}`, description: `Resolve the ${found[1]} note in ${where}. The note there says, quoted from the file:\n> ${note}`, where });
      }
    }
  };
  await walk(root, 0);
  return notes;
}

/** The checks a project's manifest names, for an agent to run and put right; the orchestrator runs none of them. */
async function checks(root: string): Promise<WorkStarter[]> {
  const scripts = await readFile(join(root, "package.json"), "utf8").then((t) => (JSON.parse(t) as { scripts?: Record<string, unknown> }).scripts ?? {}, () => ({}) as Record<string, unknown>);
  const starters: WorkStarter[] = [];
  if (typeof scripts.test === "string") starters.push({ kind: "tests", title: "Run the tests and fix the first one that fails", description: "Run `npm test`, find the first failing test, and fix the code it covers rather than the test.", where: "package.json" });
  if (typeof scripts.lint === "string") starters.push({ kind: "lint", title: "Run the linter and fix what it reports", description: "Run `npm run lint` and fix each finding in the code, without turning a rule off.", where: "package.json" });
  return starters;
}
