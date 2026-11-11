import { createHash, randomBytes } from "node:crypto";
import { normalizeEmail } from "./accounts.js";
import type { OidcLogin } from "./accounts.js";
import { createOidcClient } from "./oidc.js";
import { readSecretEnv } from "./secret-env.js";

/**
 * Signing in to a cloud orchestrator with Google, Microsoft or GitHub. Each provider answers with
 * an account the orchestrator takes only with an address the provider says it verified, by the rule
 * that provider's own claims make trustworthy:
 *
 * - Google: `email_verified` is true. Its `hd` names the Workspace domain that holds the account.
 * - Microsoft: `xms_edov` is true. A directory's admin sets any `email` they like on an account
 *   of theirs, and without that claim Microsoft does not vouch for it. A personal account (the
 *   consumer directory) is refused. `tid` names the directory that holds the account.
 * - GitHub: the account's primary address is verified, read from `/user/emails`. GitHub holds
 *   no domain, so its sign-in never joins anyone to an organization by their address alone.
 *
 * The account is keyed by the provider's own stable id, never by the address.
 */
export type SocialProvider = "google" | "github" | "microsoft";
export const SOCIAL_PROVIDERS: SocialProvider[] = ["google", "github", "microsoft"];

export interface ProviderAccount {
  provider: SocialProvider;
  subject: string;
  email: string;
  name: string;
  /** Google's Workspace domain, Microsoft's directory id; null when the provider names none. */
  domain: string | null;
}

export interface SocialClient {
  provider: SocialProvider;
  start(): Promise<{ url: string; login: Omit<OidcLogin, "tenant"> }>;
  finish(code: string, login: Pick<OidcLogin, "nonce" | "verifier">): Promise<ProviderAccount>;
}

/** Microsoft's directory for personal accounts. */
export const MICROSOFT_CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad";

const LOGIN_MINUTES = 10;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULTS = {
  google: "https://accounts.google.com",
  microsoft: "https://login.microsoftonline.com/common/v2.0",
  github: "https://github.com",
  githubApi: "https://api.github.com",
};

/** Why a provider's answer was not taken, as the signup page names it; the page has its own sentence for each. */
export type ProviderProblem = "unverified-email" | "personal-microsoft" | "unvouched-microsoft" | "provider-error";

// An Error of its own rather than an AccountError: this module is loaded inside the cycle that
// defines AccountError, and a class extending it here would find it not defined yet.
export class ProviderRefused extends Error {
  readonly status = 403;
  constructor(provider: SocialProvider, why: string, readonly problem: ProviderProblem) {
    super(`${PROVIDER_LABEL[provider]} sign-in did not go through: ${why}`);
  }
}

const refused = (provider: SocialProvider, why: string, problem: ProviderProblem = "provider-error") => new ProviderRefused(provider, why, problem);

export const PROVIDER_LABEL: Record<SocialProvider, string> = { google: "Google", github: "GitHub", microsoft: "Microsoft" };

/** A provider's address as the operator gave it: https, or plain http to this machine, which the lab's stand-ins use. */
function providerAddress(value: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error(`${name} has to be https (plain http only on this machine)`);
  return value.replace(/\/+$/, "");
}

const b64url = (buffer: Buffer) => buffer.toString("base64url");

function freshLogin(): Omit<OidcLogin, "tenant"> {
  return { state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)), expiresAt: new Date(Date.now() + LOGIN_MINUTES * 60_000).toISOString() };
}

