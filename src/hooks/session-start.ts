import { readStdin, parseHookInput } from "../lib/hook-io.js";
import { sessionStartNotice } from "../lib/notify.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  const notice = sessionStartNotice(input?.cwd ?? process.cwd());
  if (notice) console.log(notice);
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
