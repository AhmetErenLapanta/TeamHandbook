import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { taskPaths } from "./isolation.js";
import { personalGuardDir } from "./profile.js";

/** The variable every process of a task carries, naming the task. */
export const TASK_MARKER = "TEAMHANDBOOK_TASK";

interface Member {
  pid: number;
  cwd: string | null;
  marked: boolean;
}

function linuxGroup(pgid: number, marker: string): Member[] {
  return readdirSync("/proc").flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (group !== pgid) return [];
      let cwd: string | null = null;
      let marked = false;
      try {
        cwd = readlinkSync(`/proc/${entry}/cwd`);
      } catch {
        // another user's process, or gone
      }
      try {
        marked = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(marker);
      } catch {
        // the same
      }
      return [{ pid: Number(entry), cwd, marked }];
    } catch {
      return [];
    }
  });
}

function psGroup(pgid: number): Member[] {
  let table = "";
  try {
    table = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  return table.split("\n").flatMap((line) => {
    const [pid, group] = line.trim().split(/\s+/).map(Number);
    if (!pid || group !== pgid) return [];
    let cwd: string | null = null;
    try {
      const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      cwd = out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
    } catch {
      // gone, or lsof missing
    }
    // macOS shows no process another's environment (ps -E prints nothing of it), so here only
    // the working directory says whose a process is.
    return [{ pid, cwd, marked: false }];
  });
}

/**
 * Ends what a task left running when the orchestrator stopped without stopping it. A process
 * group id outlives its group, and the system hands it to another process, so the group is
 * killed only if one of its processes is the task's: it works inside the task's own
 * directory, or, on Linux, carries the task's marker in its environment. A group none of
 * whose processes is the task's is left alone, whatever its id.
 */
export function killTaskGroup(pgid: number, taskId: string, root: string): boolean {
  const real = existsSync(root) ? realpathSync(root) : root;
  const marker = `${TASK_MARKER}=${taskId}`;
  const members = existsSync("/proc/self/stat") ? linuxGroup(pgid, marker) : psGroup(pgid);
  const ours = members.some((m) => m.marked || (m.cwd !== null && (m.cwd === real || m.cwd.startsWith(real + sep) || m.cwd.startsWith(root + sep))));
  if (!ours) return false;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    return false;
  }
  return true;
}

/**
 * Deletes every task directory and task git directory a tenant has on disk. Called at start,
 * before any task of this process runs, so whatever is there belongs to a run that ended
 * without its cleanup.
 */
export function sweepTaskDirs(dataDir: string, tenant: string): string[] {
  const probe = taskPaths(dataDir, tenant, "x");
  const dirs = [join(probe.root, ".."), join(probe.git, "..")];
  return dirs.flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((entry) => {
      // Run as me leaves its guard directory closed to writes; it is opened before the task's directory goes.
      try {
        chmodSync(personalGuardDir({ root: join(dir, entry) }), 0o700);
      } catch {}
      rmSync(join(dir, entry), { recursive: true, force: true });
      return entry;
    });
  });
}
