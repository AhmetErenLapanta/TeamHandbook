import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";

const SAMPLE_MS = 30_000;
/** A pause this long means nothing else ran: no request was answered and no task's output read. */
export const STALL_MS = 2_000;

export interface LoopDelay {
  /** The longest pause in the last sample, and the 99th percentile, in milliseconds. */
  maxMs: number;
  p99Ms: number;
}

let last: LoopDelay = { maxMs: 0, p99Ms: 0 };

/** What the event loop did in the last sample, for /metrics. */
export function loopDelay(): LoopDelay {
  return last;
}

/**
 * Watches how long the event loop goes without running anything, and logs a sample whose
 * longest pause passes STALL_MS: a synchronous read of a large repository or a hung native call
 * shows here before anyone reports a slow page. Returns what stops it.
 */
export function startLoopMonitor(warn: (line: string) => void = console.warn): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    last = { maxMs: histogram.max / 1e6, p99Ms: histogram.percentile(99) / 1e6 };
    if (last.maxMs > STALL_MS) warn(`event loop stalled: ${Math.round(last.maxMs)} ms without running anything in the last ${SAMPLE_MS / 1000} s`);
    histogram.reset();
  }, SAMPLE_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}

/**
 * Writes a heap snapshot for the operator into the data directory, readable by the orchestrator's
 * user only, and returns its path. A snapshot holds whatever the process holds, tokens and
 * secrets among it, so its content is never logged or sent: the operator copies the file.
 */
export function heapSnapshot(dataDir: string, now = new Date()): string {
  const dir = join(dataDir, "diagnostics");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = writeHeapSnapshot(join(dir, `heap-${now.toISOString().replace(/[:.]/g, "-")}.heapsnapshot`));
  chmodSync(file, 0o600);
  return file;
}
