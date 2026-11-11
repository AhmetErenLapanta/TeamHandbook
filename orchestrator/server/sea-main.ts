import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseCli } from "./cli.js";
import { startSettings } from "./env-file.js";
import { runnerMain } from "../runner/cli.js";
import { runScript } from "./script-runner.js";
import { serviceCommand, serviceInstalled, thisHost } from "./service.js";
import { installedUpdateHost, updateCommand } from "./update.js";

// The single executable's entry (handbook-orchestrator from install.sh): its web app and the
// stand-in agent sit beside it in the same directory. Given a script file, it runs that file the
// way node would, since the orchestrator starts its own small scripts with its own executable;
// otherwise it reads its command line and starts the orchestrator.
declare const ORCHESTRATOR_VERSION: string;

async function update(args: string[]): Promise<number> {
  const say = (line: string) => console.log(`handbook-orchestrator: ${line}`);
  const host = installedUpdateHost({
    say,
    ask: async (question) => {
      if (!process.stdin.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`handbook-orchestrator: ${question} [y/N] `);
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    },
    service: { installed: () => serviceInstalled(process.platform, homedir()), restart: () => serviceCommand(["restart"], thisHost()) },
  });
  if (!host) {
    say("update moves an install made with install.sh; this executable is not one, so replace it the way you got it");
    return 1;
  }
  return updateCommand(args, host);
}

const [first, ...rest] = process.argv.slice(2);
// Only an absolute path, as the orchestrator writes for its own scripts; a relative one is a command-line word.
if (first && isAbsolute(first) && /\.(m?js)$/.test(first) && existsSync(first)) {
  await runScript(first, rest);
} else {
  const plan = parseCli(process.argv.slice(2), ORCHESTRATOR_VERSION);
  if ("print" in plan) {
    process.stdout.write(plan.print);
    process.exit(plan.code);
  }
  const settings = startSettings(plan);
  if ("refused" in settings) {
    process.stderr.write(`handbook-orchestrator: ${settings.refused}\n`);
    process.exit(1);
  }
  Object.assign(process.env, settings.env);
  if (plan.args[0] === "service") process.exit(serviceCommand(plan.args.slice(1), thisHost()));
  if (plan.args[0] === "update") process.exit(await update(plan.args.slice(1)));
  if (plan.args[0] === "runner") process.exit(await runnerMain(plan.args.slice(1), process.env, thisHost()));
  process.env.ORCHESTRATOR_WEB_ROOT ??= join(dirname(process.execPath), "web");
  process.argv = [process.execPath, process.execPath, ...plan.args];
  await import("./main.js");
}
