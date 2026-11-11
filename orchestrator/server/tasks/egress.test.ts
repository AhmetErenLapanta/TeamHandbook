import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { domainAllowed, MODEL_HOST, MODEL_KEY_STAND_IN, publicAddress, startEgressProxy } from "./egress.js";
import type { EgressProxy, Resolver } from "./egress.js";
import { containerInvocation, EGRESS_SHIM } from "./isolation.js";
import type { TaskPaths } from "./isolation.js";

const dirs: string[] = [];
const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("which hosts an allow list lets through", () => {
  it("given names and wildcards, when hosts are checked, then a name matches itself, a wildcard matches what is under it only, and an address never matches", () => {
    const allowed = ["registry.npmjs.org", "*.example.com"];
    expect(["registry.npmjs.org", "REGISTRY.npmjs.org.", "api.example.com", "a.b.example.com"].map((h) => domainAllowed(h, allowed))).toEqual([true, true, true, true]);
    expect(["example.com", "evil-example.com", "npmjs.org", "registry.npmjs.org.evil.test", "127.0.0.1", "[::1]"].map((h) => domainAllowed(h, allowed))).toEqual([false, false, false, false, false, false]);
    expect(["10.0.0.5", "127.0.0.1"].map((h) => domainAllowed(h, ["10.0.0.5", "*.0.1"]))).toEqual([false, false]);
  });
});

/**
 * A server on this machine standing in for a host on the internet, and the proxy in front of
 * it. The stand-in answers on loopback, which the proxy refuses on its own; here it is treated
 * as reachable, and the proxy's refusal of inward addresses is tested apart, below.
 */
async function proxied(allowed: string[], resolve: Resolver = async () => ["127.0.0.1"], reachable: (address: string) => boolean = () => true): Promise<{ proxy: EgressProxy; socket: string; port: number }> {
  const upstream: Server = createServer((req, res) => res.end(`upstream saw ${req.method} ${req.url}`));
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
  closing.push(() => new Promise((done) => upstream.close(done)));
  const port = (upstream.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-egress-"));
  dirs.push(dir);
  const socket = join(dir, "egress.sock");
  const proxy = await startEgressProxy(socket, allowed, [port], resolve, reachable);
  closing.unshift(() => proxy.close());
  return { proxy, socket, port };
}

/** A tunnel asked of the proxy: its status line, and what the upstream answered through it. */
function tunnel(socket: string, host: string, port: number): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(socket, () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nhost: ${host}:${port}\r\n\r\n`));
    let text = "";
    s.on("data", (chunk) => {
      text += chunk.toString();
      if (text.startsWith("HTTP/1.1 200") && text.includes("\r\n\r\n") && !text.includes("upstream saw")) s.write(`GET /through HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`);
    });
    s.on("end", () => resolve({ status: text.split("\r\n")[0]!, body: text }));
    s.on("error", reject);
  });
}

describe("the proxy an agent held to an allow list goes out through", () => {
  it("given an allowed name, when a tunnel is asked for, then it opens and carries the traffic", async () => {
    // given
    const { socket, port } = await proxied(["localhost"]);

    // when
    const answer = await tunnel(socket, "localhost", port);

    // then
    expect(answer.status).toBe("HTTP/1.1 200 Connection Established");
    expect(answer.body).toContain("upstream saw GET /through");
  });

  it("given a name and an address outside the list, when tunnels are asked for, then each is refused 403 and the hosts are recorded once", async () => {
    // given
    const { proxy, socket, port } = await proxied(["registry.npmjs.org"]);

    // when
    const byName = await tunnel(socket, "localhost", port);
    const byAddress = await tunnel(socket, "127.0.0.1", port);
    await tunnel(socket, "localhost", port);

    // then
    expect([byName.status, byAddress.status]).toEqual(["HTTP/1.1 403 Forbidden", "HTTP/1.1 403 Forbidden"]);
    expect(proxy.refused()).toEqual(["localhost", "127.0.0.1"]);
  });

  it("given a plain request through the proxy, when its host is allowed or not, then it is forwarded or refused 403", async () => {
    // given
    const { socket, port } = await proxied(["localhost"]);
    const plain = (host: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ socketPath: socket, method: "GET", path: `http://${host}:${port}/plain`, headers: { host: `${host}:${port}` } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on("error", reject);
        req.end();
      });

    // when
    const allowed = await plain("localhost");
    const refused = await plain("127.0.0.1");

    // then
    expect(allowed).toEqual({ status: 200, body: "upstream saw GET /plain" });
    expect(refused.status).toBe(403);
  });

  it("given an allowed name on a port the proxy does not open, when a tunnel is asked for, then it is refused", async () => {
    const { socket, port } = await proxied(["localhost"]);
    expect((await tunnel(socket, "localhost", port + 1)).status).toBe("HTTP/1.1 403 Forbidden");
  });
});

