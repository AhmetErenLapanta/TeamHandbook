import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

/**
 * A stand-in MCP Registry: the official registry's read API over a few servers the lab made up,
 * one for each way the orchestrator judges an entry. It lists servers at `/v0/servers` and answers
 * one at `/v0/servers/<name>/versions/latest`; every request it gets is kept for a test to read
 * at `/lab/calls`, so a scenario sees whether the orchestrator asked again or answered from its cache.
 */

export interface RegistryConfig {
  port: number;
  log: string;
}

interface Entry {
  name: string;
  description: string;
  version: string;
  repository?: { url: string };
  remotes?: { type: string; url: string }[];
  packages?: { registryType: string; identifier: string; version?: string }[];
}

export const REGISTRY_SERVERS: Entry[] = [
  { name: "io.github.lab-org/tracker", description: "Reads the lab's issues.", version: "1.2.0", repository: { url: "https://github.com/lab-org/tracker" }, remotes: [{ type: "streamable-http", url: "https://tracker.example.invalid/mcp" }] },
  { name: "io.github.lab-org/notes", description: "Keeps the lab's notes.", version: "0.4.1", repository: { url: "https://github.com/lab-org/notes" }, packages: [{ registryType: "npm", identifier: "@lab-org/notes-mcp", version: "0.4.1" }] },
  { name: "io.github.lab-org/impostor", description: "Claims the lab's namespace from another owner's repository.", version: "1.0.0", repository: { url: "https://github.com/someone-else/impostor" }, remotes: [{ type: "streamable-http", url: "https://impostor.example.invalid/mcp" }] },
  { name: "io.github.lab-org/floating", description: "Offers its package at whatever was published last.", version: "2.0.0", repository: { url: "https://github.com/lab-org/floating" }, packages: [{ registryType: "npm", identifier: "@lab-org/floating-mcp", version: "latest" }] },
];

export function startRegistry(config: RegistryConfig): Promise<void> {
  const calls: string[] = [];
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.port}`);
    appendFileSync(config.log, `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}\n`);
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (url.pathname === "/lab/calls") return json(res, 200, { calls });
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v0/servers") {
      const words = (url.searchParams.get("search") ?? "").toLowerCase();
      const found = REGISTRY_SERVERS.filter((s) => !words || s.name.toLowerCase().includes(words) || s.description.toLowerCase().includes(words));
      return json(res, 200, { servers: found.map((server) => ({ server })), metadata: { nextCursor: null, count: found.length } });
    }
    const one = /^\/v0\/servers\/(.+)\/versions\/latest$/.exec(url.pathname);
    if (one) {
      const server = REGISTRY_SERVERS.find((s) => s.name === decodeURIComponent(one[1]!));
      return server ? json(res, 200, { server }) : json(res, 404, { error: "not found" });
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => server.listen(config.port, "127.0.0.1", () => resolve()));
}

/** Run as `lab.mjs registry <config.json>`: the stand-in lives until down.sh stops it. */
export async function registryMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as RegistryConfig;
  await startRegistry(config);
  appendFileSync(config.log, `registry listening on 127.0.0.1:${config.port}\n`);
}
