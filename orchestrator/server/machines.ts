import { createHash } from "node:crypto";
import { RUNNER_CONNECT, connectCommand } from "../shared/runner-command.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { clientFrom, principalOf } from "./accounts.js";
import type { OrchestratorContext } from "./app.js";
import { manages, seen } from "./auth.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { recordEvent } from "./events.js";
import { newId } from "./ids.js";
import { MACHINE_AWAY_MS } from "./tasks/runner.js";
import type { Scopes } from "./keys.js";
import { tooMany, windowLimiter } from "./limits.js";
import { route } from "./route-scopes.js";
import type { MachineRecord } from "./runner-store.js";
import { checkRunnerSignature, cleanPairingCode, codeHash, PAIRING_MINUTES, pairingCode, publicKeyOf, RUNNER_PROTOCOL, RUNNER_TOKEN_PREFIX, runnerToken, SIGNATURE_HEADER, SKEW_SECONDS } from "./runner-auth.js";
import { suspended } from "./scim.js";

/** How many unused codes one person holds at once: enough to pair a second machine while the first code waits. */
const OPEN_PAIRINGS = 3;

/** What a machine reaches when it calls in for its person: their own tasks and requests, never members, settings or keys. */
export const MACHINE_SCOPES: Scopes = { repositories: "read", requests: "write", tasks: "write", usage: "none", members: "none", settings: "none", keys: "none" };

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Each agent a machine reports, by the name people know it by and the command its person runs
 * there to sign in. Decided here from the agent's id, never taken from the machine: the screen
 * offers the command to copy and run.
 */
const MACHINE_AGENTS: Record<string, { label: string; signInCommand: string }> = {
  "claude-code": { label: "Claude Code", signInCommand: "claude auth login" },
  opencode: { label: "OpenCode", signInCommand: "opencode auth login" },
};

/**
 * A machine as Settings shows it: never its key or token. It is online while its runner calls in:
 * a runner polls every 25 s and its time is written at most once a minute, so a machine heard from
 * within MACHINE_AWAY_MS is up.
 */
function machineView(m: MachineRecord, now = Date.now()) {
  const online = m.revokedAt === null && m.lastSeenAt !== null && now - Date.parse(m.lastSeenAt) < MACHINE_AWAY_MS;
  const agents = m.agents.map((a) => ({ ...a, label: MACHINE_AGENTS[a.id]?.label ?? a.id, signInCommand: MACHINE_AGENTS[a.id]?.signInCommand ?? null }));
  return { id: m.id, userId: m.userId, name: m.name, platform: m.platform, agents, online, createdAt: m.createdAt, lastSeenAt: m.lastSeenAt, revokedAt: m.revokedAt };
}

/** The machines a person pairs, sees and disconnects; an owner or an admin sees and disconnects everyone's. */
export function machineRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;

  route(app, "GET /api/machines", async (c) => {
    const me = c.get("user");
    return c.json({ machines: (await store.listMachines(ctx.tenant, manages(me) ? null : me.id)).map((m) => machineView(m)) });
  });

  route(app, "POST /api/machines/pair", async (c) => {
    const me = c.get("user");
    if (me.key) return c.json({ error: "a machine is paired by a person signed in, not by an API key" }, 403);
    if (me.role === "viewer") return c.json({ error: "a viewer starts no task, so pairs no machine to run one" }, 403);
    const now = new Date();
    if ((await store.countOpenPairings(ctx.tenant, me.id, now.toISOString())) >= OPEN_PAIRINGS) return c.json({ error: `you hold ${OPEN_PAIRINGS} unused codes; use one or wait ${PAIRING_MINUTES} minutes` }, 429);
    const code = pairingCode();
    const expiresAt = new Date(now.getTime() + PAIRING_MINUTES * 60_000).toISOString();
    await store.savePairing({ tenant: ctx.tenant, codeHash: codeHash(cleanPairingCode(code)!), userId: me.id, expiresAt });
    // The organization's own address, which every orchestrator answers whether it serves one organization or many:
    // the machine sends to it as given and signs the path below it.
    const address = `${(ctx.publicUrl ?? new URL(c.req.url).origin).replace(/\/+$/, "")}/api/orgs/${encodeURIComponent(ctx.tenant)}`;
    return c.json({ code, expiresAt, address, command: connectCommand(address, code) });
  });

  route(app, "DELETE /api/machines/:id", async (c) => {
    const me = c.get("user");
    const machine = (await store.listMachines(ctx.tenant, null)).find((m) => m.id === c.req.param("id") && !m.revokedAt);
    // Someone else's machine reads as none, so nobody learns which ids are in use.
    if (!machine || (machine.userId !== me.id && !manages(me))) return c.json({ error: "no machine of yours has that id" }, 404);
    await store.revokeMachine(ctx.tenant, machine.id, new Date().toISOString());
    await recordEvent(ctx, me, "machine.disconnected", { subject: `machine:${machine.id}`, detail: `${machine.name} no longer runs tasks; any task it held is interrupted` });
    return c.json({ ok: true });
  });

  return app;
}

