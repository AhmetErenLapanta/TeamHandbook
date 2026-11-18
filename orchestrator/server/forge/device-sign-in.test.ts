import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
import { openSqliteStore } from "../store.js";
import { createVault, readSecret, storeSecret } from "../vault.js";
import type { DeviceEndpoints, DeviceSignIn } from "./device-sign-in.js";
import { deviceClientId, deviceSignInState, forgetPersonForge, personForgeToken, personSignedIn, personTokenName, signedInKey, startDeviceSignIn } from "./device-sign-in.js";
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
  it("given the person entering the code after one pending answer, when the sign-in runs, then the card gets the code and the page, then the account, and the token and its refresh token are sealed under their own name and outlive the waiting", async () => {
    // given GitHub's answer for an application that keeps "Expire user access tokens" ticked
    const ctx = context();
    const forge = standInForge([{ error: "authorization_pending" }, { access_token: "stand-in-person-token", expires_in: 28800, refresh_token: "stand-in-refresh", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "repo,read:org" }]);

    // when
    const started = await startDeviceSignIn(ctx, ADA, "github", "Iv1.stand-in", ENDPOINTS, forge.send);
    const done = await settled(ctx);

    // then
    expect(started).toEqual({ state: "waiting", code: "WDJB-MJHT", url: "https://github.example.invalid/login/device" });
    expect(done).toEqual({ state: "done", account: "ada", host: "github.example.invalid" });
    expect(await personForgeToken(ctx, ADA, "github", { endpoints: ENDPOINTS, send: forge.send })).toBe("stand-in-person-token");
    expect(JSON.parse((await readSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("github", ADA.id)))!)).toMatchObject({ refreshToken: "stand-in-refresh", expiresAt: expect.any(String) });
    expect(await ctx.store.getSetting(ctx.tenant, "forge.person.github.u-ada")).not.toMatch(/stand-in-person-token|stand-in-refresh/);
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
    expect(await personSignedIn(ctx, ADA.id, "github")).toBe(false);
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
      if ((await Promise.all(people.map((who) => personSignedIn(ctx, who.id, "github")))).every(Boolean)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // when
    await forgetPersonForge(ctx.store, ctx.tenant, ADA.id, ["github"]);
    await turnOff(ctx.store, ctx.tenant, turnedOff);
    await ctx.store.deleteUser(ctx.tenant, member.id);

    // then
    for (const who of people) expect(await personSignedIn(ctx, who.id, "github")).toBe(false);
    expect(await deviceSignInState(ctx, ADA, "github")).toEqual({ state: "idle" });
    expect(await ctx.store.getSetting(ctx.tenant, `forge.person.github.${member.id}`)).toBeNull();
    expect(await ctx.store.getSetting(ctx.tenant, `forge.person.github.${turnedOff.id}`)).toBeNull();
  });

  it("given the operator's own application named, none at all, or the sign-in turned off, when the client id is read, then the operator's comes first, then the release's, and a forge turned off or with none offers nothing", () => {
    expect(deviceClientId("github", { ORCHESTRATOR_FORGE_GITHUB_DEVICE_CLIENT_ID: " Iv1.operator " })).toBe("Iv1.operator");
    expect(deviceClientId("github", {})).toBe("Ov23liQ8aEvWzyO7lqWs");
    expect(deviceClientId("github", { ORCHESTRATOR_FORGE_GITHUB_DEVICE_CLIENT_ID: " OFF " })).toBeNull();
    expect(deviceClientId("gitlab", {})).toBeNull();
  });
});

const GITLAB: DeviceEndpoints = { host: "gitlab.example.invalid", code: "https://gitlab.example.invalid/oauth/authorize_device", token: "https://gitlab.example.invalid/oauth/token", user: "https://gitlab.example.invalid/api/v4/user" };
const SIGNED_IN = new Date("2026-11-12T09:00:00.000Z");
const hours = (n: number) => new Date(SIGNED_IN.getTime() + n * 3_600_000);

/** Ada signed in to GitLab with a code at SIGNED_IN, sealed as GitLab's device grant answered: a token for two hours and, when given, a refresh token. */
async function adaOnGitLab(refreshToken: string | null = "glrt-1", expiresAt: string | null = hours(2).toISOString()) {
  const ctx = context();
  await storeSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("gitlab", ADA.id), JSON.stringify({ accessToken: "gl-access-1", refreshToken, expiresAt }), ADA.email);
  await ctx.store.setSetting(ctx.tenant, signedInKey("gitlab", ADA.id), JSON.stringify({ account: "ada", host: GITLAB.host }));
  return ctx;
}

