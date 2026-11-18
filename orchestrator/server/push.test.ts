import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { encryptPush, notifyPerson, PUSH_PER_PERSON, startPushWatch, vapidHeader, vapidKeys } from "./push.js";
import type { TaskRecord } from "./tasks/types.js";
import { openSqliteStore } from "./store.js";
import { createVault } from "./vault.js";

const TENANT = "acme";
const ADA: Principal = { id: "usr_ada", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const MAX: Principal = { id: "usr_max", name: "Max", email: "max@example.invalid", role: "member", ownedTeams: [] };
afterEach(() => vi.unstubAllEnvs());

const publicAddress = async () => ["203.0.113.9"];
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, n: number) => createHmac("sha256", createHmac("sha256", salt).update(ikm).digest()).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, n);

/** What a browser does with a push body: derives the same keys from its own private key and opens it. */
function open(body: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const senderPublic = body.subarray(21, 21 + body[20]!);
  const secret = receiver.computeSecret(senderPublic);
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), senderPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const sealed = body.subarray(21 + body[20]!);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
}

async function setup(vault = true) {
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, mode: "local", dataDir: "/nonexistent", tenant: TENANT, allowedHosts: null, ...(vault ? { vault: createVault(randomBytes(32)) } : {}) };
  const as = (user: Principal) => createApp(ctx, async (c, next) => { c.set("user", user); await next(); });
  const call = async (user: Principal, method: string, path: string, body?: unknown) => {
    const res = await as(user).request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  return { ctx, call };
}

