import { drainPendingSignals, runPipeline } from "../lib/pipeline.js";

async function main(): Promise<void> {
  const signals = drainPendingSignals();
  if (signals.length === 0) return;
  await runPipeline(signals);
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
