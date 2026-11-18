/*
 * Web Push: a person's own browsers, which their push service wakes when a task needs them, with
 * the task's id and its status and nothing else. A subscription is kept for the person who made
 * it, so a teammate never reaches another person's browser.
 */

export interface PushSubscriptionRecord {
  tenant: string;
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  lastOkAt: string | null;
}

export interface PushStore {
  /** Keeps a person's subscription once per endpoint; false when they already have it. */
  addPushSubscription(sub: Omit<PushSubscriptionRecord, "lastOkAt">): Promise<boolean>;
  listPushSubscriptions(tenant: string, userId: string): Promise<PushSubscriptionRecord[]>;
  /** Removes one of the person's subscriptions; false when it is not theirs or is gone. */
  removePushSubscription(tenant: string, userId: string, id: string): Promise<boolean>;
  /** Drops a subscription its push service says is gone, whoever's it was. */
  dropPushEndpoint(tenant: string, endpoint: string): Promise<void>;
  markPushOk(tenant: string, id: string, at: string): Promise<void>;
  /** How many browsers anyone of this tenant has subscribed. */
  countPushSubscriptions(tenant: string): Promise<number>;
}

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { Hono } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { ChangeRefused } from "./changes.js";
import { newId } from "./ids.js";
import { lookup } from "node:dns/promises";
import { internal, remoteUrl } from "./integrations/remote.js";
import { localMode } from "./mode.js";
import { route } from "./route-scopes.js";
import { onAnyTaskWrite } from "./tasks/log-bus.js";
import { NO_VAULT, readSecret, storeSecret } from "./vault.js";

const VAPID_SECRET = "push.vapid";
/** Subscriptions one person keeps, a browser each. */
export const PUSH_PER_PERSON = 5;
const ENDPOINT_MAX = 2048;
const KEY_MAX = 200;
/** A push service that does not answer in this long is left alone: the message is a nudge, never retried. */
export const PUSH_TIMEOUT_MS = 5_000;

const b64url = (buf: Buffer) => buf.toString("base64url");
const unb64url = (text: string) => Buffer.from(text, "base64url");

export interface VapidKeys {
  /** The uncompressed P-256 public key, base64url: what a browser subscribes against. */
  publicKey: string;
  /** The private scalar, base64url. */
  privateKey: string;
}

