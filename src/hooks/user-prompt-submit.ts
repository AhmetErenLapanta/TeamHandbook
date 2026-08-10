import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureCorrection } from "../lib/capture.js";

// The user's own teachings ("we never use X here", "always run Y first") are the
// highest-value lessons a session produces. Flagging them the moment they are typed
// means a teaching in the middle of a long session survives transcript slicing and
// reaches the harvest as evidence. Local only: nothing is sent anywhere here.
async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input) return;
  captureCorrection(input);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
