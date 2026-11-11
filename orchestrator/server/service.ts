import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, sep } from "node:path";
import { orchestratorDataDir } from "./data-lock.js";
import { readEnvFile } from "./env-file.js";
import { runningAddress } from "./local.js";

/**
 * `handbook-orchestrator service install|status|restart|uninstall`: the orchestrator as a service
 * of the person's own login, so it is running whenever they are: a launchd agent on macOS, a
 * systemd user unit on Linux. It runs the installed executable through the `current` link
 * install.sh keeps, so an update takes effect with a restart and the service file stays as it is.
 * Its settings, PATH among them, come from ~/.handbook-orchestrator/service.env alone, which only
 * the person can read: the service file names that file and holds no setting of its own.
 */

export const LABEL = "com.teamhandbook.orchestrator";
export const UNIT = "handbook-orchestrator.service";

/** What one service runs: the orchestrator itself, or the runner of a machine connected to a team's orchestrator. */
export interface ServiceKind {
  label: string;
  unit: string;
  name: string;
  /** What follows the executable and its settings file on the service's command line. */
  args: readonly string[];
  /** The command that manages it, as the person types it. */
  command: string;
  /** Where it is reached once running, for status; null for one nobody opens. */
  address: () => string | null;
  logFile: string;
  /** The exit that means starting again will not help, which systemd then does not restart. */
  finalExit: number | null;
  /** Seconds between restarts; null keeps the service manager's own (2 under systemd, 10 under launchd). */
  retrySeconds: number | null;
}

export const ORCHESTRATOR_SERVICE: ServiceKind = { label: LABEL, unit: UNIT, name: "TeamHandbook Orchestrator", args: ["--no-open"], command: "handbook-orchestrator service", address: () => runningAddress(orchestratorDataDir()), logFile: "orchestrator.log", finalExit: null, retrySeconds: null };

/**
 * `runner start` as a service, so the tasks a person starts on their team's orchestrator run on
 * this machine whenever they are logged in. A start with no connection left exits 78, which systemd
 * does not restart; the last `runner disconnect` removes this service, so launchd has none to restart.
 * While a `runner connect` in the foreground holds the lock, a start exits 75 and is tried again
 * every 30 seconds: at systemd's 2, five refusals in ten seconds would fail the unit for good, and it
 * would not take over once the foreground one stops.
 */
export const RUNNER_SERVICE: ServiceKind = { label: "com.teamhandbook.runner", unit: "handbook-runner.service", name: "TeamHandbook Runner", args: ["runner", "start"], command: "handbook-orchestrator runner service", address: () => null, logFile: "runner.log", finalExit: 78, retrySeconds: 30 };

export interface ServiceHost {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  /** The executable the service runs. */
  executable: string;
  /** The PATH service.env starts with when install writes it: the one install was run from, so claude, opencode and git resolve as they do in the person's shell. */
  path: string;
  run: (command: string, args: string[]) => { code: number; out: string };
  say: (line: string) => void;
  /** Linux inside WSL, where systemd runs only when the distribution is set to start it. */
  wsl?: boolean;
}

/** The executable as install.sh placed it: through ~/.handbook-orchestrator/current, which an update moves. */
export function serviceExecutable(execPath: string, home: string): string {
  const real = realpathSync(execPath);
  const root = join(home, ".handbook-orchestrator");
  const versions = existsSync(root) ? join(realpathSync(root), "versions") + sep : null;
  if (!versions || !real.startsWith(versions)) return real;
  return join(root, "current", ...real.slice(versions.length).split(sep).slice(1));
}

/** The settings file the service starts with. */
export function serviceEnvFile(home: string): string {
  return join(home, ".handbook-orchestrator", "service.env");
}

