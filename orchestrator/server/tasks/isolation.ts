import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Where one task lives on disk. The checkout the agent edits, the agent's HOME and its temp
 * directory sit under the task's root, which is all a task container mounts; the agent's
 * config never shows up in the diff because HOME is not inside the checkout. The git
 * directory the orchestrator reads the result through lives outside that root: a `core.fsmonitor`
 * or filter written into it would run in the orchestrator's own process, with the orchestrator's whole
 * environment, the next time it reads the checkout.
 */
export interface TaskPaths {
  root: string;
  work: string;
  home: string;
  tmp: string;
  git: string;
}

export function taskPaths(dataDir: string, tenant: string, id: string): TaskPaths {
  const root = join(dataDir, "tasks", tenant, id);
  return { root, work: join(root, "work"), home: join(root, "home"), tmp: join(root, "tmp"), git: join(dataDir, "task-git", tenant, id) };
}

export async function makeTaskDirs(paths: TaskPaths): Promise<void> {
  await Promise.all([paths.work, paths.home, paths.tmp, paths.git].map((dir) => mkdir(dir, { recursive: true })));
}

/** Host variables a task inherits by name. Everything else the orchestrator's process holds stays behind. */
export const BASE_ENV = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"];

/**
 * The whole environment a task's processes see: a few host basics, a HOME and temp directory
 * of the task's own, and the named variables the caller passes on (an agent's model
 * credential, nothing else). The orchestrator's own settings - its secret key, a forge token, a
 * database URL - are never among them, because nothing is inherited that is not named.
 */
export function taskEnv(host: Record<string, string | undefined>, paths: TaskPaths, pass: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...BASE_ENV, ...pass]) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    HOME: paths.home,
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    XDG_CACHE_HOME: join(paths.home, ".cache"),
    XDG_STATE_HOME: join(paths.home, ".local", "state"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    CI: "1",
  };
}

export interface Invocation {
  program: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin?: string;
}

export type Network = "open" | "none";

/**
 * How a task's processes are contained. `process` runs them as the orchestrator's own OS user
 * with the stripped environment above: it keeps the orchestrator's settings and the host
 * account's config away from the agent, and it is not a sandbox - the agent can read any
 * file that user can. `container` runs each one in a fresh container on the host's Docker,
 * which needs the Docker socket and is off unless an operator turns it on.
 */
export type IsolationConfig =
  | { mode: "process"; network: Network }
  | { mode: "container"; network: Network; image: string; dataDir: string; volume?: string; user?: string };

/** Why this isolation cannot run a task as configured, or null when it can. */
export function isolationProblem(isolation: IsolationConfig): string | null {
  if (isolation.mode === "process" && isolation.network === "none") {
    return "Network access is set to none, which only container isolation enforces; the task was not started.";
  }
  return null;
}

/**
 * The docker command that runs an invocation in a container. Only the task's own root is
 * mounted - never the git directory beside it - at the same path, so every path the orchestrator computed still holds inside. The
 * environment travels by name (`-e NAME`): docker reads each value from its own environment,
 * so a credential never appears in the command line another user on the host can list.
 */
