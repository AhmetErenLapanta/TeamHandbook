import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file atomically: write to a per-process temp sibling, then rename over
 * the target. rename(2) is atomic on the same filesystem, so a concurrent reader
 * never sees a half-written file (which would otherwise parse-fail and, for our
 * state files, wipe the session). Best-effort cleanup of the temp on failure.
 */
let seq = 0;

export function writeFileAtomic(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  // pid + a monotonic per-process seq + hrtime make the temp name unique even for
  // two concurrent writers of the same target with same-length payloads.
  const tmp = `${file}.tmp-${process.pid}-${seq++}-${process.hrtime.bigint().toString(36)}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
