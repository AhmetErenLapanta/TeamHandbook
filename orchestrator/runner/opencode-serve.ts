import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import type { AgentTransport } from "../server/tasks/adapters/contract.js";
import type { OpencodeCall } from "../server/tasks/adapters/opencode.js";

/** How long OpenCode gets to say where it listens. */
export const LISTEN_TIMEOUT_MS = 30_000;
/** How long the event stream may stay quiet before it is opened again: OpenCode sends a heartbeat well inside it. */
export const SILENCE_MS = 45_000;
/** How long a stopped OpenCode gets before its group is killed. */
export const STOP_GRACE_MS = 5_000;

const LISTENING = /server listening on\s+(http:\/\/127\.0\.0\.1:\d{1,5})\/?\s*$/i;

/** Where each call the shared codec writes goes, as OpenCode 1.19's own server routes name them. */
export function routeOf(call: OpencodeCall): { method: "POST"; path: string; body: unknown } {
  const id = (key: string) => {
    const value = call.args[key];
    if (typeof value !== "string" || !/^[\w-]{1,200}$/.test(value)) throw new Error(`OpenCode call ${call.op} has no usable ${key}`);
    return value;
  };
  switch (call.op) {
    case "session.promptAsync":
      return { method: "POST", path: `/session/${id("sessionID")}/prompt_async`, body: { parts: call.args.parts } };
    case "session.abort":
      return { method: "POST", path: `/session/${id("sessionID")}/abort`, body: {} };
    case "permission.reply":
      return { method: "POST", path: `/permission/${id("requestID")}/reply`, body: { reply: call.args.reply, ...(typeof call.args.message === "string" ? { message: call.args.message } : {}) } };
    case "question.reply":
      return { method: "POST", path: `/question/${id("requestID")}/reply`, body: { answers: call.args.answers } };
    case "question.reject":
      return { method: "POST", path: `/question/${id("requestID")}/reject`, body: {} };
  }
}

/**
 * The environment OpenCode starts with: the person's, minus any server password of theirs, plus
 * this task's own. A repository's own `opencode.json` and `.opencode/` are never read, whatever
 * the caller passed: OpenCode merges them after the task's config, so a rule in the checkout would
 * win over the task's and run what the repository says without asking anyone.
 */
export function serveEnv(base: Record<string, string | undefined>, password: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== undefined && !/^OPENCODE_(SERVER_)?PASSWORD$/.test(e[0])));
  return { ...env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port on 127.0.0.1"))));
    });
  });
}

export type Spawner = (program: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcess;

const defaultSpawn: Spawner = (program, args, { cwd, env }) => nodeSpawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });

/** One task's own OpenCode server, on 127.0.0.1 and behind a password that exists for this task only. */
export interface OpencodeServe {
  readonly url: string;
  readonly pgid: number | null;
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  createSession(permission: unknown): Promise<string>;
  /** The transport a session of the shared codec runs over: the event stream in, its calls out. */
  transport(): AgentTransport;
  stop(): void;
  readonly exit: Promise<number | null>;
}

export async function startOpencodeServe({ program, cwd, env, spawn = defaultSpawn, silenceMs = SILENCE_MS }: { program: string; cwd: string; env: Record<string, string | undefined>; spawn?: Spawner; silenceMs?: number }): Promise<OpencodeServe> {
  const password = randomBytes(32).toString("base64url");
  const port = await freePort();
  const child = spawn(program, ["serve", "--hostname=127.0.0.1", `--port=${port}`], { cwd, env: serveEnv(env, password) });
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode did not say where it listens within ${LISTEN_TIMEOUT_MS / 1000} seconds`)), LISTEN_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      const match = LISTENING.exec(line.trim());
      if (!match) return;
      clearTimeout(timer);
      lines.close();
      // Only the port asked for is taken: an address elsewhere would get this task's password.
      if (match[1] !== `http://127.0.0.1:${port}`) reject(new Error("OpenCode listens somewhere other than the address it was given"));
      else resolve(match[1]);
    });
    void exit.then((code) => {
      clearTimeout(timer);
      reject(new Error(`OpenCode stopped before it listened (exit code ${code ?? "none"})`));
    });
  }).catch((error: Error) => {
    stopGroup(child);
    throw error;
  });
  // Its output is read no further, and a pipe nobody reads fills until OpenCode blocks writing to it.
  child.stdout?.resume();
  child.stderr?.resume();

  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, { method, redirect: "error", headers: { authorization: auth, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`OpenCode answered ${method} ${path.split("/")[1]} with ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as unknown) : null;
  };

  return {
    url,
    pgid: child.pid ?? null,
    request,
    async createSession(permission) {
      const created = (await request("POST", "/session", { permission })) as { id?: unknown } | null;
      if (typeof created?.id !== "string") throw new Error("OpenCode made no session");
      return created.id;
    },
    transport: () => serveTransport(url, auth, request, () => stopGroup(child), exit, silenceMs),
    stop: () => stopGroup(child),
    exit,
  };
}

function stopGroup(child: ChildProcess): void {
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      child.kill(name);
    }
  };
  if (child.exitCode !== null) return;
  signal("SIGTERM");
  setTimeout(() => child.exitCode === null && signal("SIGKILL"), STOP_GRACE_MS).unref();
}

function serveTransport(url: string, auth: string, request: OpencodeServe["request"], stop: () => void, exit: Promise<number | null>, silenceMs: number): AgentTransport {
  const ended = new AbortController();
  void exit.then(() => ended.abort());
  // An event sent while no stream is open reaches nobody, so no call goes before the first stream does.
  let connect: () => void = () => {};
  let calls = new Promise<void>((resolve) => (connect = resolve));

  async function* events(): AsyncGenerator<string> {
    while (!ended.signal.aborted) {
      const quiet = new AbortController();
      const stopQuiet = () => quiet.abort();
      ended.signal.addEventListener("abort", stopQuiet, { once: true });
      let timer = setTimeout(stopQuiet, silenceMs);
      try {
        const response = await fetch(`${url}/event`, { headers: { authorization: auth, accept: "text/event-stream" }, redirect: "error", signal: quiet.signal });
        if (!response.ok || !response.body) throw new Error(`OpenCode's event stream answered ${response.status}`);
        connect();
        let buffer = "";
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(timer);
          timer = setTimeout(stopQuiet, silenceMs);
          buffer += Buffer.from(chunk).toString("utf8");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (data) yield data;
          }
        }
      } catch {
        if (ended.signal.aborted) return;
      } finally {
        clearTimeout(timer);
        ended.signal.removeEventListener("abort", stopQuiet);
      }
    }
  }

  return {
    lines: events(),
    write(line) {
      const call = JSON.parse(line) as OpencodeCall;
      const { method, path, body } = routeOf(call);
      // One call at a time, in the order the session wrote them; a failed one does not hold up the next.
      calls = calls.then(() => request(method, path, body)).then(
        () => undefined,
        () => undefined,
      );
    },
    end() {
      void calls.finally(stop);
    },
    kill() {
      ended.abort();
      stop();
    },
    exit,
  };
}
