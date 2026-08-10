import { fileURLToPath } from "node:url";
import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { enqueueHarvestJob, spawnPipelineRunner } from "../lib/pipeline.js";
import { gateAutoEnabled } from "../lib/score.js";
import { loadHarvestConfig } from "../lib/harvest.js";
import { flushSessionEnd, ledgerFingerprintCounts, ledgerPairsForSession } from "../lib/signals.js";
import { loadSessionState, sessionHasSubstance } from "../lib/session-state.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  // Read the state BEFORE the flush deletes it: the harvest needs the transcript
  // path and the substance evidence.
  const state = loadSessionState(input.session_id);
  const substance = sessionHasSubstance(state);
  const transcriptPath = state.transcriptPath ?? input.transcript_path;
  flushSessionEnd(input.session_id);
  if (!substance) return; // trivial session — no claude call, by design
  // gate.auto=false / harvest.enabled=false: capture stays local; nothing is sent
  // to claude -p unless the user explicitly runs /handbook:learn
  if (!gateAutoEnabled() || !loadHarvestConfig().enabled) return;
  const pairs = ledgerPairsForSession(input.session_id);
  const counts = ledgerFingerprintCounts();
  const recurrence: Record<string, number> = {};
  for (const pair of pairs) recurrence[pair.fingerprint] = counts.get(pair.fingerprint) ?? 1;
  enqueueHarvestJob({
    sessionId: input.session_id,
    cwd: input.cwd ?? pairs[0]?.cwd ?? "",
    ...(transcriptPath ? { transcriptPath } : {}),
    evidence: {
      pairs,
      ...(state.activity ? { work: state.activity } : {}),
      ...(state.corrections?.length ? { corrections: state.corrections } : {}),
      recurrence,
    },
  });
  spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
