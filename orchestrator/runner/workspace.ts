import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export const WORKING_COPIES_MAX = 50;
const DEPTH = 2;
const SKIPPED = new Set(["node_modules"]);

const hasGit = (dir: string) => lstat(join(dir, ".git")).then((s) => s.isDirectory() || s.isFile(), () => false);

export async function workingCopies(folder: string, max = WORKING_COPIES_MAX): Promise<string[] | { tooMany: true }> {
  if (await hasGit(folder)) return [""];
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<boolean> => {
    const entries = await readdir(join(folder, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (await hasGit(join(folder, path))) {
        found.push(path);
        if (found.length > max) return false;
      } else if (depth < DEPTH && !(await walk(path, depth + 1))) return false;
    }
    return true;
  };
  return (await walk("", 1)) ? found : { tooMany: true };
}
