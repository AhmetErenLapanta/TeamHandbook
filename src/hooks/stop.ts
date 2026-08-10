import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { flushResolvedPairs } from "../lib/signals.js";

// Stop persists evidence, nothing more: each turn's resolved pairs move into the
// durable ledger so a later crash cannot lose them. The harvest itself runs once,
// at SessionEnd (or salvage) — never per turn.
async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  flushResolvedPairs(input.session_id);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
