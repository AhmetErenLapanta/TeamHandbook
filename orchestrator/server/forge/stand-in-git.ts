import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * git's smart HTTP on this machine, as git http-backend serves it, with no sign-in asked: pushes
 * and fetches of the repositories under `root`, for a test that needs a forge's git and no more.
 * Each server started is kept in `servers` for the test to close.
 */
export async function plainGitServer(root: string, servers: Server[]): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "stand-in",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""),
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: String(req.headers["content-length"]) } : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const text = head.toString("latin1");
      const end = text.search(/\r?\n\r?\n/);
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of text.slice(0, end).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        if (line.slice(0, at).toLowerCase() === "status") status = Number(line.slice(at + 1).trim().split(" ")[0]) || 200;
        else headers[line.slice(0, at)] = line.slice(at + 1).trim();
      }
      started = true;
      res.writeHead(status, headers);
      res.write(head.subarray(end + (text.slice(end).startsWith("\r\n\r\n") ? 4 : 2)));
    });
    child.stdout.on("end", () => res.end());
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
