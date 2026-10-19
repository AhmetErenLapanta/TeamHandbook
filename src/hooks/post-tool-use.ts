import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { captureBashFailure, captureBashSuccess, captureFileEdit, recordActivity } from "../lib/capture.js";
import { bumpCounter, maybeDumpPayload } from "../lib/counters.js";
import { recordSkillCall } from "../lib/usage.js";
import { handbookHome, withSessionLock } from "../lib/session-state.js";
import { recordWorkflowEvent } from "../lib/session-workflow.js";

async function main(): Promise<void> {
  const raw = await readStdin();
  maybeDumpPayload(raw);
  const input = parseHookInput(raw);
  if (!input) return;
  bumpCounter("postToolUse");
  // an installed skill firing is the one piece of evidence that a kept lesson is
  // doing anything; it is not session evidence, so it short-circuits the rest
  if (input.tool_name === "Skill") {
    recordSkillCall(input);
    return;
  }
  // one hook per tool call, and parallel calls run at once: every write below is to the
  // same session file, so they take its lock as a unit
  withSessionLock(input.session_id, () => {
    // Before the returns below: a failed check and a commit that resolves a pair are both part of
    // the trail, and each of those paths ends the hook early.
    recordWorkflowEvent(input);
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
  });
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
