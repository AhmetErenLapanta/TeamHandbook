import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A process group a runner's task started, with the directory its processes work in. */
export interface RunningProcess {
  taskId: string;
  pgid: number;
  root: string;
}

/**
 * The runner's own record of the agent processes it started, kept beside its data for its
 * user alone. A runner that ends without stopping them (a crash, a closed terminal) finds
 * them here when it starts again; the orchestrator never knew their ids.
 */
export class RunnerState {
  constructor(private readonly file: string) {}

  read(): RunningProcess[] {
    if (!existsSync(this.file)) return [];
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(value) ? value.filter(isProcess) : [];
    } catch {
      return [];
    }
  }

  add(entry: RunningProcess): void {
    this.write([...this.read().filter((p) => p.taskId !== entry.taskId), entry]);
  }

  remove(taskId: string): void {
    this.write(this.read().filter((p) => p.taskId !== taskId));
  }

  /** Ends every group a previous run left, by the rule that leaves a reused id alone, and forgets them all. */
  sweep(kill: (entry: RunningProcess) => boolean): RunningProcess[] {
    const ended = this.read().filter(kill);
    this.write([]);
    return ended;
  }

  private write(entries: RunningProcess[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const next = `${this.file}.next`;
    writeFileSync(next, JSON.stringify(entries) + "\n", { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, this.file);
  }
}

function isProcess(value: unknown): value is RunningProcess {
  const v = value as RunningProcess;
  return !!v && typeof v.taskId === "string" && Number.isInteger(v.pgid) && v.pgid > 1 && typeof v.root === "string";
}
