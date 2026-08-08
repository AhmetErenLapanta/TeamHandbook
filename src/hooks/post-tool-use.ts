import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureBashFailure, captureBashSuccess, captureFileEdit, recordActivity } from "../lib/capture.js";
import { bumpCounter, maybeDumpPayload } from "../lib/counters.js";
import { handbookHome } from "../lib/session-state.js";

async function main(): Promise<void> {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  recordActivity(input);
  if (captureBashFailure(input)) {
    bumpCounter("bashFailuresCaptured");
    return;
  }
  const resolved = captureBashSuccess(input);
  if (resolved > 0) {
    bumpCounter("pairsResolved", handbookHome(), resolved);
    return;
  }
  captureFileEdit(input);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
