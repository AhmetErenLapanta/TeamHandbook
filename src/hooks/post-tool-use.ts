import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureBashFailure, captureBashSuccess, captureFileEdit, recordActivity } from "../lib/capture.js";
import { bumpCounter, maybeDumpPayload } from "../lib/counters.js";
import { recordSkillUse } from "../lib/usage.js";
import { handbookHome } from "../lib/session-state.js";

async function main(): Promise<void> {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  // an installed skill firing is the one piece of evidence that a kept lesson is
  // doing anything; it is not session evidence, so it short-circuits the rest
  if (input.tool_name === "Skill") {
    const slug = typeof input.tool_input?.skill === "string" ? input.tool_input.skill : "";
    recordSkillUse(slug);
    return;
  }
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
