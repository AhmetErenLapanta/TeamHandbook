import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import type { DeviceEndpoints, DeviceSignIn } from "./device-sign-in.js";
import { deviceClientId, deviceSignInState, forgetPersonForge, personForgeToken, startDeviceSignIn } from "./device-sign-in.js";
import { createUser, principalOf, setupFirstOwner } from "../accounts.js";
import { turnOff } from "../scim.js";

const ENDPOINTS: DeviceEndpoints = { host: "github.example.invalid", code: "https://github.example.invalid/login/device/code", token: "https://github.example.invalid/login/oauth/access_token", user: "https://api.github.example.invalid/user" };
const ADA = { id: "u-ada", email: "ada@example.invalid" };

/** A stand-in forge: hands out a code, answers the token asks in turn from `polls`, and names the account; every call is noted. */
function standInForge(polls: Record<string, unknown>[], code: Record<string, unknown> = { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://github.example.invalid/login/device", interval: 0, expires_in: 900 }) {
  const calls: { url: string; body: string }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    const answer = url === ENDPOINTS.code ? code : url === ENDPOINTS.token ? (polls.shift() ?? { error: "authorization_pending" }) : { login: "ada" };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { send, calls };
}

const context = (vault = true) => ({ store: openSqliteStore(":memory:"), tenant: "acme", vault: vault ? createVault(randomBytes(32)) : null });

async function settled(ctx: ReturnType<typeof context>): Promise<DeviceSignIn> {
  for (let n = 0; n < 800; n++) {
    const state = await deviceSignInState(ctx, ADA, "github");
    if (state.state !== "waiting") return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the sign-in stayed waiting");
}

describe("a person's sign-in to GitHub with a one-time code through the orchestrator's application", () => {
  it("given the person entering the code after one pending answer, when the sign-in runs, then the card gets the code and the page, then the account, and the token is sealed under their own name and outlives the waiting", async () => {
    // given
    const ctx = context();
    const forge = standInForge([{ error: "authorization_pending" }, { access_token: "stand-in-person-token", token_type: "bearer" }]);

    // when
    const started = await startDeviceSignIn(ctx, ADA, "github", "Iv1.stand-in", ENDPOINTS, forge.send);
    const done = await settled(ctx);

    // then
    expect(started).toEqual({ state: "waiting", code: "WDJB-MJHT", url: "https://github.example.invalid/login/device" });
    expect(done).toEqual({ state: "done", account: "ada", host: "github.example.invalid" });
    expect(await personForgeToken(ctx, ADA.id, "github")).toBe("stand-in-person-token");
    expect(JSON.stringify(await ctx.store.getSetting(ctx.tenant, "forge.person.github.u-ada"))).not.toContain("stand-in-person-token");
    expect(forge.calls[0]!.body).toBe("client_id=Iv1.stand-in&scope=repo+read%3Aorg");
  });

  it("given the person refusing on GitHub after a slow_down, when the sign-in runs, then it fails with GitHub's own words and nothing is kept", async () => {
    // given
    const ctx = context();
    const forge = standInForge([{ error: "slow_down" }, { error: "access_denied", error_description: "The user has denied your application access." }]);

    // when
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await startDeviceSignIn(ctx, ADA, "github", "Iv1.stand-in", ENDPOINTS, forge.send);
    await vi.advanceTimersByTimeAsync(1_000);
    const backedOff = await deviceSignInState(ctx, ADA, "github");
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();
    const failed = await deviceSignInState(ctx, ADA, "github");

    // then
    expect(backedOff.state).toBe("waiting");
    expect(forge.calls.filter((c) => c.url === ENDPOINTS.token)).toHaveLength(2);
    expect(failed).toEqual({ state: "failed", error: "github.example.invalid did not sign you in: The user has denied your application access.; press Sign in again" });
    expect(await personForgeToken(ctx, ADA.id, "github")).toBeNull();
  });

  it("given a forge naming a page that is not https, or an orchestrator with no secret key, when the sign-in starts, then it fails at once and no token is asked for", async () => {
    // given
    const plain = standInForge([], { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "http://github.example.invalid/login/device", interval: 0 });
    const noVault = standInForge([]);

    // when
    const notHttps = await startDeviceSignIn(context(), { id: "u-bea", email: "bea@example.invalid" }, "github", "Iv1.stand-in", ENDPOINTS, plain.send);
    const unsealed = await startDeviceSignIn(context(false), { id: "u-cem", email: "cem@example.invalid" }, "github", "Iv1.stand-in", ENDPOINTS, noVault.send);

    // then
    expect(notHttps).toMatchObject({ state: "failed", error: expect.stringContaining("did not start the sign-in") });
    expect(plain.calls.filter((c) => c.url === ENDPOINTS.token)).toEqual([]);
    expect(unsealed).toEqual({ state: "failed", error: "whoever runs the orchestrator sets ORCHESTRATOR_SECRET_KEY first: the token is sealed with it" });
    expect(noVault.calls).toEqual([]);
  });

  it("given a forge naming its page on another host, when the sign-in starts, then the page is no link and nothing is asked further", async () => {
    // given
    const elsewhere = standInForge([], { device_code: "dev-1", user_code: "WDJB-MJHT", verification_uri: "https://elsewhere.example.invalid/login/device", interval: 1 });

    // when
    const started = await startDeviceSignIn(context(), { id: "u-dan", email: "dan@example.invalid" }, "github", "Iv1.stand-in", ENDPOINTS, elsewhere.send);

    // then
    expect(started).toMatchObject({ state: "failed", error: expect.stringContaining("did not start the sign-in") });
    expect(elsewhere.calls.filter((c) => c.url === ENDPOINTS.token)).toEqual([]);
  });

  it("given people signed in, when one signs out, one is turned off by the directory and one's account is deleted, then each one's sealed token and account are gone", async () => {
    // given
    const ctx = context();
    const owner = await principalOf(ctx.store, await setupFirstOwner(ctx.store, "acme", "setup-code", { code: "setup-code", email: "owner@example.invalid", password: "correct horse battery" }));
    const member = await createUser(ctx.store, "acme", new Set(), { email: "eve@example.invalid", role: "member", teams: [] }, owner);
    const turnedOff = await createUser(ctx.store, "acme", new Set(), { email: "fay@example.invalid", role: "member", teams: [] }, owner);
    const people = [ADA, member, turnedOff];
    for (const who of people) await startDeviceSignIn(ctx, who, "github", "Iv1.stand-in", ENDPOINTS, standInForge([{ access_token: `token-of-${who.id}` }]).send);
    for (let n = 0; n < 800; n++) {
      if ((await Promise.all(people.map((who) => personForgeToken(ctx, who.id, "github")))).every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // when
    await forgetPersonForge(ctx.store, ctx.tenant, ADA.id, ["github"]);
    await turnOff(ctx.store, ctx.tenant, turnedOff);
    await ctx.store.deleteUser(ctx.tenant, member.id);

    // then
    for (const who of people) expect(await personForgeToken(ctx, who.id, "github")).toBeNull();
    expect(await deviceSignInState(ctx, ADA, "github")).toEqual({ state: "idle" });
    expect(await ctx.store.getSetting(ctx.tenant, `forge.person.github.${member.id}`)).toBeNull();
    expect(await ctx.store.getSetting(ctx.tenant, `forge.person.github.${turnedOff.id}`)).toBeNull();
  });

  it("given the operator's own application named, or none at all, when the client id is read, then the operator's comes first and the release's empty id offers nothing", () => {
    expect(deviceClientId("github", { ORCHESTRATOR_FORGE_GITHUB_DEVICE_CLIENT_ID: " Iv1.operator " })).toBe("Iv1.operator");
    expect(deviceClientId("gitlab", {})).toBeNull();
  });
});
