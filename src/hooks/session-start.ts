import { fileURLToPath } from "node:url";
import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { sessionStartNotice } from "../lib/notify.js";
import { cleanupStaleSessionFiles, orphanedSessionIds } from "../lib/session-state.js";
import { flushResolvedPairs } from "../lib/signals.js";
import { enqueuePendingSignals, spawnPipelineRunner } from "../lib/pipeline.js";
import { gateAutoEnabled } from "../lib/score.js";

/**
 * Salvage sessions that ended without SessionEnd firing (rage-quit, crash): flush
 * their resolved pairs into the ledger and queue any candidates for scoring —
 * otherwise hours of captured error→fix work would be deleted unprocessed.
 *
 * A stale mtime cannot distinguish a crashed session from a live-but-idle one, so
 * we use flushResolvedPairs (not flushSessionEnd): it only emits already-completed
 * pairs, clears them from state, and never deletes the file or touches openErrors.
 * Salvaging a live session by mistake then costs at most scoring its finished pairs
 * a little early — exactly what the Stop hook does at every turn — not wiping its
 * in-flight state. cleanupStaleSessionFiles (7d) handles file hygiene.
 */
function salvageOrphans(currentSessionId?: string): void {
  const orphans = orphanedSessionIds().filter((id) => id !== currentSessionId);
  const candidates = orphans.flatMap((id) => flushResolvedPairs(id).filter((s) => s.kind === "candidate"));
  if (candidates.length === 0) return;
  // gate.auto=false: recovery stays local; nothing is sent to claude -p unless the
  // user explicitly runs /handbook:learn
  if (!gateAutoEnabled()) return;
  enqueuePendingSignals(candidates);
  spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
}

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  salvageOrphans(input?.session_id);
  cleanupStaleSessionFiles();
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
