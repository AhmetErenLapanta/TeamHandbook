import { describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner } from "./accounts.js";
import { createApp } from "./app.js";
import { createKey } from "./keys.js";
import { keyGate, limitedNotes, PER_ACCOUNT_PER_MINUTE, PER_KEY_PER_MINUTE, windowLimiter } from "./limits.js";
import { openSqliteStore } from "./store.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PASSWORD = "correct horse battery";

describe("the one rate limiter", () => {
  it("given three calls a minute allowed, when a fourth comes 20 seconds after the first, then it is refused with 40 seconds to wait, and passes once the first leaves the window", () => {
    // given
    let t = 0;
    const limit = windowLimiter(3, () => t);
    limit("k");
    t = 10_000;
    limit("k");
    limit("k");

    // when
    t = 20_000;
    const refused = limit("k");
    t = 60_001;
    const later = limit("k");

    // then
    expect(refused).toEqual({ ok: false, retryAfter: 40 });
    expect(later).toEqual({ ok: true, retryAfter: 0 });
    expect(limit("other").ok).toBe(true);
  });

  it("given a key past its own budget and an account past the budget of all its keys, when each calls, then each is held back and says which budget", () => {
    // given
    const gate = keyGate(() => 0);
    const owner = { kind: "user", id: "u1" };
    for (let i = 0; i < PER_KEY_PER_MINUTE; i++) gate({ tenant: TENANT, keyId: "k1", owner });
    let accountVerdict = gate({ tenant: TENANT, keyId: "k2", owner });
    for (let i = 1; accountVerdict.ok && i < PER_ACCOUNT_PER_MINUTE; i++) accountVerdict = gate({ tenant: TENANT, keyId: `k-${i % 100}`, owner });

    // when
    const keyVerdict = gate({ tenant: TENANT, keyId: "k1", owner });
    const elsewhere = gate({ tenant: "globex", keyId: "k1", owner });

    // then
    expect(keyVerdict).toMatchObject({ ok: false, limit: "key", retryAfter: 60 });
    expect(accountVerdict).toMatchObject({ ok: false, limit: "account" });
    expect(elsewhere.ok).toBe(true);
  });
});

describe("a key held back at the API", () => {
  async function keyed() {
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }));
    const max = await principalOf(store, await createUser(store, TENANT, new Set(), { email: `max-${Math.random()}@example.invalid`, role: "member" }, owner));
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const key = await createKey(store, TENANT, max, { name: "ci", scopes: { usage: "read" } });
    const other = await createKey(store, TENANT, owner, { name: "ci", scopes: { usage: "read" } });
    const call = (secret: string) => app.request("/api/usage", { headers: { authorization: `Bearer ${secret}` } });
    return { store, key, other, call };
  }

  it("given a key that made its minute's calls, when it calls again, then it gets 429 with Retry-After, and another person's key still answers", async () => {
    // given
    const { key, other, call } = await keyed();
    for (let i = 0; i < PER_KEY_PER_MINUTE; i++) expect((await call(key.secret)).status).toBe(200);

    // when
    const held = await call(key.secret);

    // then
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await held.json()).error).toMatch(/more than 120 calls in a minute/);
    expect((await call(other.secret)).status).toBe(200);
  });

  it("given a key held back again and again, when the event log is read, then it says so once", async () => {
    // given
    const { store, key, call } = await keyed();
    for (let i = 0; i < PER_KEY_PER_MINUTE; i++) await call(key.secret);

    // when
    for (let i = 0; i < 5; i++) await call(key.secret);
    const { events } = await store.eventPage(TENANT, {}, null, 50);

    // then
    expect(events.filter((e) => e.kind === "key.rate-limited")).toHaveLength(1);
  });

  it("given the notes of a held-back key, when ten minutes pass, then the next refusal is written again", async () => {
    // given
    let t = 0;
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD }));
    const note = limitedNotes(() => t);

    // when
    await note({ store, tenant: TENANT }, owner, "k1", "key");
    t = 5 * 60_000;
    await note({ store, tenant: TENANT }, owner, "k1", "key");
    t = 10 * 60_000 + 1;
    await note({ store, tenant: TENANT }, owner, "k1", "key");

    // then
    expect((await store.eventPage(TENANT, {}, null, 10)).events.filter((e) => e.kind === "key.rate-limited")).toHaveLength(2);
  });
});

describe("the sign-in and invitation limits answer the same way", () => {
  it("given an address past its ten sign-in attempts, when it tries again, then the answer is 429 with how long to wait", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const login = () => app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ada@example.invalid", password: "wrong password here" }) });
    for (let i = 0; i < 10; i++) await login();

    // when
    const held = await login();

    // then
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("given one client past thirty join attempts, when it reads another invitation, then the answer is 429 with how long to wait", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: PASSWORD });
    const app = createApp({ store, dataDir: "unused", tenant: TENANT, allowedHosts: null });
    const read = () => app.request("/api/join/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "not-a-token" }) });
    for (let i = 0; i < 30; i++) await read();

    // when
    const held = await read();

    // then
    expect(held.status).toBe(429);
    expect(Number(held.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
