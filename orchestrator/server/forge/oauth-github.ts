import { createHash, createHmac, createSign, timingSafeEqual } from "node:crypto";
import type { OrchestratorContext } from "../app.js";
import { maskSecrets } from "../vault.js";
import { apiGet, ConnectionUnusable, ForgeSignInFailed, markBroken, readConnection, writeConnection } from "./oauth.js";
import type { ConnectionRecord, GitHubApp } from "./oauth.js";

/**
 * A GitHub App acts on the repositories an account installed it on, with tokens that last an
 * hour and are minted from the app's private key when needed. Nothing of the installation is
 * sealed: the app's key is the operator's, and the org keeps only which installation is its own.
 */

/** The page that installs the app, or changes which repositories it reaches; GitHub returns to the app's callback with `state`. */
export function githubInstallUrl(app: GitHubApp, state: string): string {
  const url = new URL(`${app.webUrl}/apps/${encodeURIComponent(app.slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Where the account the app is on changes which repositories it reaches: a person's settings, or the organization's. */
export function installationSettingsUrl(app: Pick<GitHubApp, "webUrl">, record: Pick<ConnectionRecord, "account" | "organization" | "installationId">): string {
  const id = encodeURIComponent(String(record.installationId ?? ""));
  return record.organization ? `${app.webUrl}/organizations/${encodeURIComponent(record.account)}/settings/installations/${id}` : `${app.webUrl}/settings/installations/${id}`;
}

/** The app's own credential: a JWT signed with its private key, good for ten minutes at most, so nine. */
export function appJwt(app: Pick<GitHubApp, "appId" | "privateKey">, now = Date.now()): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const seconds = Math.floor(now / 1000);
  // Issued a minute in the past, as GitHub advises, so a clock a little ahead of GitHub's is not refused.
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: app.appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(app.privateKey).toString("base64url")}`;
}

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

/** Trades the code GitHub returned with the installation for the installer's own token, used once and kept nowhere. */
export async function githubUserToken(app: GitHubApp, code: string, redirectUri: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${app.webUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ForgeSignInFailed("GitHub is unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== "string" || !body.access_token) {
    const said = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : `answered ${res.status}`;
    throw new ForgeSignInFailed(maskSecrets(`GitHub refused the sign-in: ${said}`, [app.clientSecret, code]).replace(/\p{C}+/gu, " ").slice(0, 200));
  }
  return body.access_token;
}

interface Installation {
  id: number;
  account?: { login?: unknown; type?: unknown };
}

/**
 * The account an installation is on, read with the installer's own token: GitHub lists only the
 * installations that person can reach. The id comes back on the address, which anyone can write,
 * so an installation this person cannot reach is not taken as the org's.
 */
export async function githubInstallationAccount(app: GitHubApp, userToken: string, installationId: number): Promise<{ login: string; organization: boolean }> {
  const listed = await apiGet<{ installations?: Installation[] }>(`${app.apiUrl}/user/installations?per_page=100`, { ...GITHUB_HEADERS, authorization: `Bearer ${userToken}` }, [userToken]);
  const found = (listed.installations ?? []).find((i) => i.id === installationId);
  if (!found) throw new ForgeSignInFailed("GitHub does not list that installation among yours; install the app from this orchestrator again");
  const login = found.account?.login;
  if (typeof login !== "string" || !login) throw new ForgeSignInFailed("GitHub named no account for the installation");
  return { login: login.slice(0, 100), organization: found.account?.type === "Organization" };
}

/**
 * The account an installation is on now and whether GitHub holds it suspended, read with the
 * app's own credential: what the org connected to is checked again without anyone's sign-in.
 */
export async function installationNow(app: GitHubApp, installationId: number): Promise<{ login: string; suspended: boolean; permissions: Record<string, string> } | null> {
  const jwt = appJwt(app);
  let res: Response;
  try {
    res = await fetch(`${app.apiUrl}/app/installations/${installationId}`, { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${jwt}` }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ConnectionUnusable("GitHub is unreachable, so the connection's installation was not checked; try again in a minute");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ConnectionUnusable(`GitHub answered ${res.status} when the connection's installation was checked`);
  const body = (await res.json().catch(() => ({}))) as { account?: { login?: unknown }; suspended_at?: unknown; permissions?: unknown };
  const permissions = Object.fromEntries(Object.entries(body.permissions && typeof body.permissions === "object" ? (body.permissions as Record<string, unknown>) : {}).filter((e): e is [string, string] => typeof e[1] === "string"));
  return { login: typeof body.account?.login === "string" ? body.account.login : "", suspended: typeof body.suspended_at === "string" && body.suspended_at !== "", permissions };
}

/** An installation token is minted again this long before it lapses. */
const MINT_AHEAD_MS = 5 * 60_000;

interface Minted {
  token: string;
  expiresAt: number;
}

const minted = new Map<string, Minted>();
const minting = new Map<string, Promise<string>>();

/** Forgets every minted token: for a test that starts its forge again. */
export function forgetMintedTokens(): void {
  minted.clear();
}

/** Forgets the tokens minted for an org's installation, so the next call mints a fresh one: after GitHub refused one. */
export function forgetMintedFor(tenant: string): void {
  for (const key of minted.keys()) if (key.startsWith(`${tenant}:`)) minted.delete(key);
}

/**
 * A token for the org's GitHub installation, minted when the last one is about to lapse. With
 * `permissions`, a token narrowed to them, kept apart from the full one: what reads a board's
 * issues gets a token that can do nothing else.
 */
export async function githubToken(ctx: Pick<OrchestratorContext, "store" | "tenant" | "forgeApps">, permissions?: Record<string, "read" | "write">, now = Date.now()): Promise<string> {
  const app = ctx.forgeApps?.github ?? null;
  const record = await readConnection(ctx, "github");
  if (!app || !record?.installationId) throw new ConnectionUnusable("GitHub is not connected for this organization; an owner or an admin connects it under Integrations");
  if (new URL(record.apiUrl).origin !== new URL(app.apiUrl).origin) throw new ConnectionUnusable("the GitHub connection was made for another GitHub address; connect it again");
  if (record.problem?.startsWith(SUSPENDED)) throw new ConnectionUnusable(`${record.problem}; ${liftSuspension(record.account)}`);
  if (record.problem) throw new ConnectionUnusable(`the GitHub connection needs to be made again: ${record.problem}; an owner or an admin connects GitHub again under Integrations`);
  const key = `${ctx.tenant}:${record.installationId}:${permissions ? JSON.stringify(Object.entries(permissions).sort()) : "all"}`;
  const kept = minted.get(key);
  if (kept && kept.expiresAt - now > MINT_AHEAD_MS) return kept.token;
  const running = minting.get(key);
  if (running) return running;
  const mint = (async () => {
    const jwt = appJwt(app, now);
    let res: Response;
    try {
      res = await fetch(`${app.apiUrl}/app/installations/${record.installationId}/access_tokens`, {
        method: "POST",
        headers: { ...GITHUB_HEADERS, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        body: JSON.stringify(permissions ? { permissions } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ConnectionUnusable("GitHub is unreachable, so no token for the installation was made");
    }
    const body = (await res.json().catch(() => ({}))) as { token?: unknown; expires_at?: unknown; message?: unknown };
    if (res.status === 404 || res.status === 403) {
      // The installation was removed or suspended on GitHub: nothing renews it until someone installs the app again.
      if (res.status === 404) return markBroken(ctx, "github", record, "the app is no longer installed on GitHub");
      return markBroken(ctx, "github", record, "GitHub suspended the app's installation or refused the permissions it asked for", `an owner of ${record.account} lifts the suspension or grants the app's permissions in its GitHub settings`);
    }
    if (!res.ok || typeof body.token !== "string" || !body.token) {
      throw new ConnectionUnusable(maskSecrets(`GitHub made no token for the installation (answered ${res.status}${typeof body.message === "string" ? `: ${body.message}` : ""})`, [jwt]).slice(0, 200));
    }
    const expiresAt = typeof body.expires_at === "string" && Number.isFinite(Date.parse(body.expires_at)) ? Date.parse(body.expires_at) : now + 3_600_000;
    minted.set(key, { token: body.token, expiresAt });
    return body.token;
  })().finally(() => minting.delete(key));
  minting.set(key, mint);
  return mint;
}

export const APP_HOOK = "/api/hooks/github-app";

export const SUSPENDED = "GitHub suspended the app's installation";

/** What fixes a suspended installation: only the GitHub account's owner lifts it, and the connection works again with no reconnecting. */
export const liftSuspension = (account: string) => `an owner of ${account} lifts the suspension in its GitHub settings, and the connection works again`;

/**
 * The app's own deliveries, which GitHub sends to one address for every installation: an
 * installation removed or suspended marks each org connected through it to be connected again at
 * once, rather than when its next token is minted; one that comes back from suspension clears
 * that mark. Answers how many orgs' connections it changed; null when the signature does not hold.
 */
export async function appDelivery(orgs: Pick<OrchestratorContext, "store" | "tenant" | "forgeApps">[], signature: string | undefined, event: string | undefined, body: string): Promise<number | null> {
  const secret = orgs[0]?.forgeApps?.github?.webhookSecret;
  if (!secret || !signature) return null;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const same = timingSafeEqual(createHash("sha256").update(signature).digest(), createHash("sha256").update(expected).digest());
  if (!same) return null;
  if (event !== "installation") return 0;
  let payload: { action?: unknown; installation?: { id?: unknown; account?: { login?: unknown } } };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return 0;
  }
  const id = payload.installation?.id;
  const action = payload.action;
  if (typeof id !== "number" || (action !== "deleted" && action !== "suspend" && action !== "unsuspend")) return 0;
  let changed = 0;
  for (const ctx of orgs) {
    const record = await readConnection(ctx, "github");
    if (!record || record.installationId !== id) continue;
    const problem = action === "deleted" ? `the app was removed from ${record.account} on GitHub` : action === "suspend" ? `${SUSPENDED} on ${record.account}` : record.problem?.startsWith(SUSPENDED) ? null : record.problem;
    if (problem === record.problem) continue;
    await writeConnection(ctx, "github", { ...record, problem });
    changed += 1;
  }
  return changed;
}