/** This orchestrator's VAPID pair, made on first use and kept sealed in the vault; null without a vault. */
export async function vapidKeys(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">): Promise<VapidKeys | null> {
  if (!ctx.vault) return null;
  const kept = await readSecret(ctx.store, ctx.vault, ctx.tenant, VAPID_SECRET);
  if (kept) return JSON.parse(kept) as VapidKeys;
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const made: VapidKeys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
  await storeSecret(ctx.store, ctx.vault, ctx.tenant, VAPID_SECRET, JSON.stringify(made), "orchestrator");
  return made;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  return createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** RFC 8291's aes128gcm body for a subscription's keys: the message sealed so only that browser reads it. */
export function encryptPush(message: Buffer, p256dh: string, auth: string): Buffer {
  const receiver = unb64url(p256dh);
  const sender = createECDH("prime256v1");
  const senderPublic = sender.generateKeys();
  const secret = sender.computeSecret(receiver);
  const salt = randomBytes(16);
  const ikm = hkdf(unb64url(auth), secret, Buffer.concat([Buffer.from("WebPush: info\0"), receiver, senderPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([message, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21 + senderPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  senderPublic.copy(header, 21);
  return Buffer.concat([header, body]);
}

/** The VAPID Authorization header value for a push service's origin, valid for twelve hours. */
export function vapidHeader(keys: VapidKeys, origin: string, subject: string, now = Date.now()): string {
  const claims = { aud: origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
  const pub = unb64url(keys.publicKey);
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: "jwk" });
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** What a push carries: the task and where it stands, never a word of what it did. */
export interface PushMessage {
  taskId: string;
  status: "needs-review" | "asking" | "failed" | "interrupted";
}

/** The addresses a host resolves to now, as the system's resolver gives them. */
export type PushResolver = (host: string) => Promise<string[]>;
const systemResolver: PushResolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Sends one message to one subscription; false when its push service says the subscription is gone.
 * The endpoint is checked again as it is sent: it was public when it was kept, and a name can be
 * pointed at a private address since, so one that resolves to this machine or a private network is
 * not called and is left alone.
 */
export async function sendPush(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault" | "publicUrl">, sub: PushSubscriptionRecord, message: PushMessage, fetcher: typeof fetch = fetch, resolve: PushResolver = systemResolver): Promise<boolean> {
  const keys = await vapidKeys(ctx);
  if (!keys) return true;
  const local = process.env.ORCHESTRATOR_PUSH_LOCAL === "1";
  let url: URL;
  try {
    url = remoteUrl(sub.endpoint, "the endpoint", local);
  } catch {
    return false;
  }
  if (!local && (await resolve(url.hostname).catch(() => ["0.0.0.0"])).some((address) => internal(address))) return true;
  const response = await fetcher(sub.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: "3600",
      urgency: "normal",
      authorization: vapidHeader(keys, url.origin, ctx.publicUrl ?? "mailto:orchestrator@localhost.invalid"),
    },
    body: new Uint8Array(encryptPush(Buffer.from(JSON.stringify(message)), sub.p256dh, sub.auth)),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  }).catch(() => null);
  if (response?.status === 404 || response?.status === 410) return false;
  if (response?.ok) await ctx.store.markPushOk(ctx.tenant, sub.id, new Date().toISOString());
  return true;
}

/** Wakes a person's browsers about a task of theirs; a subscription its push service dropped is forgotten. */
export async function notifyPerson(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault" | "publicUrl">, userId: string, message: PushMessage, fetcher: typeof fetch = fetch, resolve?: PushResolver): Promise<number> {
  let sent = 0;
  for (const sub of await ctx.store.listPushSubscriptions(ctx.tenant, userId)) {
    if (await sendPush(ctx, sub, message, fetcher, resolve)) sent++;
    else await ctx.store.dropPushEndpoint(ctx.tenant, sub.endpoint);
  }
  return sent;
}

/** The key a browser subscribes against, and a person's own subscriptions: signed in, never a key, never another person's. */
export function pushRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/push/key", async (c) => {
    if (!localMode()) return c.json({ error: "notices with the page closed are for a local orchestrator; a team's tell only an open page", code: "local-only" }, 409);
    const keys = await vapidKeys(ctx);
    return keys ? c.json({ publicKey: keys.publicKey }) : c.json({ error: NO_VAULT, code: "no-vault" }, 409);
  });
  route(app, "POST /api/push/subscriptions", async (c) => {
    const user = c.get("user");
    if (!localMode()) return c.json({ error: "notices with the page closed are for a local orchestrator; a team's tell only an open page", code: "local-only" }, 409);
    if (user.key) return c.json({ error: "only a person's own session subscribes a browser", code: "session-only" }, 403);
    const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const { p256dh, auth } = body?.keys ?? {};
    if (typeof body?.endpoint !== "string" || body.endpoint.length > ENDPOINT_MAX || typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > KEY_MAX || auth.length > KEY_MAX || unb64url(p256dh).length !== 65 || unb64url(auth).length !== 16) {
      return c.json({ error: "a subscription names its endpoint and its p256dh and auth keys", code: "bad-subscription" }, 400);
    }
    try {
      remoteUrl(body.endpoint, "the endpoint", process.env.ORCHESTRATOR_PUSH_LOCAL === "1");
    } catch (err) {
      if (err instanceof ChangeRefused) return c.json({ error: err.message, code: "bad-endpoint" }, 400);
      throw err;
    }
    if (!(await vapidKeys(ctx))) return c.json({ error: NO_VAULT, code: "no-vault" }, 409);
    if ((await ctx.store.listPushSubscriptions(ctx.tenant, user.id)).length >= PUSH_PER_PERSON) return c.json({ error: `a person keeps at most ${PUSH_PER_PERSON} browsers; remove one first`, code: "too-many" }, 409);
    const id = newId("psh");
    await ctx.store.addPushSubscription({ tenant: ctx.tenant, id, userId: user.id, endpoint: body.endpoint, p256dh, auth, createdAt: new Date().toISOString() });
    return c.json({ id });
  });
  route(app, "GET /api/push/subscriptions", async (c) => c.json({ subscriptions: (await ctx.store.listPushSubscriptions(ctx.tenant, c.get("user").id)).map((s) => ({ id: s.id, createdAt: s.createdAt, lastOkAt: s.lastOkAt })) }));
  route(app, "DELETE /api/push/subscriptions/:id", async (c) => ((await ctx.store.removePushSubscription(ctx.tenant, c.get("user").id, c.req.param("id") ?? "")) ? c.body(null, 204) : c.json({ error: "no such subscription", code: "not-found" }, 404)));
  return app;
}

/** How long the answer to "does anyone have a browser subscribed" is kept, so a busy log costs no query per line. */
const SUBSCRIBED_FOR_MS = 60_000;

/**
 * Wakes a task's person when it changes into a state that needs them: asking something, in review,
 * failed or stopped. Reads each write only while someone has a browser subscribed, says each state
 * once, and sends only the task's id and the state.
 */
export function startPushWatch(ctx: OrchestratorContext, fetcher: typeof fetch = fetch, now: () => number = Date.now, resolve?: PushResolver): () => void {
  if (!localMode()) return () => undefined;
  const told = new Map<string, string>();
  let anyoneUntil = 0;
  let anyone = false;
  const subscribed = async (): Promise<boolean> => {
    if (now() >= anyoneUntil) {
      anyone = (await ctx.store.countPushSubscriptions(ctx.tenant)) > 0;
      anyoneUntil = now() + SUBSCRIBED_FOR_MS;
    }
    return anyone;
  };
  return onAnyTaskWrite(ctx.tenant, (taskId) => {
    void (async () => {
      if (!(await subscribed())) return;
      const task = await ctx.store.getTask(ctx.tenant, taskId);
      if (!task) return;
      const asking = task.status === "running" && (await ctx.store.taskRequests(ctx.tenant, taskId)).some((r) => r.status === "pending");
      const state = asking ? "asking" : task.status;
      const last = told.get(taskId);
      if (told.size > 5000) told.clear();
      told.set(taskId, state);
      if (last === state || !(state === "asking" || state === "needs-review" || state === "failed" || state === "interrupted")) return;
      const person = await ctx.store.getUserByEmail(ctx.tenant, task.createdBy);
      if (person) await notifyPerson(ctx, person.id, { taskId, status: state }, fetcher, resolve);
    })().catch(() => undefined);
  });
}