export function serviceEnv(path: string): string {
  return `# The settings the orchestrator service starts with, one KEY=value a line; only you can read this file.
# PATH is the one service install ran from, so claude, opencode and git resolve as in your shell.
# After a change: handbook-orchestrator service restart
PATH="${path}"
`;
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(host: Pick<ServiceHost, "executable" | "home">, kind: ServiceKind = ORCHESTRATOR_SERVICE): string {
  const log = join(logDir(host.home, kind), kind.logFile);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${kind.label}</string>
  <key>ProgramArguments</key>
  <array>${[host.executable, "--env-file", serviceEnvFile(host.home), ...kind.args].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xml(host.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${kind.retrySeconds === null ? "" : `  <key>ThrottleInterval</key><integer>${kind.retrySeconds}</integer>\n`}  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

const unitValue = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(host: Pick<ServiceHost, "executable" | "home">, kind: ServiceKind = ORCHESTRATOR_SERVICE): string {
  return `[Unit]
Description=${kind.name}

[Service]
ExecStart=${unitValue(host.executable)} --env-file ${unitValue(serviceEnvFile(host.home))} ${kind.args.join(" ")}
Restart=always
RestartSec=${kind.retrySeconds ?? 2}
${kind.finalExit === null ? "" : `RestartPreventExitStatus=${kind.finalExit}\n`}
[Install]
WantedBy=default.target
`;
}

function plistFile(home: string, kind: ServiceKind): string {
  return join(home, "Library", "LaunchAgents", `${kind.label}.plist`);
}

function unitFile(home: string, kind: ServiceKind): string {
  return join(home, ".config", "systemd", "user", kind.unit);
}

function logDir(home: string, kind: ServiceKind): string {
  return join(home, "Library", "Logs", kind.name);
}

/** Whether a service file of this install is in place for this user. */
export function serviceInstalled(platform: NodeJS.Platform, home: string, kind: ServiceKind = ORCHESTRATOR_SERVICE): boolean {
  return existsSync(platform === "darwin" ? plistFile(home, kind) : unitFile(home, kind));
}

function must(host: ServiceHost, command: string, args: string[]): string {
  const done = host.run(command, args);
  if (done.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${done.out.trim().split("\n").at(-1) ?? ""}`);
  return done.out;
}

/** Writes service.env when there is none; one already there is kept as the person left it, once only they can read it. */
function writeServiceEnv(host: ServiceHost): void {
  const file = serviceEnvFile(host.home);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, serviceEnv(host.path), { mode: 0o600 });
    host.say(`wrote ${file}, the settings it starts with; PATH is the one you ran this from`);
    return;
  }
  const read = readEnvFile(file);
  if ("refused" in read) throw new Error(read.refused);
  host.say(`kept ${file}, the settings it starts with`);
}

function install(host: ServiceHost, kind: ServiceKind): void {
  if (host.platform === "darwin") {
    writeServiceEnv(host);
    const file = plistFile(host.home, kind);
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(logDir(host.home, kind), { recursive: true });
    writeFileSync(file, launchdPlist(host, kind));
    // Bootstrapping an agent that is loaded already fails, so a reinstall unloads the old one first.
    host.run("launchctl", ["bootout", `gui/${host.uid}/${kind.label}`]);
    must(host, "launchctl", ["bootstrap", `gui/${host.uid}`, file]);
    host.say(`installed: a launchd agent (${file}) runs it now and at every login; its log is in ~/Library/Logs/${kind.name}`);
    return;
  }
  if (host.run("systemctl", ["--user", "show-environment"]).code !== 0) {
    throw new Error(
      host.wsl
        ? "systemd does not run in this WSL distribution; add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown from Windows, then install again"
        : `no systemd user manager answers for this login (systemctl --user); run it in the foreground instead: handbook-orchestrator${kind.args.includes("runner") ? ` ${kind.args.join(" ")}` : ""}`,
    );
  }
  writeServiceEnv(host);
  const file = unitFile(host.home, kind);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit(host, kind));
  must(host, "systemctl", ["--user", "daemon-reload"]);
  must(host, "systemctl", ["--user", "enable", "--now", kind.unit]);
  host.say(`installed: a systemd user unit (${file}) runs it now and at every login; journalctl --user -u ${kind.unit} shows its log`);
  const linger = host.run("loginctl", ["show-user", userInfo().username, "--property=Linger"]);
  if (linger.code === 0 && linger.out.trim() === "Linger=no") host.say("it stops when you log out; to keep it running then: loginctl enable-linger");
}

function status(host: ServiceHost, kind: ServiceKind): number {
  const address = kind.address();
  if (!serviceInstalled(host.platform, host.home, kind)) {
    host.say(`not installed; ${kind.command} install sets it up`);
    return 1;
  }
  if (host.platform === "darwin") {
    const shown = host.run("launchctl", ["print", `gui/${host.uid}/${kind.label}`]);
    const state = /^\s*state = (.+)$/m.exec(shown.out)?.[1]?.trim() ?? "not loaded";
    const pid = /^\s*pid = (\d+)/m.exec(shown.out)?.[1];
    host.say(`launchd agent: ${state}${pid ? `, pid ${pid}` : ""}${address && state === "running" ? `, at ${address}` : ""}`);
    return state === "running" ? 0 : 1;
  }
  const active = host.run("systemctl", ["--user", "is-active", kind.unit]).out.trim() || "unknown";
  host.say(`systemd user unit: ${active}${address && active === "active" ? `, at ${address}` : ""}`);
  return active === "active" ? 0 : 1;
}

function restart(host: ServiceHost, kind: ServiceKind): void {
  if (host.platform === "darwin") must(host, "launchctl", ["kickstart", "-k", `gui/${host.uid}/${kind.label}`]);
  else must(host, "systemctl", ["--user", "restart", kind.unit]);
  host.say("restarted");
}

function uninstall(host: ServiceHost, kind: ServiceKind): void {
  if (host.platform === "darwin") {
    host.run("launchctl", ["bootout", `gui/${host.uid}/${kind.label}`]);
    rmSync(plistFile(host.home, kind), { force: true });
  } else {
    host.run("systemctl", ["--user", "disable", "--now", kind.unit]);
    rmSync(unitFile(host.home, kind), { force: true });
    host.run("systemctl", ["--user", "daemon-reload"]);
  }
  host.say(`uninstalled: it no longer starts on its own; its data and ${serviceEnvFile(host.home)} stay where they were`);
}

export const SERVICE_USAGE = "usage: handbook-orchestrator service install | status | restart | uninstall";

/** Runs one service action; the exit code. */
export function serviceCommand(args: readonly string[], host: ServiceHost, kind: ServiceKind = ORCHESTRATOR_SERVICE): number {
  const [action, ...extra] = args;
  if (!action || extra.length || !["install", "status", "restart", "uninstall"].includes(action)) {
    host.say(`usage: ${kind.command} install | status | restart | uninstall`);
    return 2;
  }
  if (host.platform !== "darwin" && host.platform !== "linux") {
    host.say("a service is set up on macOS and Linux; on Windows, install and run it inside WSL");
    return 1;
  }
  try {
    if (action === "status") return status(host, kind);
    if (action === "install") install(host, kind);
    else if (action === "restart") restart(host, kind);
    else uninstall(host, kind);
    return 0;
  } catch (err) {
    host.say((err as Error).message);
    return 1;
  }
}

/** The host this process runs on. */
export function thisHost(): ServiceHost {
  const home = homedir();
  return {
    platform: process.platform,
    home,
    uid: process.getuid?.() ?? 0,
    executable: serviceExecutable(process.execPath, home),
    path: process.env.PATH ?? "/usr/bin:/bin",
    run: (command, args) => {
      const done = spawnSync(command, args, { encoding: "utf8" });
      return { code: done.status ?? 1, out: `${done.stdout ?? ""}${done.stderr ?? ""}` };
    },
    say: (line) => console.log(`handbook-orchestrator: ${line}`),
    wsl: process.platform === "linux" && existsSync("/proc/version") && /microsoft/i.test(readFileSync("/proc/version", "utf8")),
  };
}
