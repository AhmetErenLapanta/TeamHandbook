import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import type { Spawner } from "./opencode-serve.js";

export interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

/**
 * A stand-in for `opencode serve`: a process that starts an HTTP server on the port it was told,
 * says so on stdout, and answers with the password from its environment. No real OpenCode runs.
 */
export function standIn(handle: (req: IncomingMessage, res: ServerResponse, seen: Seen) => boolean = () => false, say?: (port: number) => string) {
  const seen: Seen[] = [];
  const env: Record<string, string>[] = [];
  let server: Server | null = null;
  const spawn: Spawner = (_program, args, options) => {
    env.push(options.env);
    const port = Number(args.find((a) => a.startsWith("--port="))!.slice(7));
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, exitCode: null as number | null }) as unknown as ChildProcess;
    const expected = `Basic ${Buffer.from(`opencode:${options.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    (child as unknown as { kill: () => boolean }).kill = () => {
      server?.closeAllConnections();
      server?.close();
      (child as { exitCode: number | null }).exitCode = 0;
      child.emit("exit", 0);
      return true;
    };
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const entry = { method: req.method!, path: req.url!, auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as unknown) : null };
        seen.push(entry);
        if (req.headers.authorization !== expected) return void res.writeHead(401).end();
        if (handle(req, res, entry)) return;
        if (req.url === "/session") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_1" }));
        res.writeHead(200).end("true");
      });
    });
    server.listen(port, "127.0.0.1", () => (child.stdout as PassThrough).write(`${say ? say(port) : `opencode server listening on http://127.0.0.1:${port}`}\n`));
    return child;
  };
  return { spawn, seen, env, close: () => server?.close() };
}

