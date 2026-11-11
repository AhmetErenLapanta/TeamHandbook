import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { finishOidcSignIn, setupFirstOwner } from "./accounts.js";
import { hashToken } from "./auth.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { checkClaims, createOidcClient, oidcConfigFromEnv, tenantIssuer } from "./oidc.js";
import { readSecretEnv } from "./secret-env.js";
import { openSqliteStore } from "./store.js";
import type { OidcConfig } from "./oidc.js";
import { vaultFromEnv } from "./vault.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface FakeProvider {
  config: OidcConfig;
  /** Claims the next token carries, merged over a valid set. */
  claims: Record<string, unknown>;
  /** Signs with a key the provider does not publish when set. */
  rogueKey: boolean;
  /** The nonce the authorization request carried, which a provider puts back into the token. */
  nonce: string;
  tokenRequests: { body: URLSearchParams; authorization: string | undefined }[];
}

/**
 * A provider on 127.0.0.1 with a generated RSA key: discovery, a JWKS, and a token endpoint
 * that answers any code with an ID token for whatever claims the test asks for.
 */
async function fakeProvider(): Promise<FakeProvider> {
  const published = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rogue = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...published.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const state: FakeProvider = { config: null as unknown as OidcConfig, claims: {}, rogueKey: false, nonce: "", tokenRequests: [] };
  const server = createServer((req, res) => {
    const issuer = state.config.issuer;
    const json = (body: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (req.url === "/jwks") return json({ keys: [jwk] });
    if (req.url === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        state.tokenRequests.push({ body: new URLSearchParams(raw), authorization: req.headers.authorization });
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
        const payload = Buffer.from(
          JSON.stringify({ iss: issuer, aud: state.config.clientId, sub: "user-42", email: "kim@example.invalid", email_verified: true, nonce: state.nonce, iat: now, exp: now + 300, ...state.claims }),
        ).toString("base64url");
        const signature = sign("sha256", Buffer.from(`${header}.${payload}`), state.rogueKey ? rogue.privateKey : published.privateKey).toString("base64url");
        json({ id_token: `${header}.${payload}.${signature}`, access_token: "unused", token_type: "Bearer" });
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.config = { issuer, clientId: "orchestrator", clientSecret: "client-secret-value", redirectUrl: "https://orchestrator.example.invalid/api/auth/oidc/callback", groupsClaim: "groups" };
  return state;
}

async function signIn(provider: FakeProvider, claims: Record<string, unknown> = {}) {
  provider.claims = claims;
  const client = createOidcClient(provider.config);
  const { url, login } = await client.start();
  provider.nonce = new URL(url).searchParams.get("nonce")!;
  const identity = await client.finish("the-code", { nonce: login.nonce, verifier: login.verifier });
  return { url: new URL(url), login, identity };
}

describe("single sign-on against an OpenID Connect provider", () => {
  it("given a provider that signs a valid ID token, when a sign-in completes, then the identity is its issuer and subject, and the code was exchanged with PKCE and the client's credentials", async () => {
    // given
    const provider = await fakeProvider();

    // when
    const { url, login, identity } = await signIn(provider);

    // then
    expect(identity).toEqual({ issuer: provider.config.issuer, subject: "user-42", email: "kim@example.invalid", claims: expect.objectContaining({ sub: "user-42" }) });
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(login.state);
    expect(url.searchParams.get("nonce")).toBe(login.nonce);
    const exchange = provider.tokenRequests[0]!;
    expect(exchange.body.get("code_verifier")).toBe(login.verifier);
    expect(exchange.body.get("redirect_uri")).toBe(provider.config.redirectUrl);
    expect(exchange.authorization).toBe(`Basic ${Buffer.from("orchestrator:client-secret-value").toString("base64")}`);
  });

  it("given a token signed with a key the provider does not publish, when the sign-in completes, then it is refused", async () => {
    // given
    const provider = await fakeProvider();
    provider.rogueKey = true;

    // when
    const attempt = signIn(provider);

    // then
    await expect(attempt).rejects.toThrow(/signature/);
  });

  it.each([
    ["another issuer", { iss: "https://elsewhere.example.invalid" }, /another issuer/],
    ["another audience", { aud: "someone-else" }, /another client/],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/],
    ["no subject", { sub: "" }, /no subject/],
  ])("given a token with %s, when the sign-in completes, then it is refused", async (_label, claims, message) => {
    // given
    const provider = await fakeProvider();

    // when
    const attempt = signIn(provider, claims);

    // then
    await expect(attempt).rejects.toThrow(message);
  });

  it("given a token minted for another sign-in's nonce, when it completes this one, then it is refused", async () => {
    // given
    const provider = await fakeProvider();

    // when
    const attempt = signIn(provider, { nonce: "a-nonce-from-another-sign-in" });

    // then
    await expect(attempt).rejects.toThrow(/another sign-in/);
  });

  it("given a token that does not say whether the address is verified, when the claims are checked, then the identity carries no address", () => {
    const config = { issuer: "https://idp.example.invalid", clientId: "orchestrator", clientSecret: "s", redirectUrl: "https://c.example.invalid/cb", groupsClaim: "groups" };
    const now = Date.now();
    const identity = checkClaims({ iss: config.issuer, aud: "orchestrator", sub: "u", exp: now / 1000 + 60, nonce: "n", email: "x@example.invalid" }, config, "n", now);
    expect(identity.email).toBeUndefined();
  });

  it("given issuer addresses, when the configuration is read, then plain http is refused unless the issuer is on this machine", () => {
    const env = (issuer: string) => ({ ORCHESTRATOR_OIDC_ISSUER: issuer, ORCHESTRATOR_OIDC_CLIENT_ID: "c", ORCHESTRATOR_OIDC_CLIENT_SECRET: "s" });
    expect(() => oidcConfigFromEnv(env("http://idp.example.com"), "https://orchestrator.example.com")).toThrow(/https/);
    expect(oidcConfigFromEnv(env("http://127.0.0.1:9000"), "https://orchestrator.example.com")!.issuer).toBe("http://127.0.0.1:9000");
    expect(oidcConfigFromEnv(env("https://idp.example.com/"), "https://orchestrator.example.com")!.issuer).toBe("https://idp.example.com");
  });

  it("given an address the provider has not verified, when the claims are checked, then the identity carries no address", () => {
    // given
    const config = { issuer: "https://idp.example.invalid", clientId: "orchestrator", clientSecret: "s", redirectUrl: "https://c.example.invalid/cb", groupsClaim: "groups" };
    const now = Date.now();

    // when
    const identity = checkClaims({ iss: config.issuer, aud: "orchestrator", sub: "u", exp: now / 1000 + 60, nonce: "n", email: "x@example.invalid", email_verified: false }, config, "n", now);

    // then
    expect(identity.email).toBeUndefined();
  });
});

describe("the provider's redirect back to the orchestrator", () => {
  async function started(tenant = "acme") {
    const provider = await fakeProvider();
    const client = createOidcClient(provider.config);
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, tenant, "code", { code: "code", email: "ada@example.invalid", password: "a long admin password" });
    const { login } = await client.start();
    await store.saveOidcLogin({ ...login, tenant });
    provider.nonce = login.nonce;
    return { provider, client, store, login };
  }

  it("given a sign-in this browser started, when the provider redirects back, then a member is created and signed in", async () => {
    // given
    const { client, store, login } = await started();

    // when
    const { session } = await finishOidcSignIn(store, "acme", client, { state: login.state, code: "the-code", cookieState: login.state });

    // then
    const stored = await store.getSession(hashToken(session.token));
    expect(stored).toMatchObject({ tenant: "acme" });
    expect(await store.getUser("acme", stored!.userId)).toMatchObject({ role: "member", email: "kim@example.invalid", oidcSubject: "user-42" });
  });

  it.each([
    ["a state cookie from another sign-in", (state: string) => ({ state, code: "c", cookieState: "another-state" })],
    ["no state cookie", (state: string) => ({ state, code: "c" })],
    ["no code", (state: string) => ({ state, cookieState: state })],
  ])("given %s, when the provider redirects back, then it is refused and nobody is signed in", async (_label, input) => {
    // given
    const { client, store, login } = await started();

    // when
    const attempt = finishOidcSignIn(store, "acme", client, input(login.state));

    // then
    await expect(attempt).rejects.toThrow(/did not start in this browser/);
    expect(await store.countUsers("acme")).toBe(1);
  });

  it("given a state that already answered once, when it comes back again, then the second is refused", async () => {
    // given
    const { client, store, login } = await started();
    const input = { state: login.state, code: "the-code", cookieState: login.state };
    await finishOidcSignIn(store, "acme", client, input);

    // when
    const replay = finishOidcSignIn(store, "acme", client, input);

    // then
    await expect(replay).rejects.toThrow(/expired/);
  });

  it("given a sign-in older than its ten minutes, when the provider redirects back, then it is refused and nobody is signed in", async () => {
    // given
    const { client, store, login } = await started();

    // when
    const late = finishOidcSignIn(store, "acme", client, { state: login.state, code: "c", cookieState: login.state }, new Date(Date.now() + 11 * 60_000));

    // then
    await expect(late).rejects.toThrow(/expired/);
    expect(await store.countUsers("acme")).toBe(1);
  });

  it("given a sign-in started for another tenant, when it comes back to this one, then it is refused", async () => {
    // given
    const { client, store, login } = await started("other");

    // when
    const attempt = finishOidcSignIn(store, "acme", client, { state: login.state, code: "c", cookieState: login.state });

    // then
    await expect(attempt).rejects.toThrow(/expired/);
    expect(await store.countUsers("acme")).toBe(0);
  });
});

describe("starting single sign-on when the provider does not answer", () => {
  it("given a provider whose discovery fails, when a sign-in starts, then the answer is a JSON error and no state is kept", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "a long admin password" });
    const oidc = createOidcClient({ issuer: "http://127.0.0.1:9", clientId: "c", clientSecret: "s", redirectUrl: "https://c.example.invalid/cb", groupsClaim: "groups" });
    const app = createApp({ store, dataDir: "unused", tenant: "acme", allowedHosts: null, oidc });

    // when
    const res = await app.request("/api/auth/oidc/start");

    // then
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "the identity provider did not answer; try again in a moment", code: "upstream" });
  });
});

