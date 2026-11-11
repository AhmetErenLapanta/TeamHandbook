import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../server/cli.js";
import { connectCommand } from "../shared/runner-command.js";
import { ALREADY_RUNNING_EXIT, NOT_CONNECTED_EXIT, RUNNER_USAGE, runnerCommand } from "./cli.js";
import { machineKey, saveProfile } from "./profile.js";
import { RUNNER_SERVICE, serviceCommand } from "../server/service.js";
import type { ServiceHost } from "../server/service.js";

describe("the runner's command line", () => {
  let dataDir: string;
  let out: string[];
  let err: string[];
  const io = () => ({ dataDir, out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), name: "max-laptop", platform: "darwin-arm64" });
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "runner-cli-"));
    out = [];
    err = [];
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("given the command Settings prints, when the orchestrator's command line reads it, then it reaches the runner with its address and code", () => {
    const printed = connectCommand("https://orchestrator.example.invalid/api/orgs/acme", "ABCD-EFGH-JKMN").split(" ");

    expect(parseCli(printed.slice(1), "1.2.3")).toEqual({ env: {}, args: ["runner", "connect", "https://orchestrator.example.invalid/api/orgs/acme", "ABCD-EFGH-JKMN"] });
  });

  it("given an address that would send the machine's token in the clear, when it connects, then it is refused with the reason and nothing is kept", async () => {
    const code = await runnerCommand(["connect", "http://orchestrator.example.invalid", "ABCD-EFGH-JKMN"], io());

    expect(code).toBe(1);
    expect(err.join("")).toMatch(/only over https/);
    await runnerCommand(["status"], io());
    expect(out.join("")).toMatch(/not connected to any orchestrator/);
  });

  it("given a machine connected to an orchestrator that cannot be reached, when it disconnects, then it forgets the connection and says to remove the machine under Settings", async () => {
    saveProfile(dataDir, { address: "https://orchestrator.example.invalid/api/orgs/acme", org: "acme", machineId: "mch_1", token: "hr_x", privateKey: machineKey().privateKey });

    await runnerCommand(["status"], io());
    const left = await runnerCommand(["disconnect", "acme"], { ...io(), fetch: async () => Promise.reject(new Error("offline")) });
    await runnerCommand(["status"], io());

    expect(out[0]).toBe("acme  https://orchestrator.example.invalid/api/orgs/acme  machine mch_1\n");
    expect(left).toBe(0);
    expect(out[1]).toMatch(/did not answer; remove it under Settings/);
    expect(out.at(-1)).toMatch(/not connected to any orchestrator/);
  });

  it("given the runner service installed and two connections, when the machine disconnects from one and then the other, then the service stays for the one left and goes with the last", async () => {
    // given
    const calls: string[] = [];
    const service: ServiceHost = { platform: "darwin", home: dataDir, uid: 501, executable: join(dataDir, "handbook-orchestrator"), path: "/usr/bin:/bin", run: (command, args) => (calls.push(`${command} ${args.join(" ")}`), { code: 0, out: "" }), say: () => {} };
    serviceCommand(["install"], service, RUNNER_SERVICE);
    for (const org of ["acme", "globex"]) saveProfile(dataDir, { address: `https://orchestrator.example.invalid/api/orgs/${org}`, org, machineId: `mch_${org}`, token: "hr_x", privateKey: machineKey().privateKey });
    const offline = async () => Promise.reject(new Error("offline"));
    calls.length = 0;

    // when
    await runnerCommand(["disconnect", "acme"], { ...io(), fetch: offline, service });
    const afterFirst = [...calls];
    await runnerCommand(["disconnect", "globex"], { ...io(), fetch: offline, service });

    // then
    expect(afterFirst).toEqual([]);
    expect(calls).toEqual(["launchctl bootout gui/501/com.teamhandbook.runner"]);
    expect(existsSync(join(dataDir, "Library", "LaunchAgents", "com.teamhandbook.runner.plist"))).toBe(false);
  });

  it("given a machine connected to nothing, when the runner service is installed, then it is refused with the connect command first and no service is written", async () => {
    // given
    const calls: string[] = [];
    const service: ServiceHost = { platform: "darwin", home: dataDir, uid: 501, executable: join(dataDir, "handbook-orchestrator"), path: "/usr/bin:/bin", run: (command, args) => (calls.push(`${command} ${args.join(" ")}`), { code: 0, out: "" }), say: () => {} };

    // when
    const code = await runnerCommand(["service", "install"], { ...io(), service });

    // then
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/connect it first \(runner connect\), then install the service/);
    expect(calls).toEqual([]);
  });

  it("given the package's command, which has no service manager to reach, when the runner service is asked for, then it says to install the executable and sets nothing up", async () => {
    // when
    const code = await runnerCommand(["service", "status"], io());

    // then
    expect(code).toBe(1);
    expect(err.join("")).toMatch(/a service runs the installed executable/);
  });

  it("given a name that would reach outside the machine's folders, when it disconnects, then it is refused and nothing is removed", async () => {
    saveProfile(dataDir, { address: "https://orchestrator.example.invalid", org: "acme", machineId: "mch_1", token: "hr_x", privateKey: "unused" });

    expect(await runnerCommand(["disconnect", "../.."], io())).toBe(2);
    expect(err.at(-1)).toMatch(/not an organization's short name/);
    await runnerCommand(["status"], io());

    expect(out.at(-1)).toMatch(/^acme /);
  });

  it("given a machine paired with nothing, or a start already running for its organization, when start is run, then it ends with the code a service manager tells apart", async () => {
    expect(await runnerCommand(["start"], io())).toBe(NOT_CONNECTED_EXIT);
    saveProfile(dataDir, { address: "https://orchestrator.example.invalid", org: "acme", machineId: "mch_1", token: "hr_x", privateKey: "unused" });
    writeFileSync(join(dataDir, "runner", "machines", "acme", "runner.lock"), String(process.ppid));

    expect(await runnerCommand(["start"], io())).toBe(ALREADY_RUNNING_EXIT);
    expect(err.at(-1)).toMatch(/already runs tasks for acme/);
  });

  it("given anything else, when it is run, then the usage is printed and it ends with 2", async () => {
    expect(await runnerCommand(["connect", "only-one"], io())).toBe(2);
    expect(await runnerCommand(["teleport"], io())).toBe(2);
    expect(err.at(-1)).toBe(RUNNER_USAGE);
  });
});
