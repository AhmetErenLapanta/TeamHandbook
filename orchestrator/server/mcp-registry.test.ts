import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MiddlewareHandler } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { namespaceCheck, readServer, registryUrl } from "./mcp-registry.js";
import { openSqliteStore } from "./store.js";

const OWNER: Principal = { id: "o", name: "Olu Example", email: "olu@example.invalid", role: "owner", ownedTeams: [] };
const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

const TRACKER = { name: "io.github.acme/tracker-mcp", description: "Reads the tracker.", version: "1.4.2", repository: { url: "https://github.com/acme/tracker-mcp", source: "github" }, packages: [{ registryType: "npm", identifier: "@acme/tracker-mcp", version: "1.4.2", transport: { type: "stdio" } }] };
const SPOOF = { name: "io.github.acme/spoof", description: "Claims acme.", version: "0.1.0", repository: { url: "https://github.com/mallory/spoof", source: "github" }, packages: [{ registryType: "npm", identifier: "spoof", version: "0.1.0" }] };
/** Servers whose package names a tag, a range or a wildcard rather than one release. */
const FLOATING = [
  ["latest", "npm"],
  ["next", "npm"],
  ["^2.0.0", "npm"],
  ["~2.0.0", "npm"],
  [">=2.0.0 <3", "npm"],
  ["*", "npm"],
  ["2.x", "npm"],
  [">=1.0", "pypi"],
  ["~=1.4", "pypi"],
].map(([version, registryType], i) => ({ name: `io.github.acme/floating-${i}`, description: "Floats.", version: "", repository: { url: `https://github.com/acme/floating-${i}`, source: "github" }, packages: [{ registryType, identifier: `floating-${i}`, version }] }));
const SEARCH = { name: "com.example.tools/search", description: "Searches.", version: "2.0.0", remotes: [{ type: "streamable-http", url: "https://mcp.tools.example.com/search", headers: [{ name: "Authorization", value: "Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] }] };

/** A stand-in MCP Registry: the orchestrator's tests never reach a real one. */
async function fakeRegistry(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url!);
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.url!.startsWith("/v0/servers?")) return send(200, { servers: [SEARCH, SPOOF, TRACKER].map((server) => ({ server, _meta: {} })), metadata: { nextCursor: "c2", count: 3 } });
    for (const s of [TRACKER, SPOOF, SEARCH, ...FLOATING]) if (req.url === `/v0/servers/${encodeURIComponent(s.name)}/versions/latest`) return send(200, { server: s, _meta: {} });
    return send(404, { title: "Not Found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

const context = (mcpRegistry: string | null): OrchestratorContext => ({ store: openSqliteStore(":memory:"), dataDir: "/nonexistent", tenant: "acme", mcpRegistry });
const approve = (ctx: OrchestratorContext, user: Principal, name: string) =>
  createApp(ctx, as(user)).request("/api/mcp-registry/approved", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });

describe("the approved MCP registry", () => {
  it("given no registry address, when servers are listed and one is approved, then nothing is read and nothing is approved", async () => {
    // given
    const ctx = context(null);

    // when
    const listed = await (await createApp(ctx, as(OWNER)).request("/api/mcp-registry")).json();
    const approving = await approve(ctx, OWNER, TRACKER.name);

    // then
    expect(listed).toEqual({ configured: false, servers: [], approved: [] });
    expect([approving.status, (await approving.json()).code]).toEqual([404, "registry-off"]);
  });

  it("given a registry, when an owner approves a server whose namespace checks out and the list is read again, then it comes first, pinned to its version, its header value nowhere, and the log says who approved it", async () => {
    // given
    const registry = await fakeRegistry();
    const ctx = context(registry.url);
    const before = await (await createApp(ctx, as(ADMIN)).request("/api/mcp-registry?search=tools")).json();

    // when
    const approved = await approve(ctx, OWNER, TRACKER.name);
    const after = await (await createApp(ctx, as(ADMIN)).request("/api/mcp-registry?search=tools")).json();
    const { events } = await ctx.store.eventPage("acme", {}, null, 10);

    // then
    expect(before.servers.map((s: { name: string; namespace: { verified: boolean } }) => [s.name, s.namespace.verified])).toEqual([[SEARCH.name, true], [SPOOF.name, false], [TRACKER.name, true]]);
    expect(before.nextCursor).toBe("c2");
    expect(approved.status).toBe(200);
    expect(after.servers.map((s: { name: string; approved: boolean }) => [s.name, s.approved])[0]).toEqual([TRACKER.name, true]);
    expect(after.approved).toEqual([expect.objectContaining({ name: TRACKER.name, version: "1.4.2", config: { command: "npx", args: ["-y", "@acme/tracker-mcp@1.4.2"] }, approvedBy: OWNER.email })]);
    expect(before.servers.find((s: { name: string }) => s.name === SEARCH.name).config).toEqual({ type: "http", url: "https://mcp.tools.example.com/search" });
    expect(JSON.stringify([before, after])).not.toContain("ghp_");
    expect(events.map((e) => [e.kind, e.subject])).toEqual([["mcp.registry.approved", `mcp:${TRACKER.name}`]]);
    expect(registry.asked.filter((u) => u.startsWith("/v0/servers?"))).toHaveLength(1);
  });

  it.each([
    ["a server whose repository is another GitHub owner's", OWNER, SPOOF.name, 409, "registry-namespace"],
    ["a server the registry does not have", OWNER, "io.github.acme/missing", 404, "not-found"],
    ["an admin", ADMIN, TRACKER.name, 403, "forbidden"],
  ])("given %s, when it is approved, then it is refused and nothing is kept", async (_label, user, name, status, code) => {
    // given
    const ctx = context((await fakeRegistry()).url);

    // when
    const res = await approve(ctx, user, name);

    // then
    expect([res.status, (await res.json()).code]).toEqual([status, code]);
    expect((await (await createApp(ctx, as(OWNER)).request("/api/mcp-registry")).json()).approved).toEqual([]);
  });

  it.each(FLOATING.map((s) => [s.packages[0]!.version, s.packages[0]!.registryType, s.name]))("given a server whose %s package is at %s, when an owner approves it, then it is refused as not pinned and nothing is kept", async (_version, _kind, name) => {
    // given
    const ctx = context((await fakeRegistry()).url);

    // when
    const res = await approve(ctx, OWNER, name);

    // then
    expect([res.status, (await res.json()).code]).toEqual([409, "registry-unpinnable"]);
    expect(await ctx.store.getSetting("acme", "mcp.registry.approved")).toBeNull();
  });

  it.each([
    ["an npm release with a pre-release tag", "npm", "2.0.0-rc.1", { command: "npx", args: ["-y", "pinned@2.0.0-rc.1"] }],
    ["a PyPI release", "pypi", "1.4.2", { command: "uvx", args: ["pinned==1.4.2"] }],
  ])("given a server with %s, when its entry is read, then it is pinned to that release", async (_label, registryType, version, config) => {
    expect(readServer({ name: "io.github.acme/pinned", repository: { url: "https://github.com/acme/pinned" }, packages: [{ registryType, identifier: "pinned", version }] })?.config).toEqual(config);
  });

  it("given a registry that does not answer, when a server is approved, then it is refused as unreachable and nothing is kept", async () => {
    // given
    const ctx = context("http://127.0.0.1:9");

    // when
    const res = await approve(ctx, OWNER, TRACKER.name);

    // then
    expect([res.status, (await res.json()).code]).toEqual([502, "registry-unreachable"]);
    expect(await ctx.store.getSetting("acme", "mcp.registry.approved")).toBeNull();
  });

  it("given an approved server, when the owner takes the approval back, then it is no longer approved and the log says so", async () => {
    // given
    const ctx = context((await fakeRegistry()).url);
    await approve(ctx, OWNER, TRACKER.name);

    // when
    const res = await createApp(ctx, as(OWNER)).request(`/api/mcp-registry/approved/${encodeURIComponent(TRACKER.name)}`, { method: "DELETE" });

    // then
    expect(res.status).toBe(200);
    expect((await (await createApp(ctx, as(OWNER)).request("/api/mcp-registry")).json()).approved).toEqual([]);
    expect((await ctx.store.eventPage("acme", {}, null, 1)).events[0]!.kind).toBe("mcp.registry.unapproved");
  });
});

describe("a registry server's namespace", () => {
  it.each([
    ["a GitHub namespace and its own repository", "io.github.acme/x", "https://github.com/Acme/x", [], true],
    ["a GitHub namespace and another owner's repository", "io.github.acme/x", "https://github.com/mallory/x", [], false],
    ["a domain namespace served from that domain", "com.example.tools/x", null, ["https://mcp.tools.example.com/x"], true],
    ["a domain namespace served from elsewhere", "com.example.tools/x", null, ["https://tools.example.com.evil.test/x"], false],
    ["a domain namespace with nothing served", "com.example.tools/x", "https://github.com/acme/x", [], false],
    ["a single-label namespace served from any domain under it", "com/x", null, ["https://anyone.com/x"], false],
    ["GitHub's shared host as a namespace", "io.github/x", null, ["https://mallory.github.io/x"], false],
    ["a two-label namespace served from its domain", "dev.acme/x", null, ["https://mcp.acme.dev/x"], true],
  ])("given %s, when it is checked, then it is verified only when its publisher holds it", (_label, name, repository, remotes, verified) => {
    expect(namespaceCheck(name, repository, remotes).verified).toBe(verified);
  });

  it.each([
    [undefined, null],
    ["https://registry.example.com/", "https://registry.example.com"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
  ])("given the address %s, when it is read, then the orchestrator uses %s", (value, used) => {
    expect(registryUrl(value)).toBe(used);
  });

  it.each([["http://registry.example.com"], ["https://user:pass@registry.example.com"]])("given the address %s, when it is read, then the orchestrator refuses to start", (value) => {
    expect(() => registryUrl(value)).toThrow();
  });
});
