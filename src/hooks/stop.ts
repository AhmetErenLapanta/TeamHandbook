import { fileURLToPath } from "node:url";
import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { enqueuePendingSignals, spawnPipelineRunner } from "../lib/pipeline.js";
import { gateAutoEnabled } from "../lib/score.js";
import { flushResolvedPairs } from "../lib/signals.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  const signals = flushResolvedPairs(input.session_id);
  const candidates = signals.filter((s) => s.kind === "candidate");
  if (candidates.length === 0) return;
  // gate.auto=false: capture stays local; nothing is sent to claude -p unless the
  // user explicitly runs /handbook:learn
  if (!gateAutoEnabled()) return;
  enqueuePendingSignals(candidates);
  spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