describe("a secret setting from a file", () => {
  const file = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "orchestrator-secret-")), "secret");
    writeFileSync(path, text);
    return path;
  };

  it("given the value directly or in a file, when it is read, then both give the value and a file's trailing newline is not part of it", () => {
    expect(readSecretEnv({ ORCHESTRATOR_X: "s3cret" }, "ORCHESTRATOR_X")).toBe("s3cret");
    expect(readSecretEnv({ ORCHESTRATOR_X_FILE: file("s3cret\n") }, "ORCHESTRATOR_X")).toBe("s3cret");
    expect(readSecretEnv({}, "ORCHESTRATOR_X")).toBeUndefined();
  });

  it.each([
    ["both set", () => ({ ORCHESTRATOR_X: "a", ORCHESTRATOR_X_FILE: file("b") }), /not both/],
    ["a missing file", () => ({ ORCHESTRATOR_X_FILE: "/nonexistent/secret" }), /cannot read/],
    ["an empty file", () => ({ ORCHESTRATOR_X_FILE: file("\n") }), /empty file/],
  ])("given %s, when it is read, then the orchestrator refuses to start", (_label, env, message) => {
    expect(() => readSecretEnv(env(), "ORCHESTRATOR_X")).toThrow(message);
  });

  it("given the orchestrator's secret key in a file, when the vault is opened, then it seals with that key, and the key in both forms stops the orchestrator", () => {
    const key = randomBytes(32).toString("base64");
    const vault = vaultFromEnv({ ORCHESTRATOR_SECRET_KEY_FILE: file(`${key}\n`) })!;
    const sealed = vault.seal("acme", "forge:payments-skills", "glpat-example-token");
    expect(vaultFromEnv({ ORCHESTRATOR_SECRET_KEY: key })!.open("acme", "forge:payments-skills", sealed)).toBe("glpat-example-token");
    expect(() => vaultFromEnv({ ORCHESTRATOR_SECRET_KEY: key, ORCHESTRATOR_SECRET_KEY_FILE: file(key) })).toThrow(/not both/);
  });

  it("given the OIDC client secret in a file, when the configuration is read, then it is used", () => {
    const env = { ORCHESTRATOR_OIDC_ISSUER: "https://idp.example.com", ORCHESTRATOR_OIDC_CLIENT_ID: "c", ORCHESTRATOR_OIDC_CLIENT_SECRET_FILE: file("from-a-file\n") };
    expect(oidcConfigFromEnv(env, "https://orchestrator.example.com")!.clientSecret).toBe("from-a-file");
  });
});

describe("a provider that signs people of many directories in at one address", () => {
  it("given a token's directory id, when the issuer it has to name is worked out, then it is the template with that id, and a token naming no directory id or a made-up one is refused", () => {
    // given
    const template = "https://login.example.invalid/{tenantid}/v2.0";

    // when
    const issuer = tenantIssuer(template, { tid: "7d1f4c52-0b9e-4a36-9c11-5e2f8a0c3b47" });

    // then
    expect(issuer).toBe("https://login.example.invalid/7d1f4c52-0b9e-4a36-9c11-5e2f8a0c3b47/v2.0");
    expect(() => tenantIssuer(template, {})).toThrow("names no directory");
    expect(() => tenantIssuer(template, { tid: "common/../evil" })).toThrow("names no directory");
  });
});
