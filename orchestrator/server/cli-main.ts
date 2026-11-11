import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCli } from "./cli.js";
import { startSettings } from "./env-file.js";
import { notInstalledUpdate, startedFrom } from "./update.js";
import { runnerMain } from "../runner/cli.js";

// The package's bin (bin/handbook-orchestrator.mjs beside dist/ in the installed package) and
// `npm start` in a clone (dist/cli.js). The orchestrator is started in this process, with its web
// app read from the package or the clone, not from wherever the command was typed.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const plan = parseCli(process.argv.slice(2), version);
if ("print" in plan) {
  process.stdout.write(plan.print);
  process.exit(plan.code);
}
if (plan.args[0] === "service") {
  // npx keeps a package in a cache it clears, and a clone moves with every pull: a service runs neither.
  process.stdout.write("handbook-orchestrator: a service runs the installed executable; install it with\n  curl -fsSL https://github.com/AhmetErenLapanta/TeamHandbook/releases/download/handbook-orchestrator-latest/install.sh | sh\nthen run: handbook-orchestrator service install\n");
  process.exit(1);
}
if (plan.args[0] === "update") {
  process.stdout.write(`handbook-orchestrator: ${notInstalledUpdate(startedFrom(root))}\n`);
  process.exit(0);
}
const settings = startSettings(plan);
if ("refused" in settings) {
  process.stderr.write(`handbook-orchestrator: ${settings.refused}\n`);
  process.exit(1);
}
Object.assign(process.env, settings.env);
if (plan.args[0] === "runner") process.exit(await runnerMain(plan.args.slice(1)));
process.env.ORCHESTRATOR_WEB_ROOT ??= join(root, "dist", "web");
const server = join(root, "dist", "server.js");
process.argv = [process.argv[0]!, server, ...plan.args];
await import(pathToFileURL(server).href);
