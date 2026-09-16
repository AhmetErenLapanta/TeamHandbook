import { fileURLToPath } from "node:url";
import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { sessionStartNotice } from "../lib/notify.js";
import {
  cleanupStaleSessionFiles,
  loadSessionState,
  orphanedSessionIds,
  saveSessionState,
  sessionHasSubstance,
} from "../lib/session-state.js";
import { flushResolvedPairs, ledgerFingerprintCounts, ledgerPairsForSession } from "../lib/signals.js";
import { enqueueHarvestJob, hasPendingHarvestJobs, spawnPipelineRunner } from "../lib/pipeline.js";
import { gateAutoEnabled } from "../lib/score.js";
import { loadHarvestConfig } from "../lib/harvest.js";

/**
 * Salvage sessions that ended without SessionEnd firing (rage-quit, crash): flush
 * their evidence and harvest them — otherwise a whole session's lessons would
 * evaporate unprocessed.
 *
 * A stale mtime cannot distinguish a crashed session from a live-but-idle one, so
 * everything here is NON-destructive: flushResolvedPairs keeps the session file and
 * its open errors, and the harvestedAt marker (not deletion) provides idempotency.
 * Salvaging a live session by mistake costs at most harvesting its finished work a
 * little early. cleanupStaleSessionFiles (7d) handles file hygiene.
 */
function salvageOrphans(currentSessionId?: string): void {
  if (!gateAutoEnabled() || !loadHarvestConfig().enabled) return;
  let enqueued = 0;
  for (const id of orphanedSessionIds()) {
    if (id === currentSessionId) continue;
    const state = loadSessionState(id);
    if (state.harvestedAt) continue; // already salvaged once
    flushResolvedPairs(id); // evidence into the ledger, session file untouched
    // Only stamp a session we ACTUALLY harvest. Stamping first would mark an idle
    // orphan that has no substance yet, and SessionEnd — which now skips a stamped
    // session — would then drop that session's real work, silently and forever.
    if (!sessionHasSubstance(state)) continue;
    const pairs = ledgerPairsForSession(id);
    const counts = ledgerFingerprintCounts();
    const recurrence: Record<string, number> = {};
    for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;
    enqueueHarvestJob({
      sessionId: id,
      cwd: pairs[0]?.cwd ?? "",
      ...(state.transcriptPath ? { transcriptPath: state.transcriptPath } : {}),
      evidence: {
        pairs,
        ...(state.activity ? { work: state.activity } : {}),
        ...(state.corrections?.length ? { corrections: state.corrections } : {}),
        recurrence,
      },
    });
    const fresh = loadSessionState(id);
    fresh.harvestedAt = new Date().toISOString();
    saveSessionState(fresh);
    enqueued += 1;
  }
  // The runner is spawned for the QUEUE, not only for what this start just added to
  // it. A harvest whose model call fails re-queues itself with attempts+1, but nothing
  // ever drained that retry: salvage stamps each session harvestedAt once, so `enqueued`
  // is 0 at every later start, and SessionEnd skips a stamped session too. Measured on a
  // real home: two jobs sat at attempts 1 for 23 hours across many sessions, while the
  // start notice kept telling the user they were "harvesting in the background". A
  // transient failure became a permanent loss. Draining an empty queue costs one
  // readdir and no model call; a retry spends the attempt the failed job already
  // budgeted, and MAX_HARVEST_ATTEMPTS still ends it at three.
  if (enqueued > 0 || hasPendingHarvestJobs()) {
    spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
  }
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
