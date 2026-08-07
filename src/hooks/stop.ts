import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { flushResolvedPairs } from "../lib/signals.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  flushResolvedPairs(input.session_id);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
