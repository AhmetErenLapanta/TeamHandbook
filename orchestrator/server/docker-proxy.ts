import { chmodSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { posix } from "node:path";

/**
 * A Docker socket for the orchestrator that starts only task containers. Whoever holds Docker's own
 * socket holds the host as root; the orchestrator reaches the internet, so it is handed this one
 * instead: a container is created only with the options the orchestrator's task isolation gives one
 * (the task image, no network, a uid:gid other than 0, every capability dropped, no new
 * privileges, removed when it exits, and its own task directory out of the data volume), and
 * only the task, probe and review containers are attached to, started, waited on, inspected,
 * listed or removed. Every other call is refused with 403 before Docker sees it.
 *
 *   node dist/server.js docker-proxy
 */

export interface ProxyRules {
  /** The images a task container runs: ORCHESTRATOR_TASK_IMAGE. */
  images: string[];
  /** The data volume a task directory is mounted out of: ORCHESTRATOR_TASK_VOLUME. */
  volume: string;
  /** Where the orchestrator's data directory is, which a task directory's mount target sits under. */
  dataDir: string;
}

/** `attach`: the one call whose connection becomes the container's stream, once Docker answers 101. */
export type Verdict = { allow: true; path?: string; attach?: boolean } | { allow: false; reason: string };

/** The names the orchestrator gives its containers: tasks, readiness probes and request reviews. */
const CONTAINER_NAME = /^(teamhandbook-task-|teamhandbook-probe-|th-review-)[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NAME_PREFIXES = ["teamhandbook-task-", "teamhandbook-probe-", "th-review-"];
const ID = /^[0-9a-f]{12,64}$/;
const LISTED_NAME = /^(teamhandbook-task-|teamhandbook-probe-|th-review-)[A-Za-z0-9_-]*$/;
const MAX_HEAD = 16 * 1024;
const MAX_BODY = 1024 * 1024;

const refuse = (reason: string): Verdict => ({ allow: false, reason });

const zero = (value: unknown): boolean =>
  value === null || value === undefined || value === "" || value === 0 || value === false || (Array.isArray(value) && value.length === 0) || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);

/** The container options a task is created with, and what each may hold; any other option set refuses the create. */
const HOST_OPTIONS: Record<string, (value: unknown, rules: ProxyRules) => string | null> = {
  NetworkMode: (v) => (v === "none" ? null : "a task container has no network"),
  CapDrop: (v) => (Array.isArray(v) && v.some((c) => String(c).toUpperCase() === "ALL") ? null : "a task container drops every capability"),
  SecurityOpt: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((o) => ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"].includes(String(o))) ? null : "a task container takes no new privileges and no other security option",
  PidsLimit: (v) => (typeof v === "number" && v > 0 && v <= 4096 ? null : "a task container has a process limit of 1 to 4096"),
  AutoRemove: (v) => (v === true ? null : "a task container is removed when it exits"),
  Init: (v) => (bool(v) ? null : "Init is true or false"),
  ReadonlyRootfs: (v) => (bool(v) ? null : "ReadonlyRootfs is true or false"),
  ConsoleSize: (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? null : "ConsoleSize is two numbers"),
  MemorySwappiness: (v) => (v === -1 ? null : "MemorySwappiness stays the default"),
  RestartPolicy: (v) => {
    const name = (v as { Name?: unknown; MaximumRetryCount?: unknown }).Name;
    return (name === "" || name === "no") && zero((v as { MaximumRetryCount?: unknown }).MaximumRetryCount) ? null : "a task container is not restarted";
  },
  LogConfig: (v) => {
    const { Type, Config } = v as { Type?: unknown; Config?: unknown };
    return (Type === "" || Type === "none") && zero(Config) ? null : "a task container keeps the default log driver or none";
  },
  Tmpfs: (v) => (typeof v === "object" && v !== null && !Array.isArray(v) && Object.entries(v).every(([path, options]) => path === "/tmp" && typeof options === "string" && /^[a-z0-9=,]*$/.test(options) && !/(^|,)(suid|dev)(,|$)/.test(options)) ? null : "a task container mounts a tmpfs at /tmp only, without suid or devices"),
  Mounts: (v, rules) => mountRefused(v, rules),
  Memory: (v) => (typeof v === "number" && v > 0 ? null : "Memory is a positive limit"),
  MemorySwap: (v) => (typeof v === "number" ? null : "MemorySwap is a number"),
  MemoryReservation: (v) => (typeof v === "number" && v > 0 ? null : "MemoryReservation is a positive limit"),
  NanoCpus: (v) => (typeof v === "number" && v > 0 ? null : "NanoCpus is a positive limit"),
  CpuShares: (v) => (typeof v === "number" && v > 0 ? null : "CpuShares is a positive weight"),
  CpuQuota: (v) => (typeof v === "number" && v > 0 ? null : "CpuQuota is a positive limit"),
  CpuPeriod: (v) => (typeof v === "number" && v > 0 ? null : "CpuPeriod is a positive period"),
};

const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const bool = (v: unknown) => typeof v === "boolean";
const text = (v: unknown) => typeof v === "string";

/** The container settings a task is created with, each held to the type the CLI sends; the rest stay unset. */
const CONFIG_OPTIONS: Record<string, (value: unknown) => boolean> = {
  User: text,
  AttachStdin: bool,
  AttachStdout: bool,
  AttachStderr: bool,
  OpenStdin: bool,
  StdinOnce: bool,
  Tty: bool,
  Env: strings,
  Cmd: strings,
  Entrypoint: strings,
  Image: text,
  WorkingDir: text,
  Labels: (v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"),
  Hostname: text,
  Domainname: text,
  StopSignal: text,
  StopTimeout: (v) => typeof v === "number",
  NetworkDisabled: (v) => v === true,
};

function mountRefused(value: unknown, rules: ProxyRules): string | null {
  if (!Array.isArray(value) || value.length !== 1) return "a task container mounts its own task directory and nothing else";
  const mount = value[0] as { Type?: unknown; Source?: unknown; Target?: unknown; ReadOnly?: unknown; VolumeOptions?: { Subpath?: unknown; NoCopy?: unknown; DriverConfig?: unknown; Labels?: unknown }; BindOptions?: unknown; TmpfsOptions?: unknown; Consistency?: unknown };
  if (!mount || typeof mount !== "object" || Array.isArray(mount)) return "a task directory's mount is an object";
  if (!zero(mount.ReadOnly) && !bool(mount.ReadOnly)) return "ReadOnly is true or false";
  if (!zero(mount.Consistency) && !["default", "consistent", "cached", "delegated"].includes(String(mount.Consistency))) return "a task directory's mount takes the default consistency";
  const known = new Set(["Type", "Source", "Target", "ReadOnly", "VolumeOptions", "Consistency"]);
  if (Object.entries(mount).some(([key, v]) => !known.has(key) && !zero(v))) return "a task directory's mount takes no other option";
  if (mount.Type !== "volume" || mount.Source !== rules.volume) return `a task directory is mounted out of the volume ${rules.volume}`;
  const options = mount.VolumeOptions ?? {};
  if (typeof options !== "object" || Array.isArray(options) || (!zero(options.NoCopy) && !bool(options.NoCopy)) || Object.entries(options).some(([key, v]) => !["Subpath", "NoCopy", "DriverConfig"].includes(key) && !zero(v)) || !zero((options.DriverConfig as { Name?: unknown; Options?: unknown } | undefined)?.Name) || !zero((options.DriverConfig as { Options?: unknown } | undefined)?.Options)) {
    return "a task directory's mount takes no other volume option";
  }
  const subpath = options.Subpath;
  if (typeof subpath !== "string" || !/^tasks\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(subpath) || subpath.split("/").some((part) => part === "." || part === "..")) return "a task container mounts one task's directory, tasks/<organization>/<task>";
  if (mount.Target !== posix.join(rules.dataDir, subpath)) return "a task directory is mounted where the orchestrator keeps it";
  return null;
}

/** Whether a container may be created with this body, under this name. */
export function judgeCreate(body: unknown, name: string | null, rules: ProxyRules): Verdict {
  if (!name || !CONTAINER_NAME.test(name)) return refuse(`a container is created only under a task, probe or review name (${NAME_PREFIXES.join(", ")})`);
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("the create body is a JSON object");
  const { HostConfig: host, NetworkingConfig: networking, ...config } = body as Record<string, unknown>;
  for (const [key, value] of Object.entries(config)) {
    if (zero(value)) continue;
    const check = CONFIG_OPTIONS[key];
    if (!check) return refuse(`a task container sets no ${key}`);
    if (!check(value)) return refuse(`${key} is not of the type a task container takes`);
  }
  if (typeof config.Image !== "string" || !rules.images.includes(config.Image)) return refuse("a task container runs the task image");
  const user = /^(\d+):(\d+)$/.exec(typeof config.User === "string" ? config.User : "");
  if (!user || Number(user[1]) === 0 || Number(user[2]) === 0) return refuse("a task container runs as uid:gid, both numbers other than 0");
  const endpoints = (networking as { EndpointsConfig?: Record<string, unknown> } | undefined)?.EndpointsConfig ?? {};
  if (Object.keys(endpoints).some((n) => n !== "none") || Object.entries(networking ?? {}).some(([key, v]) => key !== "EndpointsConfig" && !zero(v))) return refuse("a task container joins no network");
  if (!host || typeof host !== "object") return refuse("a task container is created with its isolation options");
  for (const [key, value] of Object.entries(host as Record<string, unknown>)) {
    if (zero(value)) continue;
    const check = HOST_OPTIONS[key];
    if (!check) return refuse(`a task container sets no ${key}`);
    const problem = check(value, rules);
    if (problem) return refuse(problem);
  }
  for (const required of ["NetworkMode", "CapDrop", "SecurityOpt", "PidsLimit", "AutoRemove", "Mounts"]) {
    if (zero((host as Record<string, unknown>)[required])) return refuse(`a task container is created with ${required}`);
  }
  return { allow: true };
}

/** A filter of a container listing that names only the orchestrator's own containers. */
function listingAllowed(query: URLSearchParams): boolean {
  if ([...query.keys()].some((key) => !["all", "filters"].includes(key))) return false;
  let filters: unknown;
  try {
    filters = JSON.parse(query.get("filters") ?? "");
  } catch {
    return false;
  }
  if (!filters || typeof filters !== "object" || Object.keys(filters).join() !== "name") return false;
  const names = (filters as { name: unknown }).name;
  const values = Array.isArray(names) ? names : names && typeof names === "object" ? Object.keys(names) : [];
  // Docker reads a name filter as a pattern, so a value is a prefix and plain name characters, nothing it reads as more.
  return values.length > 0 && values.every((n) => typeof n === "string" && LISTED_NAME.test(n));
}

/**
 * The call a request makes, judged. `resolve` reads a container's name from Docker, for a call
 * that names it by id; the call then goes on to that id alone, so a name changed in between
 * changes nothing.
 */
export async function judge(method: string, target: string, body: Buffer, rules: ProxyRules, resolve: (ref: string) => Promise<{ id: string; name: string } | null>): Promise<Verdict> {
  // The path judged is the path Docker reads: a target with dot segments, escapes, empty segments
  // or a host is refused rather than read one way here and another way there.
  const query = target.indexOf("?");
  const rawPath = query < 0 ? target : target.slice(0, query);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || /%|\\|\/\/|#/.test(target.slice(0, query < 0 ? undefined : query)) || target.includes("#")) return refuse("a request names its path plainly");
  const url = new URL(target, "http://docker");
  if (url.pathname !== rawPath || url.host !== "docker") return refuse("a request names its path plainly");
  const path = url.pathname.replace(/^\/v\d+\.\d+(?=\/)/, "");
  const version = url.pathname.slice(0, url.pathname.length - path.length);
  if ((method === "GET" || method === "HEAD") && (path === "/_ping" || path === "/version")) return { allow: true };
  if (method === "POST" && path === "/containers/create") {
    if ([...url.searchParams.keys()].some((key) => key !== "name") || url.searchParams.getAll("name").length !== 1) return refuse("a container is created with one name and nothing else in the query");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return refuse("the create body is not JSON");
    }
    return judgeCreate(parsed, url.searchParams.get("name"), rules);
  }
  if (method === "GET" && path === "/containers/json") return listingAllowed(url.searchParams) ? { allow: true } : refuse("a listing names the orchestrator's own containers by name and nothing else");
  const image = /^\/images\/(.+)\/json$/.exec(path);
  if (method === "GET" && image) return rules.images.includes(image[1]!) ? { allow: true } : refuse("only the task image is inspected");
  const container = /^\/containers\/([^/]+)(\/(attach|wait|start|kill|resize|json|logs))?$/.exec(path);
  if (container) {
    const action = container[3] ?? "";
    const allowed = action === "" ? method === "DELETE" : action === "json" || action === "logs" ? method === "GET" : method === "POST";
    if (!allowed) return refuse(`${method} ${path} is not a call the orchestrator makes`);
    const ref = container[1]!;
    if (!CONTAINER_NAME.test(ref) && !ID.test(ref)) return refuse("a container is named by a task, probe or review name, or by its id");
    const found = await resolve(ref);
    if (!found) return CONTAINER_NAME.test(ref) ? { allow: true } : refuse("no such container of the orchestrator's");
    if (!CONTAINER_NAME.test(found.name)) return refuse("that container is not one the orchestrator started");
    return { allow: true, path: `${version}/containers/${found.id}${container[2] ?? ""}${url.search}`, attach: action === "attach" && method === "POST" };
  }
  return refuse(`${method} ${path} is not a call the orchestrator makes`);
}

interface Head {
  method: string;
  target: string;
  version: string;
  headers: [string, string][];
}

function parseHead(raw: string): Head | null {
  const [line, ...rest] = raw.split("\r\n");
  const request = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(line ?? "");
  if (!request) return null;
  const headers: [string, string][] = [];
  for (const header of rest) {
    // A folded line, a lone CR or LF, or a NUL is read as a header boundary by some parsers and not by others.
    if (/[\r\n\0]/.test(header) || /^[ \t]/.test(header)) return null;
    const at = header.indexOf(":");
    if (at <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.slice(0, at))) return null;
    headers.push([header.slice(0, at), header.slice(at + 1).trim()]);
  }
  return { method: request[1]!, target: request[2]!, version: request[3]!, headers };
}

const header = (head: Head, name: string) => head.headers.find(([key]) => key.toLowerCase() === name)?.[1];

function answer(socket: net.Socket, status: number, message: string): void {
  const body = JSON.stringify({ message });
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Request"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

/** Docker's own answer to which container a reference names, read on a connection of its own. */
export function resolverFor(upstream: string): (ref: string) => Promise<{ id: string; name: string } | null> {
  return (ref) =>
    new Promise((resolve, reject) => {
      const req = http.get({ socketPath: upstream, path: `/containers/${encodeURIComponent(ref)}/json`, headers: { connection: "close" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode === 404) return resolve(null);
          try {
            const found = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { Id?: string; Name?: string };
            resolve(found.Id && found.Name ? { id: found.Id, name: found.Name.replace(/^\//, "") } : null);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
    });
}

/**
 * Serves the judged socket at `listen`, forwarding to Docker at `upstream`. One request a
 * connection: an allowed one goes on with Connection: close, and after it only Docker's answer
 * comes back, except for an attach, whose connection becomes the container's stream both ways.
 */
export function serveDockerProxy(listen: string, upstream: string, rules: ProxyRules, warn: (line: string) => void = console.error): net.Server {
  const resolve = resolverFor(upstream);
  rmSync(listen, { force: true });
  // Half-open both ways: an attach whose stdin ends (the CLI closes its side) still carries the
  // container's output back until the container exits.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    let buffered = Buffer.alloc(0);
    client.on("error", () => undefined);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD) answer(client, 400, "the request head is too long");
        return;
      }
      const head = parseHead(buffered.subarray(0, end).toString("latin1"));
      if (!head) return answer(client, 400, "the request is not HTTP/1.1");
      if (header(head, "transfer-encoding")) return answer(client, 400, "a request body has a Content-Length");
      const lengths = head.headers.filter(([key]) => key.toLowerCase() === "content-length").map(([, v]) => v);
      if (lengths.length > 1 || (lengths.length === 1 && !/^\d{1,7}$/.test(lengths[0]!))) return answer(client, 400, "a request has one Content-Length, a number");
      const length = Number(lengths[0] ?? 0);
      if (length > MAX_BODY) return answer(client, 400, "the request body is too long");
      if (buffered.length < end + 4 + length) return;
      client.off("data", onData);
      client.pause();
      const body = buffered.subarray(end + 4, end + 4 + length);
      const rest = buffered.subarray(end + 4 + length);
      void judge(head.method, head.target, body, rules, resolve).then(
        (verdict) => {
          if (!verdict.allow) {
            warn(`docker-proxy: refused ${head.method} ${head.target.split("?")[0]}: ${verdict.reason}`);
            return answer(client, 403, `refused by the orchestrator's Docker proxy: ${verdict.reason}`);
          }
          const upgrade = verdict.attach === true && (header(head, "upgrade") ?? "").toLowerCase() === "tcp";
          const headers = head.headers.filter(([key]) => !["connection", "upgrade"].includes(key.toLowerCase()));
          headers.push(...(upgrade ? ([["Connection", "Upgrade"], ["Upgrade", "tcp"]] as [string, string][]) : ([["Connection", "close"]] as [string, string][])));
          const out = net.connect({ path: upstream, allowHalfOpen: true });
          out.on("error", () => client.destroy());
          client.on("error", () => out.destroy());
          out.write(`${head.method} ${verdict.path ?? head.target} ${head.version}\r\n${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
          out.write(body);
          out.pipe(client);
          // Only an attach carries more than the one request, the container's stdin, and only once
          // Docker has switched the connection over: before that, more bytes would be read as a request.
          if (upgrade) {
            out.once("data", (first: Buffer) => {
              if (!first.toString("latin1", 0, 12).startsWith("HTTP/1.1 101")) return;
              if (rest.length) out.write(rest);
              client.pipe(out);
              client.resume();
            });
          }
        },
        () => answer(client, 403, "refused by the orchestrator's Docker proxy: Docker did not say which container that is"),
      );
    };
    client.on("data", onData);
  });
  server.listen(listen, () => chmodSync(listen, 0o600));
  return server;
}

export function dockerProxyCommand(env: NodeJS.ProcessEnv = process.env): number | null {
  const listen = env.ORCHESTRATOR_DOCKER_PROXY_SOCKET;
  const images = (env.ORCHESTRATOR_TASK_IMAGE ?? "").split(",").map((i) => i.trim()).filter(Boolean);
  const volume = env.ORCHESTRATOR_TASK_VOLUME?.trim();
  if (!listen || !images.length || !volume) {
    console.error("docker-proxy needs ORCHESTRATOR_DOCKER_PROXY_SOCKET (the socket it serves), ORCHESTRATOR_TASK_IMAGE and ORCHESTRATOR_TASK_VOLUME");
    return 1;
  }
  const upstream = env.ORCHESTRATOR_DOCKER_PROXY_UPSTREAM || "/var/run/docker.sock";
  const server = serveDockerProxy(listen, upstream, { images, volume, dataDir: env.ORCHESTRATOR_DATA_DIR || "/data" });
  console.log(`docker-proxy: serving ${listen} for ${images.join(", ")} and the volume ${volume}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => server.close(() => process.exit(0)));
  return null;
}
