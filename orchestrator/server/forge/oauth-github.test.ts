import { createHmac, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { principalOf, setupFirstOwner, startSession } from "../accounts.js";
import { createApp } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { CSRF_HEADER, sessionCookie } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { createVault } from "../vault.js";
import { connectionToken, forgeIssueAccess, forgetRefusedToken, forgetVerified } from "./oauth-access.js";
import { appDelivery, forgetMintedTokens, githubToken } from "./oauth-github.js";
import { readConnection, writeConnection } from "./oauth.js";
import type { GitHubApp } from "./oauth.js";

const TENANT = "acme";
const CODE = "setup-code-for-tests";
const PUBLIC = "http://127.0.0.1:8080";
const APP_ID = "4242";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const servers: Server[] = [];
beforeEach(() => {
  forgetMintedTokens();
  forgetVerified();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

interface StandIn {
  webUrl: string;
  /** The installations the installer's own token lists, by id and account. */
  installations: { id: number; account: { login: string } }[];
  /** Every installation token asked for: the installation, the permissions asked, and whether the JWT held. */
  mints: { installation: string; permissions: unknown; jwtHeld: boolean }[];
  /** What GitHub answers the app for its installation now: the account, and whether it is suspended; null once uninstalled. */
  now: { login: string; suspended: boolean } | null;
  /** What the installation allows, as GitHub reports it to the app. */
  permissions: Record<string, string>;
  /** How many times the app asked GitHub for its installation. */
  looked: number;
  /** How the access_tokens endpoint answers; by default a fresh token for an hour. */
  mint: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

function jwtHolds(header: string | undefined): boolean {
  const jwt = (header ?? "").replace(/^Bearer /, "");
  const [head, payload, signature] = jwt.split(".");
  if (!head || !payload || !signature) return false;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string; exp?: number; iat?: number };
  const now = Math.floor(Date.now() / 1000);
  const signed = createVerify("RSA-SHA256").update(`${head}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"));
  return signed && claims.iss === APP_ID && claims.exp! > now && claims.exp! - claims.iat! <= 600;
}

let minted = 0;

/** GitHub's sign-in, the installer's installations and installation tokens, on this machine. Nothing here reaches a real forge. */
async function standInGitHub(): Promise<StandIn> {
  const stand: StandIn = {
    webUrl: "",
    installations: [{ id: 77, account: { login: "acme-org" } }],
    mints: [],
    now: { login: "acme-org", suspended: false },
    permissions: { contents: "write", pull_requests: "write", statuses: "write", checks: "read", metadata: "read", repository_hooks: "write", issues: "read", administration: "write" },
    looked: 0,
    mint: () => {
      minted += 1;
      return { status: 201, body: { token: `ghs_stand_in_${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() } };
    },
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const path = (req.url ?? "").split("?")[0]!;
      const answer = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && path === "/login/oauth/access_token") {
        const form = Object.fromEntries(new URLSearchParams(raw));
        return form.code === "good-code" ? answer(200, { access_token: "ghu_installer_token", token_type: "bearer" }) : answer(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
      }
      if (req.method === "GET" && path === "/api/user/installations") {
        return req.headers.authorization === "Bearer ghu_installer_token" ? answer(200, { total_count: stand.installations.length, installations: stand.installations }) : answer(401, { message: "Bad credentials" });
      }
      if (req.method === "GET" && /^\/api\/app\/installations\/[0-9]+$/.test(path) && jwtHolds(req.headers.authorization)) {
        stand.looked += 1;
        return stand.now ? answer(200, { id: 77, account: { login: stand.now.login }, suspended_at: stand.now.suspended ? "2026-11-02T12:00:00Z" : null, permissions: stand.permissions }) : answer(404, { message: "Not Found" });
      }
      const mint = /^\/api\/app\/installations\/([0-9]+)\/access_tokens$/.exec(path);
      if (req.method === "POST" && mint) {
        stand.mints.push({ installation: mint[1]!, permissions: raw ? (JSON.parse(raw) as { permissions?: unknown }).permissions : undefined, jwtHeld: jwtHolds(req.headers.authorization) });
        if (!jwtHolds(req.headers.authorization)) return answer(401, { message: "A JSON web token could not be decoded" });
        const minted = await stand.mint();
        return answer(minted.status, minted.body);
      }
      answer(404, { message: "Not Found" });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stand.webUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stand;
}

function githubApp(webUrl: string): GitHubApp {
  return { kind: "github", webUrl, apiUrl: `${webUrl}/api`, appId: APP_ID, slug: "teamhandbook-orchestrator", clientId: "Iv1.stand-in", clientSecret: "stand-in-client-secret", privateKey };
}

async function organization(webUrl: string) {
  const store = openSqliteStore(":memory:");
  const ctx: OrchestratorContext = { store, dataDir: join(mkdtempSync(join(tmpdir(), "forge-github-")), "data"), tenant: TENANT, allowedHosts: null, publicUrl: PUBLIC, vault: createVault(randomBytes(32)), addedRepos: new Map(), forgeApps: { github: githubApp(webUrl) } };
  const owner = await principalOf(store, await setupFirstOwner(store, TENANT, CODE, { code: CODE, email: "ada@example.invalid", password: "correct horse battery" }));
  const s = await startSession(store, TENANT, owner.id);
  const headers = { cookie: `${sessionCookie(TENANT)}=${s.token}`, [CSRF_HEADER]: s.csrf, "content-type": "application/json" };
  return { ctx, owner, headers, app: createApp(ctx) };
}

async function install(app: ReturnType<typeof createApp>, headers: Record<string, string>, query: (state: string) => string) {
  const res = await app.request("/api/forge/github/connect", { method: "POST", headers });
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const url = new URL(authorizeUrl);
  const browser = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const back = await app.request(`/integrations/forge/callback?${query(url.searchParams.get("state")!)}`, { headers: { cookie: browser } });
  return { url, location: decodeURIComponent(back.headers.get("location") ?? "") };
}

describe("connecting GitHub through the app", () => {
  it("given an owner, when they install the app and GitHub returns with the installation, then the org is connected to that account and no token is sealed", async () => {
    const github = await standInGitHub();
    const { ctx, app, headers } = await organization(github.webUrl);

    const done = await install(app, headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);
    expect(done.url.pathname).toBe("/apps/teamhandbook-orchestrator/installations/new");
    expect(done.location).toBe(`/${TENANT}/integrations?forge_connected=github`);
    expect(await readConnection(ctx, "github")).toMatchObject({ via: "app", account: "acme-org", installationId: 77, problem: null });
    expect(await ctx.store.getSecret(TENANT, "forge.connection.github")).toBeNull();
  });

  it("given an installation id the installer cannot reach, when GitHub's return names it, then the org is not connected", async () => {
    const github = await standInGitHub();
    const { ctx, app, headers } = await organization(github.webUrl);

    const done = await install(app, headers, (state) => `code=good-code&installation_id=99&setup_action=install&state=${state}`);
    expect(done.location).toContain("does not list that installation");
    expect(await readConnection(ctx, "github")).toBeNull();
  });

  it("given an installation sent to an account owner for approval, when GitHub returns, then nothing is connected", async () => {
    const github = await standInGitHub();
    const { ctx, app, headers } = await organization(github.webUrl);

    const done = await install(app, headers, (state) => `code=good-code&setup_action=request&state=${state}`);
    expect(done.location).toContain("to approve");
    expect(await readConnection(ctx, "github")).toBeNull();
  });

  it("given a code GitHub does not accept, when it returns, then the person reads GitHub's reason", async () => {
    const github = await standInGitHub();
    const { ctx, app, headers } = await organization(github.webUrl);

    const done = await install(app, headers, (state) => `code=stale&installation_id=77&setup_action=install&state=${state}`);
    expect(done.location).toContain("incorrect or expired");
    expect(await readConnection(ctx, "github")).toBeNull();
  });

  it("given a connection, when it is disconnected, then the orchestrator forgets it and says the app stays installed on GitHub", async () => {
    const github = await standInGitHub();
    const { ctx, app, headers } = await organization(github.webUrl);
    await install(app, headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);

    const res = await app.request("/api/forge/github/connection", { method: "DELETE", headers });
    expect(((await res.json()) as { note: string }).note).toContain("stays installed on acme-org");
    expect(await readConnection(ctx, "github")).toBeNull();
  });
});

describe("installation tokens", () => {
  async function connected() {
    const github = await standInGitHub();
    const org = await organization(github.webUrl);
    await install(org.app, org.headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);
    return { github, ...org };
  }

  it("given a connection, when tokens are asked for twice, then one is minted with a JWT the app's key signed, and kept for the second", async () => {
    const { github, ctx } = await connected();
    const [a, b] = await Promise.all([githubToken(ctx), githubToken(ctx)]);
    expect(a).toBe(b);
    expect(await githubToken(ctx)).toBe(a);
    expect(github.mints).toEqual([{ installation: "77", permissions: undefined, jwtHeld: true }]);
  });

  it("given GitHub refusing a minted token, when a token is asked for next, then a fresh one is minted and the connection stays", async () => {
    const { github, ctx } = await connected();
    const first = await githubToken(ctx);

    await forgetRefusedToken(ctx, "github", first);

    expect(await githubToken(ctx)).not.toBe(first);
    expect(github.mints).toHaveLength(2);
    expect((await readConnection(ctx, "github"))!.problem).toBeNull();
  });

  it("given a token about to lapse, when one is asked for, then a new one is minted", async () => {
    const { github, ctx } = await connected();
    github.mint = () => ({ status: 201, body: { token: "ghs_short", expires_at: new Date(Date.now() + 60_000).toISOString() } });
    expect(await githubToken(ctx)).toBe("ghs_short");
    github.mint = () => ({ status: 201, body: { token: "ghs_next", expires_at: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(await githubToken(ctx)).toBe("ghs_next");
  });

  it("given the app was uninstalled on GitHub, when a token is asked for, then the connection is marked to be made again", async () => {
    const { github, ctx } = await connected();
    github.mint = () => ({ status: 404, body: { message: "Not Found" } });
    await expect(githubToken(ctx)).rejects.toThrow(/no longer installed/);
    expect((await readConnection(ctx, "github"))!.problem).toContain("no longer installed");
  });

  it("given an installation connected again while a mint was refused, when the refusal lands, then the new connection is not marked", async () => {
    const { github, ctx } = await connected();
    github.mint = async () => {
      const record = (await readConnection(ctx, "github"))!;
      await writeConnection(ctx, "github", { ...record, at: "2099-01-01T00:00:00.000Z" });
      return { status: 404, body: { message: "Not Found" } };
    };
    await expect(githubToken(ctx)).rejects.toThrow(/no longer installed/);
    expect((await readConnection(ctx, "github"))!.problem).toBeNull();
  });

  it("given a board reading issues, when it asks for access, then its token is narrowed to issues and metadata, apart from the full one", async () => {
    const { github, ctx } = await connected();
    const access = await forgeIssueAccess(ctx, "github");
    expect(access!.baseUrl).toBe(`${github.webUrl}/api`);
    expect(github.mints.at(-1)!.permissions).toEqual({ issues: "read", metadata: "read" });
    expect(await githubToken(ctx)).not.toBe(access!.headers.authorization!.replace("Bearer ", ""));
  });

  it("given no GitHub connection, when a board asks for access, then there is none", async () => {
    const github = await standInGitHub();
    const { ctx } = await organization(github.webUrl);
    expect(await forgeIssueAccess(ctx, "github")).toBeNull();
  });
});

describe("checking the account a GitHub connection reaches", () => {
  async function connected() {
    const github = await standInGitHub();
    const org = await organization(github.webUrl);
    await install(org.app, org.headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);
    return { github, ...org };
  }

  it("given the installation still on the account it was made for, when tokens are asked for twice, then GitHub is asked about it once in ten minutes", async () => {
    const { github, ctx } = await connected();
    await connectionToken(ctx, "github");
    await connectionToken(ctx, "github");
    expect(github.looked).toBe(1);
  });

  it("given the installation now on another account, when a token is asked for, then none is given and the connection is to be made again", async () => {
    const { github, ctx } = await connected();
    github.now = { login: "someone-else", suspended: false };
    await expect(connectionToken(ctx, "github")).rejects.toThrow(/now reaches someone-else, not acme-org/);
    expect((await readConnection(ctx, "github"))!.problem).toContain("someone-else");
  });

  it("given the installation suspended or removed on GitHub, when a board asks for access, then it is refused and the card says why", async () => {
    const { github, ctx } = await connected();
    github.now = { login: "acme-org", suspended: true };
    await expect(forgeIssueAccess(ctx, "github")).rejects.toThrow(/suspended/);

    const other = await connected();
    other.github.now = null;
    await expect(connectionToken(other.ctx, "github")).rejects.toThrow(/no longer installed/);
  });
});

describe("the app's own deliveries", () => {
  const SECRET = "stand-in-app-webhook-secret";
  const signed = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  async function connectedWithHook() {
    const github = await standInGitHub();
    const org = await organization(github.webUrl);
    org.ctx.forgeApps = { github: { ...org.ctx.forgeApps!.github!, webhookSecret: SECRET } };
    await install(org.app, org.headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);
    return org;
  }

  it("given the app removed from the account on GitHub, when GitHub says so, then the org's connection is marked at once", async () => {
    const { ctx } = await connectedWithHook();
    const body = JSON.stringify({ action: "deleted", installation: { id: 77, account: { login: "acme-org" } } });

    expect(await appDelivery([ctx], signed(body), "installation", body)).toBe(1);
    expect((await readConnection(ctx, "github"))!.problem).toContain("removed from acme-org");
  });

  it("given an installation suspended and then let back, when GitHub says each, then the mark comes and goes", async () => {
    const { ctx } = await connectedWithHook();
    const suspend = JSON.stringify({ action: "suspend", installation: { id: 77 } });
    const back = JSON.stringify({ action: "unsuspend", installation: { id: 77 } });

    await appDelivery([ctx], signed(suspend), "installation", suspend);
    expect((await readConnection(ctx, "github"))!.problem).toContain("suspended");
    await appDelivery([ctx], signed(back), "installation", back);
    expect((await readConnection(ctx, "github"))!.problem).toBeNull();
  });

  it("given a delivery signed with another secret, or another installation's, when it arrives, then nothing changes", async () => {
    const { ctx } = await connectedWithHook();
    const body = JSON.stringify({ action: "deleted", installation: { id: 77 } });
    const other = JSON.stringify({ action: "deleted", installation: { id: 78 } });

    expect(await appDelivery([ctx], signed(body, "not-the-secret-at-all"), "installation", body)).toBeNull();
    expect(await appDelivery([ctx], signed(other), "installation", other)).toBe(0);
    expect((await readConnection(ctx, "github"))!.problem).toBeNull();
  });
});

describe("checking the GitHub connection from the card", () => {
  it("given the installation's permissions, when an owner checks the connection, then it lists them and names any the orchestrator needs and lacks", async () => {
    const github = await standInGitHub();
    const { app, headers } = await organization(github.webUrl);
    await install(app, headers, (state) => `code=good-code&installation_id=77&setup_action=install&state=${state}`);

    const full = (await (await app.request("/api/forge/github/connection/check", { headers })).json()) as { check: { ok: boolean; account: string; missing: string[] } };
    expect(full.check).toMatchObject({ ok: true, account: "acme-org", missing: [] });

    github.permissions = { contents: "read", metadata: "read", pull_requests: "write" };
    const short = (await (await app.request("/api/forge/github/connection/check", { headers })).json()) as { check: { ok: boolean; missing: string[] } };
    expect(short.check.ok).toBe(false);
    expect(short.check.missing).toEqual(["contents: write", "statuses: write", "checks: read", "repository_hooks: write", "issues: read"]);
  });
});
