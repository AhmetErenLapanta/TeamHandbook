import { fileURLToPath } from "node:url";
import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { sessionStartNotice } from "../lib/notify.js";
import { cleanupStaleSessionFiles } from "../lib/session-state.js";
import { retireDeadSessions } from "../lib/session-workflow.js";
import { salvageOrphans, spawnPipelineRunner } from "../lib/pipeline.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (salvageOrphans(input?.session_id)) {
    spawnPipelineRunner(fileURLToPath(new URL("./run-pipeline.js", import.meta.url)));
  }
  // before cleanup deletes them: a week-old session's open errors and its count are kept
  retireDeadSessions();
  cleanupStaleSessionFiles();
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
