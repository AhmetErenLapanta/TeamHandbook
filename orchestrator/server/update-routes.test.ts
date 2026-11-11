import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { openSqliteStore } from "./store.js";
import { runCommand } from "./update.js";
import type { UpdateHost } from "./update.js";
import { updateRoutes } from "./update-routes.js";

const PLATFORM = "darwin-arm64";
const BASE = "http://127.0.0.1:18799/release";
const OWNER: Principal = { id: "usr_a", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-update-routes-"));
  dirs.push(dir);
  return dir;
};

/** A release on this disk with stand-in executables of these versions, the newest named in its manifest. */
function release(versions: string[]): string {
  const dir = scratch();
  const sums: string[] = [];
  for (const version of versions) {
    const name = `handbook-orchestrator-${version}-${PLATFORM}`;
    mkdirSync(join(dir, "stage", name), { recursive: true });
    writeFileSync(join(dir, "stage", name, "handbook-orchestrator"), `#!/bin/sh\necho "teamhandbook-orchestrator ${version}"\n`);
    chmodSync(join(dir, "stage", name, "handbook-orchestrator"), 0o755);
    spawnSync("tar", ["-czf", join(dir, `${name}.tar.gz`), "-C", join(dir, "stage"), name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    sums.push(`${createHash("sha256").update(readFileSync(join(dir, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "handbook-orchestrator", version: versions.at(-1) }));
  return dir;
}

/**
 * A local orchestrator installed at 1.0.0 with a service, a release holding 1.1.0, every request
 * kept, and the routes as `user` reaches them; `installed` false is an orchestrator run from a clone.
 */
function orchestrator(user: Principal = OWNER, installed = true) {
  vi.stubEnv("ORCHESTRATOR_MODE", "local");
  const root = join(scratch(), ".handbook-orchestrator");
  mkdirSync(join(root, "versions", "1.0.0"), { recursive: true });
  writeFileSync(join(root, "versions", "1.0.0", ".install-complete"), "");
  symlinkSync(join("versions", "1.0.0"), join(root, "current"));
  const releaseDir = release(["1.0.0", "1.1.0"]);
  const fetched: string[] = [];
  const restarts: number[] = [];
  const host = (say: (line: string) => void): UpdateHost => ({
    root,
    version: "1.0.0",
    platform: PLATFORM,
    mirror: BASE,
    cosign: null,
    requireSignature: false,
    fetch: async (url) => {
      fetched.push(url);
      const file = join(releaseDir, url.slice(BASE.length + 1));
      const ok = existsSync(file);
      return { ok, status: ok ? 200 : 404, url, bytes: async () => readFileSync(file) };
    },
    run: runCommand,
    ask: async () => null,
    service: { installed: () => true, restart: () => 0 },
    say,
  });
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: scratch(), tenant: "default" };
  const app = new Hono<OrchestratorEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/", updateRoutes(ctx, { host: (say) => (installed ? host(say) : null), restart: () => void restarts.push(Date.now()), startedFrom: () => ({ from: "clone", folder: "/home/person/src/TeamHandbook" }) }));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  return { root, ctx, fetched, restarts, call };
}

describe("updating a local orchestrator from its Settings", () => {
  it("given an install at 1.0.0 and a release with 1.1.0, when its owner reads the state, checks, prepares, switches and restarts, then only the check and the prepare reach the release, the switch keeps the version before, and the restart comes after its answer", async () => {
    // given
    const { root, ctx, fetched, restarts, call } = orchestrator();

    // when
    const before = await call("GET", "/api/update");
    const readOnly = fetched.length;
    const checked = await call("POST", "/api/update/check");
    const afterCheck = fetched.length;
    const prepared = await call("POST", "/api/update/prepare", { version: "1.1.0" });
    const ready = await call("GET", "/api/update");
    const stillCurrent = readlinkSync(join(root, "current"));
    const applied = await call("POST", "/api/update/apply");
    const restarting = await call("POST", "/api/update/restart");
    const restartsAtAnswer = restarts.length;
    await vi.waitFor(() => expect(restarts).toHaveLength(1), { timeout: 5_000 });

    // then
    expect(before).toEqual({ status: 200, body: { installed: true, running: "1.0.0", prepared: null, failed: null } });
    expect([readOnly, afterCheck]).toEqual([0, 1]);
    expect(checked).toEqual({ status: 200, body: { running: "1.0.0", newest: "1.1.0", newer: true } });
    expect(prepared).toMatchObject({ status: 200, body: { ok: true, said: expect.any(Array) } });
    expect([ready.body.prepared, stillCurrent]).toEqual(["1.1.0", join("versions", "1.0.0")]);
    expect(applied).toMatchObject({ status: 200, body: { ok: true, restart: "service" } });
    expect(readlinkSync(join(root, "current"))).toBe(join("versions", "1.1.0"));
    expect(existsSync(join(root, "versions", "1.0.0"))).toBe(true);
    expect([restarting.status, restartsAtAnswer]).toEqual([202, 0]);
    expect((await ctx.store.eventPage(ctx.tenant, {}, null, 10)).events.map((e) => e.kind).sort()).toEqual(["orchestrator.update.applied", "orchestrator.update.prepared", "orchestrator.update.restarted"]);
  });

  it("given a member, an API key, a team's orchestrator, an orchestrator run from a clone, a version that is no release name and two prepares at once, when each asks, then each is refused by its code, the clone's state names its folder, and nothing is fetched for them", async () => {
    // given
    const member = orchestrator({ ...OWNER, role: "member" });
    const key = orchestrator({ ...OWNER, key: { id: "key_1", owner: { kind: "user", id: "usr_a" }, scopes: { repositories: "read", requests: "none", tasks: "none", usage: "none", members: "none", settings: "none", keys: "none" }, expiresAt: null } });
    const notInstalled = orchestrator(OWNER, false);
    const owner = orchestrator();

    // when
    const asMember = await member.call("POST", "/api/update/check");
    const asKey = await key.call("GET", "/api/update");
    const plain = [await notInstalled.call("GET", "/api/update"), await notInstalled.call("POST", "/api/update/check")];
    const badVersion = await owner.call("POST", "/api/update/prepare", { version: "1.1.0; rm -rf ~" });
    const both = await Promise.all([owner.call("POST", "/api/update/prepare", { version: "1.1.0" }), owner.call("POST", "/api/update/prepare", { version: "1.1.0" })]);
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const team = await owner.call("GET", "/api/update");

    // then
    expect([asMember.status, asMember.body.code, asKey.status]).toEqual([403, "owner-only", 403]);
    expect(plain).toEqual([{ status: 200, body: { installed: false, from: "clone", folder: "/home/person/src/TeamHandbook" } }, { status: 409, body: expect.objectContaining({ code: "not-installed" }) }]);
    expect([badVersion.status, badVersion.body.code]).toEqual([400, "bad-version"]);
    expect(both.map((b) => b.status).sort()).toEqual([200, 409]);
    expect(both.find((b) => b.status === 409)?.body.code).toBe("update-busy");
    expect(team.status).toBe(404);
    expect([...member.fetched, ...key.fetched, ...notInstalled.fetched]).toEqual([]);
  });
});
