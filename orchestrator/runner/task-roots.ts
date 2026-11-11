import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { releasePersonalGuard } from "../server/tasks/profile.js";

export const KEEP_STOPPED_TASK_MS = 14 * 24 * 60 * 60_000;

export async function sweepTaskRoots(tasksDir: string, now: number = Date.now(), keepMs: number = KEEP_STOPPED_TASK_MS): Promise<string[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(tasksDir, entry.name);
    const changed = await stat(root).then((s) => s.mtimeMs, () => now);
    if (now - changed < keepMs) continue;
    await releasePersonalGuard(root);
    await rm(root, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
