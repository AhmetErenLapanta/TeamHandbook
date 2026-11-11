import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvFile } from "./env-file.js";
import { LABEL, launchdPlist, RUNNER_SERVICE, serviceCommand, serviceEnvFile, serviceExecutable, systemdUnit, UNIT } from "./service.js";
import type { ServiceHost } from "./service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-service-"));
  dirs.push(dir);
  return dir;
}

/** A host whose launchctl and systemctl are stand-ins answering from `answers`, keeping every call. */
function host(platform: NodeJS.Platform, answers: Record<string, { code: number; out: string }> = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const home = scratch();
  const h: ServiceHost = {
    platform,
    home,
    uid: 501,
    executable: join(home, ".handbook-orchestrator", "current", "handbook-orchestrator"),
    path: "/opt/tools/bin:/usr/bin:/bin",
    run: (command, args) => {
      const call = `${command} ${args.join(" ")}`;
      calls.push(call);
      return answers[call] ?? { code: 0, out: "" };
    },
    say: (line) => void said.push(line),
  };
  return { h, calls, said, home };
}

describe("the orchestrator as a launchd agent on macOS", () => {
  it("given install, when it runs, then the agent's file names the current executable and service.env without opening a browser, service.env holds the PATH install ran under for the person alone, and the agent is unloaded and loaded again", () => {
    const { h, calls, home } = host("darwin");

    expect(serviceCommand(["install"], h)).toBe(0);

    const plist = readFileSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`), "utf8");
    expect(plist).toContain(`<array><string>${h.executable}</string><string>--env-file</string><string>${serviceEnvFile(home)}</string><string>--no-open</string></array>`);
    expect(plist).not.toContain("<key>PATH</key>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(statSync(serviceEnvFile(home)).mode & 0o777).toBe(0o600);
    expect(readEnvFile(serviceEnvFile(home))).toEqual({ env: { PATH: "/opt/tools/bin:/usr/bin:/bin" } });
    expect(calls).toEqual([`launchctl bootout gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${join(home, "Library", "LaunchAgents", `${LABEL}.plist`)}`]);
    expect(existsSync(join(home, "Library", "Logs", "TeamHandbook Orchestrator"))).toBe(true);
  });

  it("given an agent launchd reports running, stopped, or no agent file, when status runs, then it says which and exits 0 only when running", () => {
    const running = host("darwin", { [`launchctl print gui/501/${LABEL}`]: { code: 0, out: "\tstate = running\n\tpid = 4242\n" } });
    const stopped = host("darwin", { [`launchctl print gui/501/${LABEL}`]: { code: 0, out: "\tstate = not running\n" } });
    const absent = host("darwin");
    serviceCommand(["install"], running.h);
    serviceCommand(["install"], stopped.h);

    expect(serviceCommand(["status"], running.h)).toBe(0);
    expect(running.said.at(-1)).toMatch(/^launchd agent: running, pid 4242/);
    expect(serviceCommand(["status"], stopped.h)).toBe(1);
    expect(stopped.said.at(-1)).toBe("launchd agent: not running");
    expect(serviceCommand(["status"], absent.h)).toBe(1);
    expect(absent.said.at(-1)).toBe("not installed; handbook-orchestrator service install sets it up");
  });

  it("given restart and uninstall, when they run, then launchd restarts the agent, and uninstall unloads it and removes its file", () => {
    const { h, calls, home } = host("darwin");
    serviceCommand(["install"], h);
    calls.length = 0;

    expect(serviceCommand(["restart"], h)).toBe(0);
    expect(serviceCommand(["uninstall"], h)).toBe(0);

    expect(calls).toEqual([`launchctl kickstart -k gui/501/${LABEL}`, `launchctl bootout gui/501/${LABEL}`]);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
  });

  it("given launchd refusing the agent, when install runs, then it exits 1 with launchd's last line", () => {
    const { h, said, home } = host("darwin", { [`launchctl bootstrap gui/501 ${"PLIST"}`]: { code: 1, out: "" } });
    h.run = (command, args) => (args[0] === "bootstrap" ? { code: 5, out: "Bootstrap failed: 5: Input/output error\n" } : { code: 0, out: "" });

    expect(serviceCommand(["install"], h)).toBe(1);
    expect(said.at(-1)).toBe(`launchctl bootstrap gui/501 ${join(home, "Library", "LaunchAgents", `${LABEL}.plist`)} failed: Bootstrap failed: 5: Input/output error`);
  });
});

describe("the orchestrator as a systemd user unit on Linux", () => {
  it("given install where lingering is off, when it runs, then the unit is written, enabled and started, and it says how to keep it after logout", () => {
    const { h, calls, said, home } = host("linux");
    h.run = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return command === "loginctl" ? { code: 0, out: "Linger=no\n" } : { code: 0, out: "" };
    };

    expect(serviceCommand(["install"], h)).toBe(0);

    const unit = readFileSync(join(home, ".config", "systemd", "user", UNIT), "utf8");
    expect(unit).toContain(`ExecStart="${h.executable}" --env-file "${serviceEnvFile(home)}" --no-open`);
    expect(unit).not.toContain("Environment=");
    expect(unit).toContain("Restart=always");
    expect(readEnvFile(serviceEnvFile(home))).toEqual({ env: { PATH: "/opt/tools/bin:/usr/bin:/bin" } });
    expect(calls.slice(0, 3)).toEqual(["systemctl --user show-environment", "systemctl --user daemon-reload", `systemctl --user enable --now ${UNIT}`]);
    expect(said.at(-1)).toBe("it stops when you log out; to keep it running then: loginctl enable-linger");
  });

  it("given an installed unit, when status, restart and uninstall run, then each asks systemd for the user's unit and uninstall removes the file", () => {
    const { h, calls, said, home } = host("linux", { [`systemctl --user is-active ${UNIT}`]: { code: 0, out: "active\n" } });
    serviceCommand(["install"], h);
    calls.length = 0;

    expect(serviceCommand(["status"], h)).toBe(0);
    expect(said.at(-1)).toMatch(/^systemd user unit: active/);
    expect(serviceCommand(["restart"], h)).toBe(0);
    expect(serviceCommand(["uninstall"], h)).toBe(0);

    expect(calls).toEqual([`systemctl --user is-active ${UNIT}`, `systemctl --user restart ${UNIT}`, `systemctl --user disable --now ${UNIT}`, "systemctl --user daemon-reload"]);
    expect(existsSync(join(home, ".config", "systemd", "user", UNIT))).toBe(false);
  });
});

describe("the orchestrator as a service inside WSL", () => {
  it("given WSL without systemd, and a Linux without a user manager, when install runs, then each says what to do and writes no unit", () => {
    for (const wsl of [true, false]) {
      const { h, said, home } = host("linux", { "systemctl --user show-environment": { code: 1, out: "System has not been booted with systemd as init system (PID 1). Can't operate.\n" } });
      h.wsl = wsl;

      expect(serviceCommand(["install"], h)).toBe(1);

      expect(said.at(-1)).toBe(wsl ? "systemd does not run in this WSL distribution; add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown from Windows, then install again" : "no systemd user manager answers for this login (systemctl --user); run it in the foreground instead: handbook-orchestrator");
      expect(existsSync(join(home, ".config", "systemd", "user", UNIT))).toBe(false);
    }
  });
});

describe("the service's settings file", () => {
  it("given a service.env the person changed, when install runs again, then the file is kept as they left it", () => {
    const { h, said, home } = host("darwin");
    mkdirSync(join(home, ".handbook-orchestrator"));
    writeFileSync(serviceEnvFile(home), 'PATH="/their/bin:/usr/bin"\nORCHESTRATOR_PORT=18740\n', { mode: 0o600 });

    expect(serviceCommand(["install"], h)).toBe(0);

    expect(readFileSync(serviceEnvFile(home), "utf8")).toBe('PATH="/their/bin:/usr/bin"\nORCHESTRATOR_PORT=18740\n');
    expect(said[0]).toBe(`kept ${serviceEnvFile(home)}, the settings it starts with`);
  });

  it("given a service.env others on this machine can read, when install runs, then it refuses with the chmod that closes it and sets up nothing", () => {
    const { h, calls, said, home } = host("darwin");
    mkdirSync(join(home, ".handbook-orchestrator"));
    writeFileSync(serviceEnvFile(home), "PATH=/usr/bin\n");
    chmodSync(serviceEnvFile(home), 0o644);

    expect(serviceCommand(["install"], h)).toBe(1);

    expect(said.at(-1)).toBe(`others on this machine can reach ${serviceEnvFile(home)}; close it with: chmod 600 ${JSON.stringify(serviceEnvFile(home))}`);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("the service command's edges", () => {
  it("given Windows, an unknown action or an extra word, when it runs, then it refuses and touches nothing", () => {
    const windows = host("win32");
    const mac = host("darwin");

    expect(serviceCommand(["install"], windows.h)).toBe(1);
    expect(windows.said).toEqual(["a service is set up on macOS and Linux; on Windows, install and run it inside WSL"]);
    expect(serviceCommand(["start"], mac.h)).toBe(2);
    expect(serviceCommand(["install", "now"], mac.h)).toBe(2);
    expect(serviceCommand([], mac.h)).toBe(2);
    expect(mac.calls).toEqual([]);
  });

  it("given the executable inside an installed version, when the service's executable is named, then it goes through current, and one outside the install stays as it is", () => {
    const home = scratch();
    const version = join(home, ".handbook-orchestrator", "versions", "1.2.3");
    mkdirSync(version, { recursive: true });
    writeFileSync(join(version, "handbook-orchestrator"), "");
    chmodSync(join(version, "handbook-orchestrator"), 0o755);
    symlinkSync(join("versions", "1.2.3"), join(home, ".handbook-orchestrator", "current"));
    const elsewhere = join(home, "unpacked", "handbook-orchestrator");
    mkdirSync(join(home, "unpacked"));
    writeFileSync(elsewhere, "");

    expect(serviceExecutable(join(home, ".handbook-orchestrator", "current", "handbook-orchestrator"), home)).toBe(join(home, ".handbook-orchestrator", "current", "handbook-orchestrator"));
    expect(serviceExecutable(join(version, "handbook-orchestrator"), home)).toBe(join(home, ".handbook-orchestrator", "current", "handbook-orchestrator"));
    expect(serviceExecutable(elsewhere, home).endsWith(join("unpacked", "handbook-orchestrator"))).toBe(true);
  });

  it("given paths with characters the service files treat specially, when the files are written, then each is escaped for its format", () => {
    const odd = { executable: '/Users/a&b/<x>/"q"/handbook-orchestrator', home: "/Users/a&b%c" };

    expect(launchdPlist(odd)).toContain("<string>/Users/a&amp;b/&lt;x&gt;/&quot;q&quot;/handbook-orchestrator</string>");
    expect(launchdPlist(odd)).toContain("<string>/Users/a&amp;b%c/.handbook-orchestrator/service.env</string>");
    expect(systemdUnit(odd)).toContain('ExecStart="/Users/a&b/<x>/\\"q\\"/handbook-orchestrator" --env-file "/Users/a&b%%c/.handbook-orchestrator/service.env" --no-open');
  });
});

describe("a connected machine's runner as a service", () => {
  it("given install on macOS, when it runs, then a launchd agent of its own runs runner start with service.env beside the orchestrator's, and its log is its own", () => {
    // given
    const { h, calls, home } = host("darwin");

    // when
    const code = serviceCommand(["install"], h, RUNNER_SERVICE);

    // then
    expect(code).toBe(0);
    const file = join(home, "Library", "LaunchAgents", "com.teamhandbook.runner.plist");
    const plist = readFileSync(file, "utf8");
    expect(plist).toContain(`<array><string>${h.executable}</string><string>--env-file</string><string>${serviceEnvFile(home)}</string><string>runner</string><string>start</string></array>`);
    expect(plist).toContain(join(home, "Library", "Logs", "TeamHandbook Runner", "runner.log"));
    expect(calls).toEqual(["launchctl bootout gui/501/com.teamhandbook.runner", `launchctl bootstrap gui/501 ${file}`]);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${LABEL}.plist`))).toBe(false);
  });

  it("given install on Linux, when it runs, then its unit runs runner start and is not restarted once it exits for having no connection, which the orchestrator's unit does not hold back", () => {
    // given
    const { h, home } = host("linux");

    // when
    serviceCommand(["install"], h, RUNNER_SERVICE);

    // then
    const unit = readFileSync(join(home, ".config", "systemd", "user", "handbook-runner.service"), "utf8");
    expect(unit).toContain(`ExecStart="${h.executable}" --env-file "${serviceEnvFile(home)}" runner start`);
    expect(unit).toContain("RestartPreventExitStatus=78");
    expect(systemdUnit(h)).not.toContain("RestartPreventExitStatus");
  });

  it("given the runner and the orchestrator as services, when their files are written, then the runner is tried again every 30 seconds while a foreground runner holds the lock, and the orchestrator keeps the service manager's own pace", () => {
    // given
    const { h } = host("linux");

    // when
    const runnerUnit = systemdUnit(h, RUNNER_SERVICE);
    const runnerPlist = launchdPlist(h, RUNNER_SERVICE);

    // then
    expect(runnerUnit).toContain("RestartSec=30");
    expect(runnerPlist).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(systemdUnit(h)).toContain("RestartSec=2");
    expect(launchdPlist(h)).not.toContain("ThrottleInterval");
  });

  it("given no runner service, when its status or an unknown action is asked, then the answer names the runner's own command", () => {
    // given
    const { h, said } = host("darwin");

    // when
    const status = serviceCommand(["status"], h, RUNNER_SERVICE);
    const unknown = serviceCommand(["start"], h, RUNNER_SERVICE);

    // then
    expect([status, unknown]).toEqual([1, 2]);
    expect(said).toEqual(["not installed; handbook-orchestrator runner service install sets it up", "usage: handbook-orchestrator runner service install | status | restart | uninstall"]);
  });
});