describe("a person's browsers woken when a task needs them", () => {
  it("given a message sealed for a browser, when that browser opens it and another one tries, then the first reads the task and its status and the other cannot", () => {
    // given
    const [a, b] = [browser(), browser()];

    // when
    const body = encryptPush(Buffer.from(JSON.stringify({ taskId: "tsk_1", status: "needs-review" })), a.keys.p256dh, a.keys.auth);

    // then
    expect(JSON.parse(open(body, a.ecdh, a.auth))).toEqual({ taskId: "tsk_1", status: "needs-review" });
    expect(() => open(body, b.ecdh, b.auth)).toThrow();
  });

  it("given the orchestrator's vault, when its key is read twice and a header is made for a push service, then the pair is made once and the header names the service and carries a token signed by it", async () => {
    // given
    const { ctx } = await setup();

    // when
    const [first, second] = [await vapidKeys(ctx), await vapidKeys(ctx)];
    const header = vapidHeader(first!, "https://push.example.invalid", "mailto:ops@example.invalid", Date.parse("2026-11-12T10:00:00.000Z"));

    // then
    expect(second).toEqual(first);
    expect(header).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    const claims = JSON.parse(Buffer.from(header.split("t=")[1]!.split(".")[1]!, "base64url").toString());
    expect(claims).toEqual({ aud: "https://push.example.invalid", exp: Date.parse("2026-11-12T10:00:00.000Z") / 1000 + 12 * 3600, sub: "mailto:ops@example.invalid" });
  });

  it("given a local orchestrator with a vault, when Ada subscribes two browsers, Max one, a bad endpoint, a private one and a sixth of Ada's, then each valid one is kept for its person alone, the bad ones are refused by code, and Max cannot remove Ada's", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const { ctx, call } = await setup();
    const sub = (endpoint: string) => ({ endpoint, keys: browser().keys });

    // when
    const adas = [await call(ADA, "POST", "/api/push/subscriptions", sub("https://push.example.invalid/a1")), await call(ADA, "POST", "/api/push/subscriptions", sub("https://push.example.invalid/a2"))];
    const maxs = await call(MAX, "POST", "/api/push/subscriptions", sub("https://push.example.invalid/m1"));
    const refused = [await call(ADA, "POST", "/api/push/subscriptions", { endpoint: "https://push.example.invalid/x", keys: { p256dh: "short", auth: "short" } }), await call(ADA, "POST", "/api/push/subscriptions", sub("https://10.0.0.5/push")), await call(ADA, "POST", "/api/push/subscriptions", sub("http://push.example.invalid/plain"))];
    for (let n = 3; n <= PUSH_PER_PERSON; n++) await call(ADA, "POST", "/api/push/subscriptions", sub(`https://push.example.invalid/a${n}`));
    const sixth = await call(ADA, "POST", "/api/push/subscriptions", sub("https://push.example.invalid/a6"));
    const stolen = await call(MAX, "DELETE", `/api/push/subscriptions/${adas[0]!.body.id}`);
    const own = await call(ADA, "DELETE", `/api/push/subscriptions/${adas[0]!.body.id}`);

    // then
    expect([adas[0]!.status, adas[1]!.status, maxs.status]).toEqual([200, 200, 200]);
    expect(refused.map((r) => r.body.code)).toEqual(["bad-subscription", "bad-endpoint", "bad-endpoint"]);
    expect([sixth.status, sixth.body.code]).toEqual([409, "too-many"]);
    expect([stolen.status, own.status]).toEqual([404, 204]);
    expect((await ctx.store.listPushSubscriptions(TENANT, MAX.id)).length).toBe(1);
  });

  it("given a team's orchestrator and a local one without a vault, when a browser is subscribed, then the team's refuses by code and the one without a vault says it needs one", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "self-hosted");
    const team = await setup();
    const keyless = await setup(false);

    // when
    const onTeam = await team.call(ADA, "GET", "/api/push/key");
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const noVault = await keyless.call(ADA, "GET", "/api/push/key");

    // then
    expect([onTeam.status, onTeam.body.code]).toEqual([409, "local-only"]);
    expect([noVault.status, noVault.body.code]).toEqual([409, "no-vault"]);
  });

  it("given Ada's browser and one its push service has dropped, when a task of hers needs her, then each is sent only the task and its status and the dropped one is forgotten, and a name that now resolves to a private address is not called", async () => {
    // given
    const { ctx } = await setup();
    const live = browser();
    await ctx.store.addPushSubscription({ tenant: TENANT, id: "psh_live", userId: ADA.id, endpoint: "https://push.example.invalid/live", ...live.keys, createdAt: "2026-11-12T10:00:00.000Z" });
    await ctx.store.addPushSubscription({ tenant: TENANT, id: "psh_gone", userId: ADA.id, endpoint: "https://push.example.invalid/gone", ...browser().keys, createdAt: "2026-11-12T10:01:00.000Z" });
    const seen: { url: string; body: Buffer; headers: Record<string, string> }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: Buffer.from(init.body as Uint8Array), headers: init.headers as Record<string, string> });
      return new Response(null, { status: url.endsWith("/gone") ? 410 : 201 });
    }) as unknown as typeof fetch;

    // when
    await notifyPerson(ctx, ADA.id, { taskId: "tsk_9", status: "asking" }, fetcher, publicAddress);
    const rebound = await notifyPerson(ctx, ADA.id, { taskId: "tsk_10", status: "failed" }, fetcher, async () => ["10.0.0.7"]);

    // then
    expect(seen.map((s) => s.url)).toEqual(["https://push.example.invalid/live", "https://push.example.invalid/gone"]);
    expect(JSON.parse(open(seen[0]!.body, live.ecdh, live.auth))).toEqual({ taskId: "tsk_9", status: "asking" });
    expect(seen[0]!.headers["content-encoding"]).toBe("aes128gcm");
    expect((await ctx.store.listPushSubscriptions(TENANT, ADA.id)).map((s) => s.id)).toEqual(["psh_live"]);
    expect((await ctx.store.listPushSubscriptions(TENANT, ADA.id))[0]!.lastOkAt).not.toBeNull();
    expect([rebound, seen.length]).toEqual([1, 2]);
  });

  it("given a local orchestrator with Ada's browser subscribed, when her task asks a question, goes to review, fails, is stopped and is written again in the same state, and Max's task needs him, then Ada is told each state once with the task's id and the state alone, and Max, who has no browser, is told nothing", async () => {
    // given
    vi.stubEnv("ORCHESTRATOR_MODE", "local");
    const { ctx } = await setup();
    const owner = await setupFirstOwner(ctx.store, TENANT, "code", { code: "code", email: ADA.email, password: "correct horse battery" });
    await createUser(ctx.store, TENANT, new Set(), { email: MAX.email, role: "member", password: "correct horse battery" }, await principalOf(ctx.store, owner));
    const ada = browser();
    await ctx.store.addPushSubscription({ tenant: TENANT, id: "psh_ada", userId: owner.id, endpoint: "https://push.example.invalid/ada", ...ada.keys, createdAt: "2026-11-12T10:00:00.000Z" });
    const task = (id: string, createdBy: string, status: TaskRecord["status"]): TaskRecord => ({ tenant: TENANT, id, repoId: "shop", team: "Shop", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status, createdBy, createdAt: "2026-11-12T10:00:00.000Z", startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null });
    await ctx.store.createTask(task("tsk_ada", ADA.email, "running"));
    await ctx.store.createTask(task("tsk_max", MAX.email, "running"));
    const sent: { url: string; body: Buffer }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const stop = startPushWatch(ctx, fetcher, undefined, publicAddress);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
    const write = async (patch: Parameters<typeof ctx.store.updateTask>[2]) => {
      await ctx.store.updateTask(TENANT, "tsk_ada", patch);
      await settle();
    };

    // when
    await ctx.store.recordTaskRequest({ tenant: TENANT, id: "req_1", taskId: "tsk_ada", targetPosition: null, sourceKey: "k1", kind: "command", payload: { tool: "Bash", summary: "npm test" }, createdAt: "2026-11-12T10:01:00.000Z", expiresAt: null });
    await write({ stage: "working" });
    await write({ stage: "working" });
    await ctx.store.answerTaskRequest(TENANT, "req_1", { decision: "allow_once" }, ADA.email, "web", "2026-11-12T10:02:00.000Z");
    await write({ status: "needs-review" });
    await write({ status: "failed" });
    await write({ status: "interrupted" });
    await write({ status: "interrupted" });
    await ctx.store.updateTask(TENANT, "tsk_max", { status: "needs-review" });
    await settle();
    stop();

    // then
    const states = sent.map((s) => JSON.parse(open(s.body, ada.ecdh, ada.auth)));
    expect(states.map((m) => m.status)).toEqual(["asking", "needs-review", "failed", "interrupted"]);
    expect(states.every((m) => m.taskId === "tsk_ada" && Object.keys(m).sort().join() === "status,taskId")).toBe(true);
    expect(sent.every((s) => s.url === "https://push.example.invalid/ada")).toBe(true);
  });
});
