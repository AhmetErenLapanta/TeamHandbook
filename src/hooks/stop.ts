import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { flushResolvedPairs } from "../lib/signals.js";
import { withSessionLock } from "../lib/session-state.js";
import { flushTeamUsage } from "../lib/usage-report.js";

// Stop persists evidence, nothing more: each turn's resolved pairs move into the
// durable ledger so a later crash cannot lose them. The harvest itself runs once,
// at SessionEnd (or salvage) - never per turn.
async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input?.session_id) return;
  const sessionId = input.session_id;
  withSessionLock(sessionId, () => flushResolvedPairs(sessionId));
  // Team skill-use counts go once per turn, never from the tool hook, so a slow or unreachable
  // orchestrator costs a turn's end at most the flush timeout and never a tool call.
  await flushTeamUsage();
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
