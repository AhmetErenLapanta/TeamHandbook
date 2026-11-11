import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanMachine, packed, trappedAt } from "./clean-machine.js";

/** The clean machine's commands for a shell (lab/clean-machine.sh). */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const [command, target] = process.argv.slice(2);

if (command === "make" && target) {
  const machine = cleanMachine(target, process.env.PATH ?? "");
  const run = join(target, "run");
  const pairs = Object.entries(machine.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(" ");
  writeFileSync(run, `#!/bin/sh\n# Runs a command on this clean machine, with its environment and nothing of the caller's.\nexec env -i ${pairs} "$@"\n`);
  chmodSync(run, 0o755);
  console.log(run);
} else if (command === "trapped" && target) {
  const calls = trappedAt(target);
  for (const call of calls) console.log(`${call.name} ${call.args}`);
  process.exit(calls.length ? 1 : 0);
} else if (command === "packed" && target) {
  const names = packed(target, mkdtempSync(join(tmpdir(), "clean-machine-packed-")));
  console.log(JSON.stringify(names, null, 2));
  process.exit(names.oldNamePaths.length || names.missing.length ? 1 : 0);
} else {
  console.error("usage: sh lab/clean-machine.sh make <new dir> | trapped <dir> | packed <npm tarball or release archive>");
  process.exit(2);
}
