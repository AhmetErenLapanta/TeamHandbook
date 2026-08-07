import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureBashFailure, captureBashSuccess, captureFileEdit } from "../lib/capture.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input) return;
  captureBashFailure(input) || captureBashSuccess(input) || captureFileEdit(input);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
