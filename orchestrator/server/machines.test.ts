import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createUser, principalOf, removeUser, setupFirstOwner, startSession } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { CSRF_HEADER, sessionCookie } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { createKey } from "./keys.js";
import { MACHINE_SCOPES, runnerOf } from "./machines.js";
import { RUNNER_PROTOCOL, SIGNATURE_HEADER, signRunnerRequest } from "./runner-auth.js";
import { createRunnerService } from "./runner-service.js";
import { openSqliteStore } from "./store.js";

const TENANT = "acme";
const PASSWORD = "correct horse battery";

/** An organization with an owner, two members and a viewer, each with a signed-in browser, and a stand-in for a runner route. */
async function organization() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: PASSWORD }));
  const max = await createUser(store, TENANT, new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: PASSWORD }, owner);
  const vic = await createUser(store, TENANT, new Set(), { email: "vic@example.invalid", role: "viewer", password: PASSWORD }, owner);
  const lee = await createUser(store, TENANT, new Set(["Payments"]), { email: "lee@example.invalid", role: "member", password: PASSWORD }, owner);
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: TENANT, allowedHosts: null };
  const app = createApp(ctx);
  const browser = async (userId: string) => {
    const cookie = `${sessionCookie(TENANT)}=${(await startSession(store, TENANT, userId)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    return (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  // Where slice 2 mounts poll, heartbeat and events: each asks runnerOf first.
  const runner = new Hono<OrchestratorEnv>();
  runner.post("/api/runner/poll", async (c) => {
    const who = await runnerOf(c, ctx);
    return who instanceof Response ? who : c.json({ machine: who.machine.id, email: who.user.email, scopes: who.user.key!.scopes });
  });
  return { store, ctx, app, runner, owner, max, vic, as: { ada: await browser(owner.id), max: await browser(max.id), vic: await browser(vic.id), lee: await browser(lee.id) } };
}

/** A machine's side: its own key pair, the claim of a code, and calls signed with that key. */
function machine(app: Hono<OrchestratorEnv>, runner: Hono<OrchestratorEnv>) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sent = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url");
  let token = "";
  return {
    claim: async (code: string) => {
      const res = await app.request("/api/runner/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "max-laptop", platform: "darwin-arm64", publicKey: sent }) });
      if (res.ok) token = (await res.json()).token;
      return res;
    },
    signed: (body = JSON.stringify({ wait: 0 }), path = "/api/runner/poll") => ({ authorization: `Bearer ${token}`, [SIGNATURE_HEADER]: signRunnerRequest(privateKey, { method: "POST", path, body }), body }),
    disconnect: () => {
      const body = "{}";
      return app.request("/api/runner/disconnect", { method: "POST", headers: { authorization: `Bearer ${token}`, [SIGNATURE_HEADER]: signRunnerRequest(privateKey, { method: "POST", path: "/api/runner/disconnect", body }), "content-type": "application/json" }, body });
    },
    poll: (call: { authorization: string; [SIGNATURE_HEADER]: string; body: string }) => runner.request("/api/runner/poll", { method: "POST", headers: { authorization: call.authorization, [SIGNATURE_HEADER]: call[SIGNATURE_HEADER], "content-type": "application/json" }, body: call.body }),
  };
}

describe("pairing a person's machine", () => {
  it("given Max pairs his machine, when it claims the code and calls in signed, then it acts as Max at the machine's scopes, the code is spent, his list shows the machine without its key, and Ada sees it too", async () => {
    // given
    const { app, runner, as } = await organization();
    const paired = await (await as.max("/api/machines/pair", "POST", {})).json();
    const laptop = machine(app, runner);

    // when
    const claimed = await laptop.claim(paired.code.toLowerCase());
    const again = await machine(app, runner).claim(paired.code);
    const call = await laptop.poll(laptop.signed());
    const maxs = (await (await as.max("/api/machines")).json()).machines;
    const adas = (await (await as.ada("/api/machines")).json()).machines;

    // then
    expect(paired.address).toMatch(/\/api\/orgs\/acme$/);
    expect(paired.command).toBe(`handbook-orchestrator runner connect ${paired.address} ${paired.code}`);
    expect([claimed.status, again.status]).toEqual([200, 400]);
    expect(await call.json()).toMatchObject({ email: "max@example.invalid", scopes: MACHINE_SCOPES });
    expect(maxs.map((m: { name: string }) => m.name)).toEqual(["max-laptop"]);
    expect(JSON.stringify(maxs)).not.toMatch(/publicKey|token/);
    expect(adas).toHaveLength(1);
  });

  it("given Max's machine that just called in with its agents, one heard from four minutes ago and one removed, when he reads his machines, then only the first is online, and each agent is named with the command that signs it in there", async () => {
    // given
    const { store, app, runner, as, max } = await organization();
    const laptop = machine(app, runner);
    await laptop.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    const [first] = await store.listMachines(TENANT, max.id);
    await store.touchMachine(TENANT, first!.id, new Date().toISOString(), [{ id: "claude-code", installed: true, version: "2.1.317", supported: "ok", signIn: "signed-out" }, { id: "opencode", installed: true, version: "1.19.4", supported: "ok", signIn: "signed-in" }]);
    const desk = machine(app, runner);
    await desk.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    const away = (await store.listMachines(TENANT, max.id)).find((m) => m.id !== first!.id)!;
    await store.touchMachine(TENANT, away.id, new Date(Date.now() - 240_000).toISOString());
    const old = machine(app, runner);
    await old.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    const gone = (await store.listMachines(TENANT, max.id)).find((m) => m.id !== first!.id && m.id !== away.id)!;
    await store.touchMachine(TENANT, gone.id, new Date().toISOString());
    await store.revokeMachine(TENANT, gone.id, new Date().toISOString());

    // when
    const listed = (await (await as.max("/api/machines")).json()).machines as { id: string; online: boolean; agents: { id: string; label: string; signInCommand: string | null }[] }[];

    // then
    expect(Object.fromEntries(listed.map((m) => [m.id, m.online]))).toEqual({ [first!.id]: true, [away.id]: false, [gone.id]: false });
    expect(listed.find((m) => m.id === first!.id)!.agents.map(({ id, label, signInCommand }) => ({ id, label, signInCommand }))).toEqual([
      { id: "claude-code", label: "Claude Code", signInCommand: "claude auth login" },
      { id: "opencode", label: "OpenCode", signInCommand: "opencode auth login" },
    ]);
  });

  it("given a connected machine, when a signed call is sent twice, its token comes without a signature, Lee tries to disconnect it, Max disconnects it, or Max leaves, then each call is turned away and Lee finds no machine of his", async () => {
    // given
    const { store, app, runner, owner, max, as } = await organization();
    const laptop = machine(app, runner);
    await laptop.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    const first = laptop.signed();
    const id = (await (await as.max("/api/machines")).json()).machines[0].id;

    // when
    const once = await laptop.poll(first);
    const replayed = await laptop.poll(first);
    const unsigned = await runner.request("/api/runner/poll", { method: "POST", headers: { authorization: first.authorization }, body: first.body });
    const notHis = await as.lee(`/api/machines/${id}`, "DELETE");
    await as.max(`/api/machines/${id}`, "DELETE");
    const disconnected = await laptop.poll(laptop.signed());
    const other = machine(app, runner);
    await other.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    await removeUser(store, TENANT, max.id, owner);
    const gone = await other.poll(other.signed());

    // then
    expect([once.status, replayed.status, unsigned.status, notHis.status, disconnected.status, gone.status]).toEqual([200, 401, 401, 404, 401, 401]);
  });

  it("given a viewer, an API key and a person holding three unused codes, when each asks for a code, then none is given, and the hello answer names the protocol and the organization", async () => {
    // given
    const { store, app, max, as } = await organization();
    const { secret } = await createKey(store, TENANT, await principalOf(store, max), { name: "ci", scopes: { tasks: "write" } });
    for (let i = 0; i < 3; i++) await as.max("/api/machines/pair", "POST", {});

    // when
    const viewer = await as.vic("/api/machines/pair", "POST", {});
    const key = await app.request("/api/machines/pair", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: "{}" });
    const fourth = await as.max("/api/machines/pair", "POST", {});
    const hello = await (await app.request("/api/runner/hello")).json();

    // then
    expect([viewer.status, key.status, fourth.status]).toEqual([403, 403, 429]);
    expect(hello).toEqual({ protocol: RUNNER_PROTOCOL, org: TENANT });
  });
});

describe("a machine disconnecting itself", () => {
  it("given Max's connected machine, when it disconnects itself signed, then it is gone from his list and its token works no more, and the same call unsigned does nothing", async () => {
    // given
    const { app, runner, as } = await organization();
    const laptop = machine(app, runner);
    await laptop.claim((await (await as.max("/api/machines/pair", "POST", {})).json()).code);
    const token = laptop.signed().authorization;

    // when
    const unsigned = await app.request("/api/runner/disconnect", { method: "POST", headers: { authorization: token }, body: "{}" });
    const stillThere = await laptop.poll(laptop.signed());
    const gone = await laptop.disconnect();
    const after = await laptop.poll(laptop.signed());
    const listed = (await (await as.max("/api/machines")).json()).machines;

    // then
    expect([unsigned.status, stillThere.status, gone.status, after.status]).toEqual([401, 200, 204, 401]);
    expect(listed.every((m: { revokedAt: string | null }) => m.revokedAt)).toBe(true);
  });
});

describe("whether the screens offer to connect a machine", () => {
  it("given a team's orchestrator that takes machines' calls, a local one, one with no runner service, a team's that runs tasks itself and one with a root for server paths, when each person reads who they are, then only a team's offers machines, a task runs here on the local one and where the server runs tasks, and a server path is offered only under its root", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await setupFirstOwner(store, TENANT, "code", { code: "code", email: "ada@example.invalid", password: PASSWORD });
    const service = createRunnerService({ tenant: TENANT, store });
    const me = async (extra: Partial<OrchestratorContext>) => {
      const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null, ...extra });
      const cookie = `${sessionCookie(TENANT)}=${(await startSession(store, TENANT, owner.id)).token}`;
      const { user } = await (await app.request("/api/me", { headers: { cookie } })).json();
      return [user.runners, user.tasksRunHere, user.pathRepos];
    };

    // when
    const team = await me({ mode: "self-hosted", runnerService: service });
    const local = await me({ mode: "local", runnerService: service });
    const none = await me({ mode: "self-hosted" });
    vi.stubEnv("ORCHESTRATOR_SERVER_TASKS", "1");
    const serverTasks = await me({ mode: "self-hosted", runnerService: service });
    vi.unstubAllEnvs();
    const underRoot = await me({ mode: "self-hosted", runnerService: service, localReposRoot: "/srv/repos" });

    // then
    expect([team, local, none, serverTasks, underRoot]).toEqual([[true, false, false], [false, true, false], [false, false, false], [true, true, false], [true, false, true]]);
  });
});
