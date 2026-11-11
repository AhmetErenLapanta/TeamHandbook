import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_ENV, containerInvocation, isolationProblem, makeTaskDirs, runProcess, taskEnv, taskPaths } from "./isolation.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-isolation-"));
  dirs.push(root);
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

// An agent that starts a long-lived child of its own, writes that child's pid down, and never exits.
function spawningAgent(root: string): string {
  const script = join(root, "spawner.mjs");
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2], String(child.pid));
console.log("started");
setInterval(() => {}, 1000);
`,
  );
  return script;
}

async function grandchildPid(file: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    try {
      const pid = Number(readFileSync(file, "utf8"));
      if (pid) return pid;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the agent never started its child");
}

describe("a task's environment", () => {
  it("given a host holding the orchestrator's own secrets, when a task's environment is built, then only the basics, the task's own directories and the named credentials cross", () => {
    // given
    const paths = taskPaths("/srv/orchestrator", "acme", "0123456789ab");
    const host = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: "/home/orchestrator",
      ORCHESTRATOR_SECRET_KEY: "k".repeat(32),
      GITLAB_TOKEN: "glpat-aaaaaaaaaaaaaaaaaaaa",
      AWS_SECRET_ACCESS_KEY: "a".repeat(40),
      ANTHROPIC_API_KEY: "sk-ant-test-value",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    };

    // when
    const env = taskEnv(host, paths, ["ANTHROPIC_API_KEY"]);

    // then
    expect(env.HOME).toBe(paths.home);
    expect(env.TMPDIR).toBe(paths.tmp);
    expect(env.XDG_CONFIG_HOME).toBe(join(paths.home, ".config"));
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-value");
    for (const name of ["ORCHESTRATOR_SECRET_KEY", "GITLAB_TOKEN", "AWS_SECRET_ACCESS_KEY", "SSH_AUTH_SOCK"]) expect(env).not.toHaveProperty(name);
    const inherited = Object.keys(env).filter((k) => host[k as keyof typeof host] !== undefined && env[k] === host[k as keyof typeof host]);
    expect(inherited.sort()).toEqual(["ANTHROPIC_API_KEY", ...BASE_ENV.filter((n) => n in host)].sort());
  });

  it("given the task's own paths, when they are laid out, then the checkout, HOME and temp directory are siblings under the root and the git directory is outside it", () => {
    // given
    const paths = taskPaths("/srv/orchestrator", "acme", "0123456789ab");

    // then
    const inside = [paths.work, paths.home, paths.tmp];
    for (const a of inside) expect(a.startsWith(paths.root + "/")).toBe(true);
    for (const a of inside) for (const b of inside) if (a !== b) expect(a.startsWith(b + "/")).toBe(false);
    expect(paths.git.startsWith(paths.root + "/")).toBe(false);
    expect(paths.root.startsWith(paths.git + "/")).toBe(false);
  });
});

describe("running a task's process", () => {
  it("given an agent that started a child of its own, when its time limit passes, then the agent and its child are both stopped", async () => {
    // given
    const root = scratch();
    const pidFile = join(root, "child.pid");
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);

    // when
    const outcome = await runProcess(
      { program: process.execPath, args: [spawningAgent(root), pidFile], env: taskEnv(process.env, paths), cwd: paths.work },
      { timeoutMs: 1500, signal: new AbortController().signal, onLine: () => {} },
    );

    // then
    expect(outcome.timedOut).toBe(true);
    expect(await gone(await grandchildPid(pidFile))).toBe(true);
  });

  it("given a running agent with a child of its own, when the task is cancelled, then both are stopped and the outcome says cancelled", async () => {
    // given
    const root = scratch();
    const pidFile = join(root, "child.pid");
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    const controller = new AbortController();
    const lines: string[] = [];

    // when
    const running = runProcess(
      { program: process.execPath, args: [spawningAgent(root), pidFile], env: taskEnv(process.env, paths), cwd: paths.work },
      { timeoutMs: 60_000, signal: controller.signal, onLine: (_s, line) => lines.push(line) },
    );
    const child = await grandchildPid(pidFile);
    controller.abort();
    const outcome = await running;

    // then
    expect(outcome.cancelled).toBe(true);
    expect(outcome.timedOut).toBe(false);
    expect(lines).toContain("started");
    expect(await gone(child)).toBe(true);
  });

  // One write arrives in chunks far larger than the start's room; a write per line arrives in
  // chunks of whatever size the pipe hands over. The cap holds either way, by construction:
  // the start's share, one joining newline, and the end's share.
  it.each([
    ["one write", `process.stdout.write(lines.join("\\n") + "\\n" + result + "\\n");`],
    ["a write per line", `for (const line of [...lines, result]) console.log(line);`],
  ])("given an agent whose output passes the kept size in %s, when it ends with its result, then the start and the result line are kept within the cap", async (_case, writes) => {
    // given
    const root = scratch();
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    const talkative = `const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ type: "log", text: "line " + (i + 1) }));\nconst result = JSON.stringify({ type: "result", summary: "done" });\n${writes}`;
    const cap = 16_000;

    // when
    const outcome = await runProcess(
      { program: process.execPath, args: ["-e", talkative], env: taskEnv(process.env, paths), cwd: paths.work },
      { timeoutMs: 20_000, signal: new AbortController().signal, onLine: () => {}, maxStdout: cap },
    );

    // then
    expect(outcome.stdout.length).toBeLessThanOrEqual(cap + 1);
    expect(outcome.stdout.startsWith('{"type":"log","text":"line 1"}')).toBe(true);
    expect(outcome.stdout.trimEnd().split("\n").at(-1)).toBe('{"type":"result","summary":"done"}');
  });
});

describe("container isolation", () => {
  const paths = taskPaths("/data", "acme", "0123456789ab");
  const inv = { program: "claude", args: ["-p"], env: { PATH: "/usr/bin", HOME: paths.home, ANTHROPIC_API_KEY: "sk-ant-value-never-in-argv" }, cwd: paths.work, stdin: "do it" };

  it("given a credential in the environment, when the docker command is built, then the value travels by name only and the network is off when asked", () => {
    // when
    const docker = containerInvocation(inv, paths, { mode: "container", network: "none", image: "agents:1", dataDir: "/data", volume: "orchestrator-data" }, "teamhandbook-task-acme-0123456789ab");

    // then
    expect(docker.program).toBe("docker");
    expect(docker.args.join(" ")).not.toContain("sk-ant-value-never-in-argv");
    expect(docker.args).toEqual(expect.arrayContaining(["-e", "ANTHROPIC_API_KEY", "--network", "none", "--cap-drop", "ALL", "-i"]));
    expect(docker.args).not.toContain("PATH");
    expect(docker.args).toContain(`type=volume,src=orchestrator-data,dst=${paths.root},volume-subpath=tasks/acme/0123456789ab`);
    expect(docker.env.ANTHROPIC_API_KEY).toBe("sk-ant-value-never-in-argv");
    expect(docker.args.slice(-4)).toEqual(["--entrypoint", "claude", "agents:1", "-p"]);
    const mounts = docker.args.filter((_, i) => docker.args[i - 1] === "--mount");
    expect(mounts).toHaveLength(1);
    expect(mounts.every((m) => !paths.git.startsWith(m.match(/dst=([^,]+)/)![1]! + "/"))).toBe(true);
  });

  it("given a socket proxy named in the host's environment, when the docker command is built, then docker reaches that daemon and the container does not see its address", () => {
    // when
    const docker = containerInvocation(inv, paths, { mode: "container", network: "open", image: "agents:1", dataDir: "/data" }, "teamhandbook-task-acme-0123456789ab", {
      DOCKER_HOST: "tcp://socket-proxy.invalid:2376",
      DOCKER_TLS_VERIFY: "1",
      ORCHESTRATOR_SECRET_KEY: "k".repeat(32),
    });

    // then
    expect(docker.env).toMatchObject({ DOCKER_HOST: "tcp://socket-proxy.invalid:2376", DOCKER_TLS_VERIFY: "1" });
    expect(docker.env).not.toHaveProperty("ORCHESTRATOR_SECRET_KEY");
    expect(docker.args).not.toContain("DOCKER_HOST");
  });

  it("given process isolation, when network access is set to none, then the configuration is refused rather than run with the network on", () => {
    expect(isolationProblem({ mode: "process", network: "none" })).toMatch(/only container isolation enforces/);
    expect(isolationProblem({ mode: "process", network: "open" })).toBeNull();
    expect(isolationProblem({ mode: "container", network: "none", image: "x", dataDir: "/data" })).toBeNull();
  });
});