describe("a container held to an allow list", () => {
  it("given an allow list, when a program is wrapped for its container, then the container has no network and the shim starts the program behind the proxy's socket", () => {
    const paths = { root: "/data/tasks/t1", home: "/data/tasks/t1/home", tmp: "/data/tasks/t1/tmp", work: "/data/tasks/t1/work", git: "/data/git/t1" } as TaskPaths;
    const wrapped = containerInvocation({ program: "claude", args: ["-p"], env: { HOME: paths.home }, cwd: paths.work }, paths, { mode: "container", network: "open", image: "task-image", dataDir: "/data" }, "th-task-1", {}, { shim: "/data/tasks/t1/egress-shim.mjs", socket: "/data/tasks/t1/egress.sock" });
    expect(wrapped.args[wrapped.args.indexOf("--network") + 1]).toBe("none");
    expect(wrapped.args.slice(wrapped.args.indexOf("--entrypoint"))).toEqual(["--entrypoint", "node", "task-image", "/data/tasks/t1/egress-shim.mjs", "/data/tasks/t1/egress.sock", "claude", "-p"]);
  });

  it("given the shim in front of a program, when the program goes out through the proxy address it is given, then an allowed host answers and another is refused", async () => {
    // given
    const { socket, port } = await proxied(["localhost"]);
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-egress-shim-"));
    dirs.push(dir);
    const shim = join(dir, "egress-shim.mjs");
    writeFileSync(shim, EGRESS_SHIM);
    const probe = await new Promise<number>((done) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const free = (s.address() as AddressInfo).port;
        s.close(() => done(free));
      });
    });
    const client = `const http = require("node:http"); const u = new URL(process.env.HTTP_PROXY); const get = (host) => new Promise((ok) => http.get({ host: u.hostname, port: u.port, path: "http://" + host + ":${port}/via-shim", headers: { host } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => ok(r.statusCode + " " + b)); })); (async () => { console.log(await get("localhost")); console.log(await get("127.0.0.1")); })();`;

    // when
    // Not spawnSync: the proxy and the upstream answer from this same process.
    const run = await new Promise<{ status: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [shim, socket, process.execPath, "-e", client], { env: { PATH: process.env.PATH, TH_EGRESS_PORT: String(probe) } });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("close", (status) => done({ status, stdout }));
    });

    // then
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual([`200 upstream saw GET /via-shim`, expect.stringMatching(/^403 127\.0\.0\.1 is not in this repository's allowed domains/)]);
  });
});