/** GitLab's token endpoint and user API: each refresh answers from `renewals` in turn, the user API answers 401 for the tokens in `revoked`; every call is noted. */
function standInGitLab(renewals: { status?: number; body: Record<string, unknown> }[], revoked: string[] = []) {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, body: String(init?.body ?? ""), auth });
    if (url === GITLAB.user) return new Response(JSON.stringify(revoked.some((t) => auth === `Bearer ${t}`) ? { message: "401 Unauthorized" } : { username: "ada" }), { status: revoked.some((t) => auth === `Bearer ${t}`) ? 401 : 200 });
    const next = renewals.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { send, calls, refreshes: () => calls.filter((c) => c.url === GITLAB.token) };
}

const renewed = (access: string, refresh: string) => ({ body: { access_token: access, token_type: "Bearer", expires_in: 7200, refresh_token: refresh, scope: "api write_repository", created_at: 1 } });

describe("a person's code sign-in kept usable past the token's lifetime", () => {
  it("given Ada's GitLab token two hours old, when she presses, then it is renewed once with the application's id and the refresh token alone, the new pair is sealed, and a press before it lapses asks nothing", async () => {
    // given
    const ctx = await adaOnGitLab();
    const gitlab = standInGitLab([renewed("gl-access-2", "glrt-2")]);
    const renewal = { endpoints: GITLAB, clientId: "gl-app", send: gitlab.send };

    // when
    const early = await personForgeToken(ctx, ADA, "gitlab", { ...renewal, now: hours(1) });
    const late = await personForgeToken(ctx, ADA, "gitlab", { ...renewal, now: hours(2) });

    // then
    expect([early, late]).toEqual(["gl-access-1", "gl-access-2"]);
    expect(gitlab.refreshes().map((c) => Object.fromEntries(new URLSearchParams(c.body)))).toEqual([{ grant_type: "refresh_token", client_id: "gl-app", refresh_token: "glrt-1" }]);
    expect(JSON.parse((await readSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("gitlab", ADA.id)))!)).toEqual({ accessToken: "gl-access-2", refreshToken: "glrt-2", expiresAt: hours(4).toISOString() });
    expect(await deviceSignInState(ctx, ADA, "gitlab")).toEqual({ state: "done", account: "ada", host: GITLAB.host });
  });

  it("given two presses at once on a lapsed token, when both ask for it, then GitLab is asked to renew once, since it spends the refresh token, and both get the new token", async () => {
    // given
    const ctx = await adaOnGitLab();
    const gitlab = standInGitLab([renewed("gl-access-2", "glrt-2"), { status: 400, body: { error: "invalid_grant" } }]);
    const renewal = { endpoints: GITLAB, clientId: "gl-app", send: gitlab.send, now: hours(3) };

    // when
    const both = await Promise.all([personForgeToken(ctx, ADA, "gitlab", renewal), personForgeToken(ctx, ADA, "gitlab", renewal)]);

    // then
    expect(both).toEqual(["gl-access-2", "gl-access-2"]);
    expect(gitlab.refreshes()).toHaveLength(1);
  });

  it("given GitLab refusing the refresh token, or a sign-in that gave none, when she presses after it lapsed, then no token comes back, the sealed tokens are gone, and the card says to sign in again without the refresh token in its words", async () => {
    // given
    const refused = await adaOnGitLab();
    const withoutRefresh = await adaOnGitLab(null);
    const gitlab = standInGitLab([{ status: 400, body: { error: "invalid_grant", error_description: "The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client." } }]);
    const renewal = { endpoints: GITLAB, clientId: "gl-app", send: gitlab.send, now: hours(3) };

    // when
    const tokens = [await personForgeToken(refused, ADA, "gitlab", renewal), await personForgeToken(withoutRefresh, ADA, "gitlab", renewal)];

    // then
    expect(tokens).toEqual([null, null]);
    expect(gitlab.refreshes()).toHaveLength(1);
    const cards = [await deviceSignInState(refused, ADA, "gitlab"), await deviceSignInState(withoutRefresh, ADA, "gitlab")];
    expect(cards).toEqual([
      { state: "failed", error: expect.stringMatching(/^your GitLab sign-in lapsed \(GitLab refused: The provided authorization grant is invalid.*\); press Sign in again$/) },
      { state: "failed", error: "your GitLab sign-in lapsed and gave no way to renew it; press Sign in again" },
    ]);
    expect(JSON.stringify(cards)).not.toContain("glrt-1");
    for (const ctx of [refused, withoutRefresh]) {
      expect(await readSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("gitlab", ADA.id))).toBeNull();
      expect(await personSignedIn(ctx, ADA.id, "gitlab", hours(3), "gl-app")).toBe(false);
    }
  });

  it("given a token that does not lapse and that GitLab answers 401 for, when she presses, then it is renewed once and the new token is used; a token sealed before refresh tokens were kept reads as one that does not lapse", async () => {
    // given
    const ctx = await adaOnGitLab("glrt-1", null);
    const old = context();
    await storeSecret(old.store, old.vault, old.tenant, personTokenName("gitlab", ADA.id), "gl-access-sealed-as-text", ADA.email);
    await old.store.setSetting(old.tenant, signedInKey("gitlab", ADA.id), JSON.stringify({ account: "ada", host: GITLAB.host }));
    const gitlab = standInGitLab([renewed("gl-access-2", "glrt-2")], ["gl-access-1"]);
    const renewal = { endpoints: GITLAB, clientId: "gl-app", send: gitlab.send, now: hours(30) };

    // when
    const token = await personForgeToken(ctx, ADA, "gitlab", renewal);
    const oldToken = await personForgeToken(old, ADA, "gitlab", renewal);

    // then
    expect([token, oldToken]).toEqual(["gl-access-2", "gl-access-sealed-as-text"]);
    expect(gitlab.refreshes()).toHaveLength(1);
  });

  it("given GitLab not answering the refresh, when she presses, then she is told to press again and her tokens stay as they were; a screen asking whether she is signed in asks GitLab nothing", async () => {
    // given
    const ctx = await adaOnGitLab();
    const gitlab = standInGitLab([{ status: 502, body: {} }]);

    // when
    const offered = await personSignedIn(ctx, ADA.id, "gitlab", hours(3), "gl-app");
    const askedBefore = gitlab.calls.length;
    const pressing = personForgeToken(ctx, ADA, "gitlab", { endpoints: GITLAB, clientId: "gl-app", send: gitlab.send, now: hours(3) });

    // then
    expect([offered, askedBefore]).toEqual([true, 0]);
    await expect(pressing).rejects.toMatchObject({ status: 409, message: "your GitLab sign-in was not renewed: GitLab refused: answered 502; press again in a minute" });
    expect(JSON.parse((await readSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("gitlab", ADA.id)))!)).toMatchObject({ refreshToken: "glrt-1" });
    expect(await deviceSignInState(ctx, ADA, "gitlab")).toMatchObject({ state: "done" });
  });

  it("given Ada signed in to GitHub with a token that does not lapse, when the operator turns GitHub's code sign-in off, then she is offered nothing and no token is used or asked about", async () => {
    // given
    const ctx = context();
    await storeSecret(ctx.store, ctx.vault, ctx.tenant, personTokenName("github", ADA.id), JSON.stringify({ accessToken: "gh-access-1", refreshToken: null, expiresAt: null }), ADA.email);
    await ctx.store.setSetting(ctx.tenant, signedInKey("github", ADA.id), JSON.stringify({ account: "ada", host: ENDPOINTS.host }));
    const forge = standInForge([]);
    const before = await personForgeToken(ctx, ADA, "github", { endpoints: ENDPOINTS, send: forge.send });

    // when
    vi.stubEnv("ORCHESTRATOR_FORGE_GITHUB_DEVICE_CLIENT_ID", "off");
    const offered = await personSignedIn(ctx, ADA.id, "github");
    const asked = forge.calls.length;
    const token = await personForgeToken(ctx, ADA, "github", { endpoints: ENDPOINTS, send: forge.send });

    // then
    expect(before).toBe("gh-access-1");
    expect([offered, token]).toEqual([false, null]);
    expect(forge.calls).toHaveLength(asked);
  });
});
