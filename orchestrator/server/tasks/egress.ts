import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { BlockList, connect, isIP } from "node:net";
import type { Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EGRESS_SHIM } from "./isolation.js";
import type { TaskPaths } from "./isolation.js";

/** Addresses no allow list reaches: this machine, private networks, link-local (a cloud's metadata service), multicast and the unspecified ones. */
const INTERNAL = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) INTERNAL.addSubnet(net, bits, "ipv4");
// NAT64's prefix leads to an IPv4 address of the translator's choosing, so it is inside as a whole.
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) INTERNAL.addSubnet(net, bits, "ipv6");

/** The IPv4 address an IPv6 address carries in IPv4-mapped form, dotted or in hexadecimal; null for any other. */
function mappedIpv4(address: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (dotted) return dotted;
  const hex = /^(?:0{1,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const [high, low] = [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16)];
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/**
 * What stays out of reach even for an orchestrator one person runs on their own machine: link-local
 * addresses (a cloud's metadata service among them), multicast, the unspecified ones and NAT64,
 * which leads where a translator chooses. A private network and this machine are that person's own.
 */
const NEVER = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["169.254.0.0", 16], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NEVER.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["64:ff9b::", 96], ["fe80::", 10], ["ff00::", 8]] as const) NEVER.addSubnet(net, bits, "ipv6");

