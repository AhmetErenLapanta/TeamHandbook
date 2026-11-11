import { resolve } from "node:path";

/**
 * The command line of `handbook-orchestrator` (and `npx teamhandbook-orchestrator`): a few flags
 * turned into the settings the orchestrator reads, then the orchestrator itself with the rest.
 * The flags are the ones a person types; everything else stays an environment setting.
 */

export const USAGE = `usage: handbook-orchestrator [--port <n>] [--data-dir <dir>] [--no-open] [--env-file <file>]
       handbook-orchestrator doctor [--fix]
       handbook-orchestrator service install | status | restart | uninstall
       handbook-orchestrator update [--check | --prepare | --apply] [--to <version>] [--allow-downgrade] [--yes]
       handbook-orchestrator runner connect <address> <code> | start [<org>] | status | disconnect <org>
       handbook-orchestrator --help | --version

Starts the orchestrator on this machine, for you alone: it listens on 127.0.0.1, keeps its data
in your system's place for application data and opens it in your browser.

  --port <n>        the port to listen on (default 8080, or a free one when that is taken)
  --data-dir <dir>  where its data lives (ORCHESTRATOR_DATA_DIR)
  --no-open         print the address and leave the browser closed
  --env-file <file> settings to start with, one KEY=value a line, in a file only you can read
  doctor [--fix]    look a stopped orchestrator's data over and say what is wrong
  service ...       run it whenever you are logged in (launchd on macOS, systemd on Linux)
  update            move to the newest release, checked against its SHA256SUMS; --prepare places
                    it beside this one and --apply makes it current later
  runner ...        connect this machine to a team's orchestrator, so the tasks you start there run here
`;

/** What the command line asks for: text to print and an exit code, or the orchestrator started with these settings and arguments. */
export type CliPlan = { print: string; code: number } | { env: Record<string, string>; args: string[]; envFile?: string };

const SUBCOMMANDS = new Set(["doctor", "service", "update", "runner"]);

export function parseCli(argv: readonly string[], version: string, cwd: string = process.cwd()): CliPlan {
  const env: Record<string, string> = {};
  let envFile: string | undefined;
  const args = [...argv];
  const refuse = (why: string): CliPlan => ({ print: `handbook-orchestrator: ${why}\n\n${USAGE}`, code: 2 });
  while (args.length && args[0]!.startsWith("--")) {
    const flag = args.shift()!;
    if (flag === "--help" || flag === "-h") return { print: USAGE, code: 0 };
    if (flag === "--version") return { print: `teamhandbook-orchestrator ${version}\n`, code: 0 };
    if (flag === "--no-open") env.ORCHESTRATOR_NO_BROWSER = "1";
    else if (flag === "--port") {
      const port = args.shift();
      if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return refuse("--port takes a port number from 1 to 65535");
      env.ORCHESTRATOR_PORT = port;
    } else if (flag === "--data-dir") {
      const dir = args.shift();
      if (!dir) return refuse("--data-dir takes a directory");
      env.ORCHESTRATOR_DATA_DIR = resolve(cwd, dir);
    } else if (flag === "--env-file") {
      const file = args.shift();
      if (!file) return refuse("--env-file takes a file");
      envFile = resolve(cwd, file);
    } else return refuse(`${flag} is not a flag it reads`);
  }
  if (args.length && !SUBCOMMANDS.has(args[0]!)) return refuse(`${args[0]} is not a command it runs`);
  return envFile ? { env, args, envFile } : { env, args };
}