/** What a machine reaches before it holds a token: who it is talking to, and the claim of a code. */
export function runnerOpenRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const store = ctx.store;
  const from = clientFrom(ctx.trustedProxies ?? []);
  // A code is 60 bits and lives five minutes; this keeps a client from trying codes by the thousand.
  const claims = windowLimiter(10);

  // The runner checks these before it sends its token, so a token never goes to another orchestrator or organization.
  route(app, "GET /api/runner/hello", (c) => c.json({ protocol: RUNNER_PROTOCOL, org: ctx.tenant }));

  route(app, "POST /api/runner/claim", async (c) => {
    const verdict = claims(`claim:${from(c)}`);
    if (!verdict.ok) return tooMany(c, verdict, "too many codes tried; wait a minute");
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; name?: unknown; platform?: unknown; publicKey?: unknown };
    const code = cleanPairingCode(body.code);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const platform = typeof body.platform === "string" ? body.platform.trim() : "";
    if (!code || !publicKeyOf(body.publicKey) || !name || name.length > 80 || !platform || platform.length > 40) return c.json({ error: "send the code shown in Settings, the machine's name and platform, and its public key" }, 400);
    const now = new Date();
    const taken = await store.takePairing(ctx.tenant, codeHash(code), now.toISOString());
    if (!taken) return c.json({ error: "that code is unknown, used or expired; make a new one in Settings" }, 400);
    const person = await store.getUser(ctx.tenant, taken.userId);
    if (!person || (await suspended(store, ctx.tenant, person.id))) return c.json({ error: "that code is unknown, used or expired; make a new one in Settings" }, 400);
    const token = runnerToken();
    const machine: MachineRecord = { tenant: ctx.tenant, id: newId("mch"), userId: person.id, name, platform, publicKey: body.publicKey as string, agents: [], createdAt: now.toISOString(), lastSeenAt: null, revokedAt: null };
    if (!(await store.insertMachine({ ...machine, tokenHash: tokenHash(token) }, null))) return c.json({ error: "this organization has as many machines as its plan allows" }, 409);
    await recordEvent(ctx, await principalOf(store, person), "machine.connected", { subject: `machine:${machine.id}`, detail: `${name} (${platform}) now runs their tasks` });
    return c.json({ machineId: machine.id, token });
  });

  // A machine that disconnects ends its own token, so a profile deleted on it leaves nothing that still works.
  route(app, "POST /api/runner/disconnect", async (c) => {
    const who = await runnerOf(c, ctx);
    if (who instanceof Response) return who;
    await store.revokeMachine(ctx.tenant, who.machine.id, new Date().toISOString());
    await recordEvent(ctx, who.user, "machine.disconnected", { subject: `machine:${who.machine.id}`, detail: `${who.machine.name} disconnected itself; any task it held is interrupted` });
    return c.body(null, 204);
  });

  return app;
}

/**
 * The machine calling, and its person as they are now, for a call signed by that machine's key;
 * the answer that refuses it otherwise. The token names the machine, the signature proves the
 * machine still holds its key, and the nonce is taken once, so a call copied off the wire does
 * not work twice. The path signed is the one under the organization, as the CLI sends it.
 */
export async function runnerOf(c: Context<OrchestratorEnv>, ctx: OrchestratorContext): Promise<{ machine: MachineRecord; user: Principal } | Response> {
  const refused = () => c.json({ error: `this machine is not connected; run ${RUNNER_CONNECT} again` }, 401);
  const bearer = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
  if (!bearer.startsWith(RUNNER_TOKEN_PREFIX)) return refused();
  const machine = await ctx.store.machineByToken(tokenHash(bearer));
  const key = machine && machine.tenant === ctx.tenant ? publicKeyOf(machine.publicKey) : null;
  if (!machine || !key) return refused();
  const url = new URL(c.req.url);
  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const nonce = checkRunnerSignature(key, c.req.header(SIGNATURE_HEADER), { method: c.req.method, path: `${url.pathname}${url.search}`, body });
  if (!nonce) return refused();
  if (!(await ctx.store.takeNonce(ctx.tenant, machine.id, nonce, new Date(Date.now() + 2 * SKEW_SECONDS * 1000).toISOString()))) return refused();
  const person = await ctx.store.getUser(ctx.tenant, machine.userId);
  if (!person || (await suspended(ctx.store, ctx.tenant, person.id))) return refused();
  await seen(`machine:${machine.id}`, (at) => ctx.store.touchMachine(ctx.tenant, machine.id, at));
  const user = await principalOf(ctx.store, person);
  return { machine, user: { ...user, key: { id: `machine:${machine.id}`, owner: { kind: "user", id: person.id }, scopes: MACHINE_SCOPES, expiresAt: null } } };
}

/** Whether this machine holds the task under this lease now; a task route answers 404 otherwise, as for a task that is not there. */
export async function runnerHolds(ctx: OrchestratorContext, machine: MachineRecord, taskId: string, leaseId: string | undefined): Promise<boolean> {
  const lease = await ctx.store.taskLease(ctx.tenant, taskId);
  return Boolean(lease && leaseId && lease.runner === "local" && lease.claimedBy === machine.id && lease.leaseId === leaseId && lease.leaseUntil && lease.leaseUntil > new Date().toISOString());
}