describe("an allowed name that leads inward", () => {
  it("given addresses inside and outside, when each is judged, then this machine, private networks, link-local and the unspecified address are inside", () => {
    expect(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"].map(publicAddress)).toEqual(Array(13).fill(false));
    expect(["93.184.216.34", "::ffff:5db8:d822", "2606:2800:220:1:248:1893:25c8:1946"].map(publicAddress)).toEqual([true, true, true]);
  });

  it.each([
    ["the cloud's metadata service", ["169.254.169.254"]],
    ["this machine", ["127.0.0.1"]],
    ["a private network beside a public address", ["93.184.216.34", "10.0.0.5"]],
    ["nothing at all", []],
    ["a unique-local IPv6 address", ["fd00::1"]],
    ["the metadata service in IPv6's mapped form", ["::ffff:169.254.169.254"]],
  ])("given an allowed name that resolves to %s, when a tunnel to it is asked for, then it is refused and recorded", async (_case, addresses) => {
    // given: the proxy's own rule for which addresses it reaches
    const { proxy, socket, port } = await proxied(["*.example.com"], async () => addresses, publicAddress);

    // when
    const answer = await tunnel(socket, "metadata.example.com", port);

    // then
    expect(answer.status).toBe("HTTP/1.1 403 Forbidden");
    expect(proxy.refused()).toEqual(["metadata.example.com"]);
  });

  it("given a name that resolves outward, when the tunnel opens, then it goes to the address the proxy judged, not to the name again", async () => {
    // given: the name resolves once to the stand-in, and would resolve elsewhere if asked again
    let asked = 0;
    const { socket, port } = await proxied(["api.example.com"], async () => (asked++ === 0 ? ["127.0.0.1"] : ["203.0.113.9"]));

    // when
    const answer = await tunnel(socket, "api.example.com", port);

    // then
    expect(answer.body).toContain("upstream saw GET /through");
    expect(asked).toBe(1);
  });
});

describe("the model's API through the proxy", () => {
  /** A stand-in model API that echoes the headers it got, behind a proxy holding the organization's key. */
  async function modelProxied() {
    const upstream: Server = createServer((req, res) => res.end(JSON.stringify({ path: req.url, key: req.headers["x-api-key"] ?? null, authorization: req.headers.authorization ?? null, host: req.headers.host })));
    await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", () => done()));
    closing.push(() => new Promise((done) => upstream.close(done)));
    const dir = mkdtempSync(join(tmpdir(), "orchestrator-egress-model-"));
    dirs.push(dir);
    const socket = join(dir, "egress.sock");
    const proxy = await startEgressProxy(socket, [], [443], async () => [], () => false, { key: "sk-ant-org-key-0123456789abcdefghij", upstream: { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port, tls: false } });
    closing.unshift(() => proxy.close());
    return { socket };
  }

  const plain = (socket: string, url: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: socket, method: "POST", path: url, headers }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end("{}");
    });

  it("given an agent that sends its stand-in key to the model host, when the request passes the proxy, then the model gets the organization's key and nothing the agent sent as a key", async () => {
    // given
    const { socket } = await modelProxied();

    // when
    const answer = await plain(socket, `http://${MODEL_HOST}/v1/messages?beta=true`, { host: MODEL_HOST, "x-api-key": MODEL_KEY_STAND_IN, authorization: "Bearer from-the-agent" });

    // then
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ path: "/v1/messages?beta=true", key: "sk-ant-org-key-0123456789abcdefghij", authorization: null, host: "127.0.0.1" });
  });

  it("given an agent that asks the model host for its files, its batches or a GET of messages, when the requests pass the proxy, then each is refused and the organization's key goes nowhere", async () => {
    // given
    const { socket } = await modelProxied();

    // when
    const files = await plain(socket, `http://${MODEL_HOST}/v1/files`, { host: MODEL_HOST });
    const batches = await plain(socket, `http://${MODEL_HOST}/v1/messages/batches`, { host: MODEL_HOST });
    const counted = await plain(socket, `http://${MODEL_HOST}/v1/messages/count_tokens`, { host: MODEL_HOST });

    // then
    expect([files.status, batches.status, counted.status]).toEqual([403, 403, 200]);
    expect(files.body).not.toContain("sk-ant-org-key");
  });

  it("given a proxy with a model route and no allowed names, when the agent asks for any other host or a tunnel to the model host, then each is refused", async () => {
    // given
    const { socket } = await modelProxied();

    // when
    const other = await plain(socket, "http://example.com/", { host: "example.com" });
    const tunnelled = await tunnel(socket, MODEL_HOST, 443);

    // then
    expect(other.status).toBe(403);
    expect(tunnelled.status).toBe("HTTP/1.1 403 Forbidden");
  });
});