/** Whether an address is one a person's own orchestrator may reach on their network: anything but link-local, multicast, unspecified and NAT64. */
export function ownNetworkAddress(address: string): boolean {
  const plain = mappedIpv4(address) ?? address;
  const family = isIP(plain);
  return family !== 0 && !NEVER.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Whether an address is one an allowed name may lead to: anywhere on the internet, nowhere inside. */
export function publicAddress(address: string): boolean {
  // An IPv4 address written in IPv6's mapped form, dotted or in hexadecimal, is judged as the
  // IPv4 address it is: a mapped range in the block list would match every IPv4 address.
  const plain = mappedIpv4(address) ?? address;
  const family = isIP(plain);
  return family !== 0 && !INTERNAL.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Every address a name resolves to, for the proxy to judge and connect to. */
export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Whether a host is one the repository's list allows: a name written plainly matches itself,
 * and `*.example.com` matches every name under example.com but not example.com itself. An
 * address written as an IP never matches: a list of names would hold nothing against one.
 */
export function domainAllowed(host: string, allowed: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name || isIP(name.replace(/^\[|\]$/g, ""))) return false;
  return allowed.some((entry) => (entry.startsWith("*.") ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : name === entry));
}

/** The address an agent is given as its model's base URL when the runner holds the model key. */
export const MODEL_HOST = "model.orchestrator.invalid";
/** What an agent holds in place of the model key: a word that opens nothing anywhere. */
export const MODEL_KEY_STAND_IN = "held-by-the-orchestrator";

/**
 * The model's API as the proxy reaches it for an agent: plain requests to MODEL_HOST go to
 * `upstream` with the runner's key put in by the proxy, so the key never enters the agent's
 * environment, its files or anything it can print.
 */
export interface ModelRoute {
  key: string;
  upstream: { host: string; port: number; tls: boolean };
}

export const ANTHROPIC_UPSTREAM: ModelRoute["upstream"] = { host: "api.anthropic.com", port: 443, tls: true };

/** The model's endpoints a task's agent reaches with the runner's key: a message, and counting one's tokens. */
export const MODEL_PATHS: readonly string[] = ["/v1/messages", "/v1/messages/count_tokens"];

/** What an agent whose model goes through the proxy is told: the model host, and a key that opens nothing. */
export const MODEL_ENV: Record<string, string> = { ANTHROPIC_BASE_URL: `http://${MODEL_HOST}`, ANTHROPIC_API_KEY: MODEL_KEY_STAND_IN };

export interface EgressProxy {
  /** Every host the proxy turned away, once each, in the order first asked for. */
  refused(): string[];
  close(): Promise<void>;
}

/** The host and port a request names, or null when it names none the proxy can read. */
function target(value: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

/**
 * The only way out for an agent held to an allow list: a proxy on a socket in the task's own
 * directory, which a container with no network reaches through its mount. It opens a tunnel
 * (CONNECT) or forwards a plain request only to an allowed name on an allowed port, and answers
 * everything else 403, so a refused host is said in the log rather than timing out.
 */
export function startEgressProxy(
  socketPath: string,
  allowed: readonly string[],
  ports: readonly number[] = [80, 443],
  resolve: Resolver = systemResolver,
  reachable: (address: string) => boolean = publicAddress,
  model: ModelRoute | null = null,
): Promise<EgressProxy> {
  const refused: string[] = [];
  const open = new Set<Socket>();
  const refuse = (host: string) => {
    if (!refused.includes(host)) refused.push(host);
    return null;
  };
  /**
   * The address to connect to for an allowed name, or null. The name is resolved here and the
   * connection goes to the address judged, never the name again: a second lookup could answer
   * otherwise. One answer inside (this machine, a private network, a cloud's metadata service)
   * refuses the name, so an allowed name or wildcard pointed inward reaches nothing.
   */
  const destination = async (t: { host: string; port: number } | null): Promise<string | null> => {
    if (t === null) return null;
    if (!ports.includes(t.port) || !domainAllowed(t.host, allowed)) return refuse(t.host);
    const addresses = await resolve(t.host).catch(() => [] as string[]);
    if (!addresses.length || !addresses.every(reachable)) return refuse(t.host);
    return addresses[0]!;
  };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (model && url.protocol === "http:" && url.hostname === MODEL_HOST) {
      // The runner's key opens what an agent's run needs and nothing else: not its files,
      // batches or admin endpoints, which an agent told to by a repository could reach otherwise.
      if (req.method !== "POST" || !MODEL_PATHS.includes(url.pathname)) {
        if (!refused.includes(`${MODEL_HOST}${url.pathname}`)) refused.push(`${MODEL_HOST}${url.pathname}`);
        res.writeHead(403, { "content-type": "text/plain" }).end(`the model's ${req.method} ${url.pathname} is not open to tasks\n`);
        return;
      }
      // Whatever key the agent sent is dropped; the runner's goes on the way out.
      const { host: _host, authorization: _authorization, "x-api-key": _key, "proxy-authorization": _proxy, "proxy-connection": _keep, ...headers } = req.headers;
      const send = model.upstream.tls ? httpsRequest : httpRequest;
      const upstream = send({ host: model.upstream.host, port: model.upstream.port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: model.upstream.host, "x-api-key": model.key } }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      upstream.on("error", () => res.headersSent || res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    const t = url.protocol === "http:" ? target(url.host, 80) : null;
    const address = await destination(t);
    if (!address) {
      res.writeHead(403, { "content-type": "text/plain" }).end(`${url.hostname} is not in this repository's allowed domains\n`);
      return;
    }
    const upstream = httpRequest({ host: address, port: t!.port, method: req.method, path: `${url.pathname}${url.search}`, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", () => res.headersSent || res.writeHead(502).end());
    req.pipe(upstream);
  });
  server.on("connect", async (req: IncomingMessage, client: Socket, head: Buffer) => {
    open.add(client);
    client.on("close", () => open.delete(client));
    const t = target(req.url ?? "", 443);
    const address = await destination(t);
    if (!address) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${t?.host ?? "that host"} is not in this repository's allowed domains\n`);
      return;
    }
    const upstream = connect(t!.port, address, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    open.add(upstream);
    upstream.on("close", () => open.delete(upstream));
    upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    client.on("error", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        refused: () => [...refused],
        close: () =>
          new Promise<void>((done) => {
            for (const s of open) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A proxy in a task's own directory, with the shim a container starts through to reach it; the way out for one run. */
export interface TaskProxy {
  allowed: string[];
  socket: string;
  shim: string;
  proxy: EgressProxy;
}

/** The longest path a Unix socket may have on the systems the orchestrator runs on (macOS's limit; Linux allows 107). */
export const SOCKET_PATH_MAX = 103;

export async function openTaskProxy(paths: Pick<TaskPaths, "root">, allowed: string[], model: ModelRoute | null): Promise<TaskProxy> {
  const socket = join(paths.root, "egress.sock");
  // Past the limit the listen fails with an error that names nothing to change.
  if (socket.length > SOCKET_PATH_MAX) throw new Error(`the task's proxy cannot open: its socket's path is ${socket.length} characters, more than the ${SOCKET_PATH_MAX} a socket may have; set ORCHESTRATOR_DATA_DIR to a shorter path`);
  const shim = join(paths.root, "egress-shim.mjs");
  await writeFile(shim, EGRESS_SHIM);
  return { allowed, socket, shim, proxy: await startEgressProxy(socket, allowed, undefined, undefined, undefined, model) };
}