/** The host variables that say which Docker daemon the CLI talks to and how: a socket proxy's address and its TLS. */
export const DOCKER_ENV = ["DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];

/** The part of the host environment every docker command of the orchestrator runs with, so each reaches the same daemon. */
export function dockerEnv(host: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(DOCKER_ENV.flatMap((name) => (host[name] ? [[name, host[name]!]] : [])));
}

/** Where the egress shim listens inside a container: the address its program is told to use as a proxy. */
export const EGRESS_PORT = 3128;

/**
 * The entrypoint of a container held to an allow list. The container has no network; this
 * listens on its own loopback and hands every connection to the orchestrator's egress proxy over the
 * socket mounted from the task's directory, then starts the real program with that address as its
 * proxy. A program that ignores the proxy reaches nothing: there is no other way out.
 */
export const EGRESS_SHIM = [
  'import { connect, createServer } from "node:net";',
  'import { spawn } from "node:child_process";',
  "const [socket, program, ...args] = process.argv.slice(2);",
  `const port = Number(process.env.TH_EGRESS_PORT) || ${EGRESS_PORT};`,
  "const server = createServer((c) => {",
  "  const u = connect(socket);",
  "  c.pipe(u);",
  "  u.pipe(c);",
  '  c.on("error", () => u.destroy());',
  '  u.on("error", () => c.destroy());',
  "});",
  'server.listen(port, "127.0.0.1", () => {',
  '  const proxy = `http://127.0.0.1:${port}`;',
  '  const child = spawn(program, args, { stdio: "inherit", env: { ...process.env, HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "", no_proxy: "" } });',
  '  child.on("exit", (code, signal) => { server.close(); process.exit(code ?? (signal ? 1 : 0)); });',
  '  child.on("error", () => process.exit(127));',
  '  for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => child.kill(s));',
  "});",
  "",
].join("\n");

export function containerInvocation(
  inv: Invocation,
  paths: TaskPaths,
  isolation: Extract<IsolationConfig, { mode: "container" }>,
  name: string,
  host: Record<string, string | undefined> = process.env,
  egress: { shim: string; socket: string } | null = null,
): Invocation {
  const mount = isolation.volume
    ? `type=volume,src=${isolation.volume},dst=${paths.root},volume-subpath=${relative(isolation.dataDir, paths.root)}`
    : `type=bind,src=${paths.root},dst=${paths.root}`;
  const args = [
    "run", "--rm", "--init", "--name", name,
    "--network", egress || isolation.network === "none" ? "none" : "bridge",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
    "--mount", mount, "-w", inv.cwd,
    ...(isolation.user ? ["--user", isolation.user] : []),
    ...(inv.stdin !== undefined ? ["-i"] : []),
    // The image keeps its own PATH; the host's names programs that are not in it.
    ...Object.keys(inv.env).filter((key) => key !== "PATH").sort().flatMap((key) => ["-e", key]),
    // The image's own entrypoint would start something else; the agent is the entrypoint.
    ...(egress ? ["--entrypoint", "node", isolation.image, egress.shim, egress.socket, inv.program, ...inv.args] : ["--entrypoint", inv.program, isolation.image, ...inv.args]),
  ];
  const docker = { ...inv.env, ...dockerEnv(host) };
  return { program: "docker", args, env: docker, cwd: inv.cwd, ...(inv.stdin !== undefined ? { stdin: inv.stdin } : {}) };
}

export interface RunOutcome {
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stdout: string;
}

export interface RunOptions {
  timeoutMs: number;
  signal: AbortSignal;
  onLine: (stream: "stdout" | "stderr", line: string) => void;
  /** Runs after the process group is signalled; a container needs its own removal. */
  onKill?: () => void;
  /** Told the process group as soon as the process starts, so it can be recorded. */
  onSpawn?: (pgid: number) => void;
  /** The most of stdout kept for the adapter's report; the default suits a long agent run. */
  maxStdout?: number;
}

const MAX_STDOUT = 16 * 1024 * 1024;
const KILL_GRACE_MS = 3000;

/**
 * Runs one invocation in a process group of its own and ends the whole group on timeout or
 * cancel. An agent starts servers, test runners and shells; killing only the direct child
 * would leave those running with the task's credentials after the task says it stopped.
 */
export function runProcess(inv: Invocation, options: RunOptions): Promise<RunOutcome> {
  const started = startProcess(inv, options);
  started.end(inv.stdin ?? "");
  return started.outcome;
}

/** A process started with its input left open: written a line at a time, and closed by the caller. */
export interface StartedProcess {
  readonly outcome: Promise<RunOutcome>;
  write(text: string): void;
  end(last?: string): void;
  /** Ends the whole group now, as a cancel does. */
  kill(): void;
}

/** `runProcess` with stdin kept open, for an agent that is told more while it works. */
export function startProcess(inv: Invocation, options: RunOptions): StartedProcess {
  let write: (text: string) => void = () => {};
  let end: (last?: string) => void = () => {};
  let kill: () => void = () => {};
  const outcome = new Promise<RunOutcome>((resolve) => {
    const child = spawn(inv.program, inv.args, { cwd: inv.cwd, env: inv.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    // detached makes the child the leader of its own group: its pid is the group's id.
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    // The report an adapter reads - the result line, its cost - comes last, so past the cap
    // the start is kept and the end rolls: an agent that printed more than the cap still
    // finishes as it reported instead of failing for a result line that was dropped.
    const max = options.maxStdout ?? MAX_STDOUT;
    const tailMax = Math.ceil(max / 16);
    let stdout = "";
    let tail = "";
    let dropped = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const pending = { stdout: "", stderr: "" };

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // the group is already gone
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      options.onKill?.();
      setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });

    const feed = (stream: "stdout" | "stderr", chunk: string) => {
      if (stream === "stdout") {
        // A chunk is split where the start's room ends, so one large chunk cannot carry the start past its share.
        const room = Math.max(0, max - tailMax - stdout.length);
        stdout += chunk.slice(0, room);
        const rest = chunk.slice(room);
        dropped = dropped || tail.length + rest.length > tailMax;
        tail = (tail + rest).slice(-tailMax);
      }
      const lines = (pending[stream] + chunk).split("\n");
      pending[stream] = lines.pop()!;
      for (const line of lines) options.onLine(stream, line.replace(/\r$/, ""));
    };
    child.stdout.setEncoding("utf8").on("data", (c: string) => feed("stdout", c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => feed("stderr", c));
    // A write after the agent closed its input, or after it exited, is dropped: it has nobody to read it.
    child.stdin.on("error", () => {});
    write = (text) => {
      if (child.stdin.writable) child.stdin.write(text);
    };
    end = (last) => {
      if (child.stdin.writable) child.stdin.end(last ?? "");
    };
    kill = onAbort;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      for (const stream of ["stdout", "stderr"] as const) if (pending[stream]) options.onLine(stream, pending[stream]);
      // Whatever the agent left running in its group goes with it, even on a clean exit.
      killGroup("SIGKILL");
      resolve({ code, timedOut, cancelled, stdout: dropped ? `${stdout}\n${tail.slice(tail.indexOf("\n") + 1)}` : stdout + tail });
    };
    child.on("error", (err) => {
      options.onLine("stderr", `${inv.program} did not start: ${err.message}`);
      finish(null);
    });
    // A grandchild that inherited the pipes keeps them open after the agent exits, and the
    // close event waits for the pipes; ending the group on exit lets close arrive.
    child.on("exit", () => killGroup("SIGKILL"));
    child.on("close", (code) => finish(code));
  });
  return { outcome, write: (text) => write(text), end: (last) => end(last), kill: () => kill() };
}