async function getJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the provider answered ${res.status} at ${new URL(url).pathname}`);
  return res.json();
}

function oidcProvider(provider: "google" | "microsoft", issuer: string, clientId: string, clientSecret: string, redirectUrl: string, fetchImpl: typeof fetch): SocialClient {
  const client = createOidcClient({ issuer, clientId, clientSecret, redirectUrl, groupsClaim: "groups", tenantIssuer: provider === "microsoft" }, fetchImpl);
  return {
    provider,
    start: () => client.start(),
    async finish(code, login) {
      const checked = await client.finish(code, login).catch((err: Error) => {
        throw refused(provider, err.message);
      });
      const claims = checked.claims ?? {};
      const email = typeof claims.email === "string" ? claims.email : "";
      const name = typeof claims.name === "string" && claims.name ? claims.name : email;
      if (provider === "google") {
        if (!email || claims.email_verified !== true) throw refused(provider, "Google has not verified this account's address", "unverified-email");
        return { provider, subject: checked.subject, email: normalizeEmail(email), name, domain: typeof claims.hd === "string" && claims.hd ? claims.hd.toLowerCase() : null };
      }
      if (claims.tid === MICROSOFT_CONSUMERS) throw refused(provider, "this orchestrator takes work and school Microsoft accounts, not personal ones", "personal-microsoft");
      // Only the directory's admin makes Microsoft vouch for an address, by verifying its domain; the person cannot.
      if (!email || claims.xms_edov !== true) throw refused(provider, "Microsoft does not vouch for this account's address", "unvouched-microsoft");
      if (typeof claims.oid !== "string" || !claims.oid) throw refused(provider, "the token names no account");
      return { provider, subject: `${String(claims.tid)}:${claims.oid}`, email: normalizeEmail(email), name, domain: String(claims.tid) };
    },
  };
}

function githubProvider(web: string, api: string, clientId: string, clientSecret: string, redirectUrl: string, fetchImpl: typeof fetch): SocialClient {
  return {
    provider: "github",
    async start() {
      const login = freshLogin();
      const url = new URL(`${web}/login/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUrl,
        scope: "read:user user:email",
        state: login.state,
        code_challenge: b64url(createHash("sha256").update(login.verifier).digest()),
        code_challenge_method: "S256",
      }).toString();
      return { url: url.toString(), login };
    },
    async finish(code, login) {
      try {
        // GitHub answers form-encoded unless asked for JSON, and a bad code with 200 and an error field.
        const tokens = (await getJson(fetchImpl, `${web}/login/oauth/access_token`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUrl, code_verifier: login.verifier }).toString(),
        })) as { access_token?: unknown; error?: unknown };
        if (tokens.error !== undefined || typeof tokens.access_token !== "string") throw new Error("GitHub turned the code down");
        const headers = { authorization: `Bearer ${tokens.access_token}`, accept: "application/vnd.github+json", "user-agent": "TeamHandbook-Orchestrator" };
        const user = (await getJson(fetchImpl, `${api}/user`, { headers })) as { id?: unknown; login?: unknown; name?: unknown };
        const emails = (await getJson(fetchImpl, `${api}/user/emails`, { headers })) as { email?: unknown; primary?: unknown; verified?: unknown }[];
        if (typeof user.id !== "number" || !Number.isInteger(user.id)) throw new Error("GitHub named no account");
        const primary = Array.isArray(emails) ? emails.find((e) => e.primary === true) : undefined;
        if (!primary || primary.verified !== true || typeof primary.email !== "string") throw refused("github", "GitHub has no verified primary address for this account", "unverified-email");
        const name = typeof user.name === "string" && user.name ? user.name : typeof user.login === "string" ? user.login : primary.email;
        return { provider: "github", subject: String(user.id), email: normalizeEmail(primary.email), name, domain: null };
      } catch (err) {
        if (err instanceof ProviderRefused) throw err;
        throw refused("github", (err as Error).message);
      }
    },
  };
}

/**
 * The providers the operator set up, each from its own ORCHESTRATOR_SIGN_IN_<PROVIDER>_CLIENT_ID and
 * _CLIENT_SECRET (or _CLIENT_SECRET_FILE); one left out shows no button. An id without its
 * secret stops the orchestrator rather than offering a button that fails.
 */
export function socialClientsFromEnv(env: NodeJS.ProcessEnv, publicUrl: string | undefined, fetchImpl: typeof fetch = fetch): Map<SocialProvider, SocialClient> {
  const clients = new Map<SocialProvider, SocialClient>();
  for (const provider of SOCIAL_PROVIDERS) {
    const prefix = `ORCHESTRATOR_SIGN_IN_${provider.toUpperCase()}`;
    const clientId = env[`${prefix}_CLIENT_ID`];
    if (!clientId) continue;
    const clientSecret = readSecretEnv(env, `${prefix}_CLIENT_SECRET`);
    if (!clientSecret) throw new Error(`${prefix}_CLIENT_ID needs ${prefix}_CLIENT_SECRET (or ${prefix}_CLIENT_SECRET_FILE)`);
    if (!publicUrl) throw new Error(`${prefix}_CLIENT_ID needs ORCHESTRATOR_PUBLIC_URL, the address the provider sends people back to`);
    const redirectUrl = `${publicUrl.replace(/\/+$/, "")}/api/auth/${provider}/callback`;
    if (provider === "github") {
      clients.set(provider, githubProvider(providerAddress(env[`${prefix}_URL`] || DEFAULTS.github, `${prefix}_URL`), providerAddress(env[`${prefix}_API_URL`] || DEFAULTS.githubApi, `${prefix}_API_URL`), clientId, clientSecret, redirectUrl, fetchImpl));
    } else {
      clients.set(provider, oidcProvider(provider, providerAddress(env[`${prefix}_ISSUER`] || DEFAULTS[provider], `${prefix}_ISSUER`), clientId, clientSecret, redirectUrl, fetchImpl));
    }
  }
  return clients;
}
