import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureBashFailure, captureBashSuccess, captureFileEdit } from "../lib/capture.js";
import { bumpCounter, maybeDumpPayload } from "../lib/counters.js";

async function main(): Promise<void> {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  if (captureBashFailure(input)) {
    bumpCounter("bashFailuresCaptured");
    return;
  }
  if (captureBashSuccess(input)) {
    bumpCounter("pairsResolved");
    return;
  }
  captureFileEdit(input);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
