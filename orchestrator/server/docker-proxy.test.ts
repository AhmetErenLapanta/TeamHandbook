import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { judge, judgeCreate, serveDockerProxy } from "./docker-proxy.js";
import type { ProxyRules } from "./docker-proxy.js";

const RULES: ProxyRules = { images: ["teamhandbook-orchestrator:release"], volume: "orchestrator-data", dataDir: "/data" };
const NAME = "teamhandbook-task-acme-aaaaaaaaaaaa";
const ID = "34a542343d00107bebf6db2ab10d49f3734738f2fc900ab8da7d4ade626d3d05";

/** The body the Docker CLI sends for the orchestrator's task container, zero values and all, as read off the socket. */
function taskCreate(): Record<string, any> {
  return {
    Hostname: "",
    Domainname: "",
    User: "1000:1000",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: true,
    StdinOnce: true,
    Env: ["HOME", "PATH"],
    Cmd: ["-p", "the task"],
    Image: "teamhandbook-orchestrator:release",
    Volumes: null,
    WorkingDir: "/data/tasks/acme/aaaaaaaaaaaa/work",
    Entrypoint: ["claude"],
    Labels: {},
    HostConfig: {
      Binds: null,
      ContainerIDFile: "",
      LogConfig: { Type: "", Config: {} },
      NetworkMode: "none",
      PortBindings: {},
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      AutoRemove: true,
      VolumeDriver: "",
      VolumesFrom: null,
      ConsoleSize: [0, 0],
      CapAdd: null,
      CapDrop: ["ALL"],
      CgroupnsMode: "",
      Dns: [],
      ExtraHosts: null,
      GroupAdd: null,
      IpcMode: "",
      Links: null,
      OomScoreAdj: 0,
      PidMode: "",
      Privileged: false,
      PublishAllPorts: false,
      ReadonlyRootfs: false,
      SecurityOpt: ["no-new-privileges"],
      UTSMode: "",
      UsernsMode: "",
      ShmSize: 0,
      Isolation: "",
      CpuShares: 0,
      Memory: 0,
      Devices: [],
      MemorySwappiness: -1,
      PidsLimit: 512,
      Ulimits: [],
      Mounts: [{ Type: "volume", Source: "orchestrator-data", Target: "/data/tasks/acme/aaaaaaaaaaaa", VolumeOptions: { Subpath: "tasks/acme/aaaaaaaaaaaa", DriverConfig: {} } }],
      MaskedPaths: null,
      ReadonlyPaths: null,
      Init: true,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
}

const refusedFor = (mutate: (body: Record<string, any>) => void, name = NAME) => {
  const body = taskCreate();
  mutate(body);
  const verdict = judgeCreate(body, name, RULES);
  return verdict.allow ? null : verdict.reason;
};

describe("creating a container through the orchestrator's Docker proxy", () => {
  it("given the create the Docker CLI sends for a task container, when it is judged, then it is allowed", () => {
    expect(judgeCreate(taskCreate(), NAME, RULES)).toEqual({ allow: true });
    expect(judgeCreate(taskCreate(), "teamhandbook-probe-1a2b3c", RULES)).toEqual({ allow: true });
    expect(judgeCreate(taskCreate(), "th-review-12-0123456789ab", RULES)).toEqual({ allow: true });
  });

  it.each<[string, (body: Record<string, any>) => void]>([
    ["privileged", (b) => (b.HostConfig.Privileged = true)],
    ["the host's network", (b) => (b.HostConfig.NetworkMode = "host")],
    ["the default bridge", (b) => (b.HostConfig.NetworkMode = "bridge")],
    ["another container's network", (b) => (b.HostConfig.NetworkMode = "container:postgres")],
    ["a network to join", (b) => (b.NetworkingConfig = { EndpointsConfig: { internal: {} } })],
    ["a capability added", (b) => (b.HostConfig.CapAdd = ["SYS_ADMIN"])],
    ["capabilities kept", (b) => (b.HostConfig.CapDrop = ["NET_RAW"])],
    ["new privileges allowed", (b) => (b.HostConfig.SecurityOpt = [])],
    ["an unconfined profile", (b) => (b.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"])],
    ["no process limit", (b) => (b.HostConfig.PidsLimit = 0)],
    ["kept after it exits", (b) => (b.HostConfig.AutoRemove = false)],
    ["a host folder bound", (b) => (b.HostConfig.Binds = ["/:/host"])],
    ["the Docker socket mounted", (b) => b.HostConfig.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Target: "/var/run/docker.sock" })],
    ["a bind mount in place of the volume", (b) => (b.HostConfig.Mounts[0] = { Type: "bind", Source: "/data", Target: "/data/tasks/acme/aaaaaaaaaaaa" })],
    ["another volume", (b) => (b.HostConfig.Mounts[0].Source = "pg-data")],
    ["the whole data volume", (b) => (b.HostConfig.Mounts[0].VolumeOptions.Subpath = "")],
    ["another organization's folder by ..", (b) => (b.HostConfig.Mounts[0].VolumeOptions.Subpath = "tasks/acme/../beta")],
    ["a folder outside tasks", (b) => (b.HostConfig.Mounts[0].VolumeOptions.Subpath = "mirrors/acme")],
    ["a target that is not the task's folder", (b) => (b.HostConfig.Mounts[0].Target = "/data")],
    ["a volume driver", (b) => (b.HostConfig.Mounts[0].VolumeOptions.DriverConfig = { Name: "local", Options: { device: "/" } })],
    ["the host's process namespace", (b) => (b.HostConfig.PidMode = "host")],
    ["the host's IPC namespace", (b) => (b.HostConfig.IpcMode = "host")],
    ["the host's user namespace", (b) => (b.HostConfig.UsernsMode = "host")],
    ["a device", (b) => (b.HostConfig.Devices = [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/sda", CgroupPermissions: "rwm" }])],
    ["another container's volumes", (b) => (b.HostConfig.VolumesFrom = ["orchestrator"])],
    ["a published port", (b) => (b.HostConfig.PortBindings = { "22/tcp": [{ HostPort: "2222" }] })],
    ["a restart policy", (b) => (b.HostConfig.RestartPolicy = { Name: "always", MaximumRetryCount: 0 })],
    ["a sysctl", (b) => (b.HostConfig.Sysctls = { "net.ipv4.ip_forward": "1" })],
    ["a raised ulimit", (b) => (b.HostConfig.Ulimits = [{ Name: "nofile", Soft: 1048576, Hard: 1048576 }])],
    ["a log driver that ships elsewhere", (b) => (b.HostConfig.LogConfig = { Type: "syslog", Config: { "syslog-address": "tcp://elsewhere:514" } })],
    ["a cgroup parent", (b) => (b.HostConfig.CgroupParent = "/")],
    ["a runtime", (b) => (b.HostConfig.Runtime = "runc-unsafe")],
    ["another image", (b) => (b.Image = "alpine")],
    ["root", (b) => (b.User = "0:0")],
    ["root's group", (b) => (b.User = "1000:0")],
    ["a user by name", (b) => (b.User = "node")],
    ["no user", (b) => (b.User = "")],
    ["an anonymous volume", (b) => (b.Volumes = { "/host": {} })],
    ["an exposed port", (b) => (b.ExposedPorts = { "22/tcp": {} })],
    ["no host options at all", (b) => delete b.HostConfig],
    ["Env as one string", (b) => (b.Env = "HOME=/")],
    ["Cmd as an object", (b) => (b.Cmd = { exec: "sh" })],
    ["a label that is not text", (b) => (b.Labels = { a: { nested: true } })],
    ["Init as a string", (b) => (b.HostConfig.Init = "true")],
    ["a tmpfs elsewhere", (b) => (b.HostConfig.Tmpfs = { "/etc": "" })],
    ["a tmpfs with suid", (b) => (b.HostConfig.Tmpfs = { "/tmp": "rw,suid" })],
    ["a mount that is read-only as a string", (b) => (b.HostConfig.Mounts[0].ReadOnly = "yes")],
    ["a mount with propagation", (b) => (b.HostConfig.Mounts[0].BindOptions = { Propagation: "rshared" })],
    ["a log driver taking options", (b) => (b.HostConfig.LogConfig = { Type: "none", Config: { "max-size": "1g" } })],
  ])("given a task create with %s, when it is judged, then it is refused", (_label, mutate) => {
    expect(refusedFor(mutate)).not.toBeNull();
  });

  it("given a container name that is not a task, probe or review name, when a create is judged, then it is refused", () => {
    expect(refusedFor(() => undefined, "postgres")).toMatch(/task, probe or review name/);
    expect(refusedFor(() => undefined, "")).toMatch(/task, probe or review name/);
    expect(refusedFor(() => undefined, "teamhandbook-task-")).toMatch(/task, probe or review name/);
  });
});

describe("the calls the orchestrator's Docker proxy lets through", () => {
  const empty = Buffer.alloc(0);
  const resolveTo = (name: string | null) => async () => (name === null ? null : { id: ID, name });

  it("given the calls a task run makes on a task container's id, when each is judged, then each goes on to that id", async () => {
    for (const [method, path] of [["POST", "attach?stderr=1&stdin=1&stdout=1&stream=1"], ["POST", "wait?condition=removed"], ["POST", "start"], ["GET", "json"], ["GET", "logs?stdout=1"], ["POST", "kill"]] as const) {
      const verdict = await judge(method, `/v1.52/containers/${ID.slice(0, 12)}/${path}`, empty, RULES, resolveTo(NAME));
      expect(verdict).toEqual({ allow: true, path: `/v1.52/containers/${ID}/${path}`, attach: path.startsWith("attach") });
    }
    expect(await judge("DELETE", `/v1.52/containers/${NAME}?force=1`, empty, RULES, resolveTo(NAME))).toEqual({ allow: true, path: `/v1.52/containers/${ID}?force=1`, attach: false });
  });

  it("given a call on a container the orchestrator did not start, by its id or its name, when it is judged, then it is refused", async () => {
    expect((await judge("POST", `/v1.52/containers/${ID}/start`, empty, RULES, resolveTo("teamhandbook-orchestrator-postgres-1"))).allow).toBe(false);
    expect((await judge("DELETE", "/v1.52/containers/teamhandbook-orchestrator-postgres-1?force=1", empty, RULES, resolveTo("teamhandbook-orchestrator-postgres-1"))).allow).toBe(false);
    expect((await judge("POST", `/v1.52/containers/${ID}/start`, empty, RULES, resolveTo(null))).allow).toBe(false);
  });

  it("given a removal of a task container that is gone, when it is judged, then Docker answers it", async () => {
    expect(await judge("DELETE", `/v1.52/containers/${NAME}?force=1`, empty, RULES, resolveTo(null))).toEqual({ allow: true });
  });

  it("given a listing of the probes, the task image's inspection and a ping, when each is judged, then each is allowed", async () => {
    const filters = encodeURIComponent(JSON.stringify({ name: { "teamhandbook-probe-": true } }));
    expect((await judge("GET", `/v1.52/containers/json?all=1&filters=${filters}`, empty, RULES, resolveTo(null))).allow).toBe(true);
    expect((await judge("GET", "/v1.52/images/teamhandbook-orchestrator:release/json", empty, RULES, resolveTo(null))).allow).toBe(true);
    expect((await judge("HEAD", "/_ping", empty, RULES, resolveTo(null))).allow).toBe(true);
  });

  it.each([
    ["GET", "/v1.52/containers/json"],
    ["GET", `/v1.52/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: { postgres: true } }))}`],
    ["GET", `/v1.52/containers/json?filters=${encodeURIComponent(JSON.stringify({ name: { "teamhandbook-probe-": true }, label: { a: true } }))}`],
    ["GET", "/v1.52/images/alpine/json"],
    ["POST", "/v1.52/images/create?fromImage=alpine"],
    ["POST", `/v1.52/containers/${ID}/exec`],
    ["POST", "/v1.52/exec/abc/start"],
    ["POST", `/v1.52/containers/${ID}/rename?name=teamhandbook-task-x`],
    ["POST", `/v1.52/containers/${ID}/update`],
    ["PUT", `/v1.52/containers/${ID}/archive?path=/`],
    ["GET", `/v1.52/containers/${ID}/archive?path=/`],
    ["POST", "/v1.52/build"],
    ["POST", "/v1.52/volumes/create"],
    ["GET", "/v1.52/volumes"],
    ["POST", "/v1.52/networks/create"],
    ["POST", "/v1.52/networks/internal/connect"],
    ["GET", "/v1.52/info"],
    ["GET", "/v1.52/events"],
    ["POST", "/v1.52/swarm/init"],
    ["POST", "/v1.52/plugins/pull"],
    ["POST", "/v1.52/containers/prune"],
    ["POST", "/v1.52/containers/create?name=teamhandbook-task-x&platform=linux"],
    ["POST", "/v1.52/containers/create?name=teamhandbook-task-x&name=postgres"],
    ["POST", `/v1.52/containers/${ID}/start/../exec`],
    ["POST", `/v1.52/containers/${ID}/%2e%2e/exec`],
    ["POST", `/v1.52/containers/teamhandbook-task-x%2F..%2F..%2Fexec`],
    ["POST", "//docker/v1.52/containers/create?name=teamhandbook-task-x"],
    ["POST", "http://docker/v1.52/build"],
    ["POST", `/v1.52/containers//${ID}/start`],
    ["POST", `/v1.52/containers/${ID}/start#frag`],
    ["DELETE", `/v1.52/containers/${ID}\\..\\x`],
    ["GET", `/v1.52/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: { "teamhandbook-probe-|.*": true } }))}`],
    ["GET", `/v1.52/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ name: { "teamhandbook-probe-.*": true } }))}`],
  ])("given %s %s, when it is judged, then it is refused", async (method, target) => {
    expect((await judge(method, target, Buffer.from("{}"), RULES, resolveTo(NAME))).allow).toBe(false);
  });
});

describe("the orchestrator's Docker proxy on its socket", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  /** A stand-in Docker that records each request and answers inspect for one task container. */
  function standIn() {
    const dir = mkdtempSync(join(tmpdir(), "docker-proxy-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const seen: { method: string; url: string; connection: string | undefined; body: string }[] = [];
    const docker = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url!.endsWith("/json") && req.url!.startsWith("/containers/") && req.method === "GET" && !req.url!.includes("?")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ Id: ID, Name: `/${NAME}` }));
        }
        seen.push({ method: req.method!, url: req.url!, connection: req.headers.connection, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(req.url!.includes("/containers/create") ? 201 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ Id: ID }));
      });
    });
    docker.on("upgrade", (req, socket) => {
      seen.push({ method: req.method!, url: req.url!, connection: req.headers.connection, body: "" });
      socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
      socket.on("data", (d: Buffer) => socket.write(`echo:${d.toString("utf8")}`));
      // As Docker does: the container's output goes on after the client closes its stdin.
      socket.on("end", () => setTimeout(() => socket.end("output after stdin closed"), 50));
    });
    docker.on("connection", (socket) => {
      (socket as net.Socket & { allowHalfOpen: boolean }).allowHalfOpen = true;
    });
    const upstream = join(dir, "docker.sock");
    const listen = join(dir, "proxy.sock");
    docker.listen(upstream);
    const proxy = serveDockerProxy(listen, upstream, RULES, () => undefined);
    cleanups.push(() => {
      proxy.close();
      docker.close();
    });
    return { seen, listen, ready: Promise.all([new Promise((r) => docker.once("listening", r)), new Promise((r) => proxy.once("listening", r))]) };
  }

  const request = (socketPath: string, method: string, path: string, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ socketPath, method, path, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(body);
    });

  it("given a task create, when it is sent through the proxy, then Docker gets it whole with Connection: close and its answer comes back", async () => {
    const docker = standIn();
    await docker.ready;
    const body = JSON.stringify(taskCreate());

    const answer = await request(docker.listen, "POST", `/v1.52/containers/create?name=${NAME}`, body);

    expect(answer).toEqual({ status: 201, body: JSON.stringify({ Id: ID }) });
    expect(docker.seen).toEqual([{ method: "POST", url: `/v1.52/containers/create?name=${NAME}`, connection: "close", body }]);
  });

  it("given a privileged create, when it is sent through the proxy, then the proxy answers 403 and Docker sees nothing", async () => {
    const docker = standIn();
    await docker.ready;
    const body = taskCreate();
    body.HostConfig.Privileged = true;

    const answer = await request(docker.listen, "POST", `/v1.52/containers/create?name=${NAME}`, JSON.stringify(body));

    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).message).toMatch(/^refused by the orchestrator's Docker proxy: a task container sets no Privileged$/);
    expect(docker.seen).toEqual([]);
  });

  it("given an allowed ping followed on the same connection by an exec, when both are sent, then only the ping reaches Docker", async () => {
    const docker = standIn();
    await docker.ready;
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(docker.listen);
      let got = "";
      socket.on("data", (d) => (got += d.toString("utf8")));
      socket.on("close", () => resolve(got));
      socket.write(`GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\nPOST /v1.52/containers/${ID}/exec HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{}`);
    });

    expect(raw.startsWith("HTTP/1.1 200")).toBe(true);
    expect(docker.seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /_ping"]);
  });

  const raw = (socketPath: string, bytes: string) =>
    new Promise<string>((resolve) => {
      const socket = net.connect(socketPath);
      let got = "";
      socket.on("data", (d) => (got += d.toString("utf8")));
      socket.on("close", () => resolve(got));
      socket.write(bytes);
    });

  it.each([
    ["two Content-Length headers", `POST /v1.52/containers/create?name=${NAME} HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\nContent-Length: 40\r\n\r\n{}`],
    ["a chunked body", `POST /v1.52/containers/create?name=${NAME} HTTP/1.1\r\nHost: docker\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n`],
    ["a folded header", `GET /_ping HTTP/1.1\r\nHost: docker\r\n Content-Length: 5\r\n\r\n`],
    ["a lone LF inside a header", `GET /_ping HTTP/1.1\r\nX-A: a\nContent-Length: 30\r\n\r\n`],
    ["a space before the colon", `GET /_ping HTTP/1.1\r\nContent-Length : 5\r\n\r\n`],
    ["a Content-Length that is not a number", `GET /_ping HTTP/1.1\r\nContent-Length: +5\r\n\r\n`],
    ["HTTP/2 in the request line", "GET /_ping HTTP/2\r\n\r\n"],
  ])("given a request with %s, when it is sent through the proxy, then it is refused and Docker sees nothing", async (_label, bytes) => {
    const docker = standIn();
    await docker.ready;

    const answer = await raw(docker.listen, bytes);

    expect(answer.startsWith("HTTP/1.1 400")).toBe(true);
    expect(docker.seen).toEqual([]);
  });

  it("given an Upgrade on a call other than attach, when it is sent with more bytes behind it, then Docker gets the call alone, with Connection: close", async () => {
    const docker = standIn();
    await docker.ready;

    await raw(docker.listen, `POST /v1.52/containers/${ID}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nPOST /v1.52/containers/${ID}/exec HTTP/1.1\r\nHost: docker\r\nContent-Length: 2\r\n\r\n{}`);

    expect(docker.seen).toEqual([{ method: "POST", url: `/v1.52/containers/${ID}/start`, connection: "close", body: "" }]);
  });

  it("given an attach to a task container by its short id, when it is sent through the proxy, then it reaches that container's full id and the stream flows both ways", async () => {
    const docker = standIn();
    await docker.ready;
    const echoed = await new Promise<string>((resolve) => {
      const socket = net.connect(docker.listen);
      let got = "";
      socket.on("data", (d) => {
        got += d.toString("utf8");
        if (got.includes("\r\n\r\n") && !got.includes("echo:")) socket.write("stdin line");
        if (got.includes("echo:stdin line")) {
          socket.destroy();
          resolve(got);
        }
      });
      socket.write(`POST /v1.52/containers/${ID.slice(0, 12)}/attach?stream=1&stdin=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
    });

    expect(echoed.startsWith("HTTP/1.1 101")).toBe(true);
    expect(docker.seen).toEqual([{ method: "POST", url: `/v1.52/containers/${ID}/attach?stream=1&stdin=1`, connection: "Upgrade", body: "" }]);
  });

  it("given an attach whose stdin the client closes, when the container goes on writing, then its output still reaches the client", async () => {
    const docker = standIn();
    await docker.ready;
    const got = await new Promise<string>((resolve) => {
      const socket = net.connect({ path: docker.listen, allowHalfOpen: true });
      let text = "";
      socket.on("data", (d) => {
        text += d.toString("utf8");
        if (text.includes("\r\n\r\n") && !text.includes("echo:")) socket.end("last stdin");
      });
      socket.on("end", () => resolve(text));
      socket.write(`POST /v1.52/containers/${ID}/attach?stream=1&stdin=1&stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`);
    });

    expect(got).toContain("echo:last stdin");
    expect(got.endsWith("output after stdin closed")).toBe(true);
  });
});
