import { readStdin, parseHookInput } from "../lib/hook-io.js";

async function main(): Promise<void> {
  const input = parseHookInput(await readStdin());
  if (!input) return;
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
