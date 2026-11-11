import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import type { OidcLogin } from "./accounts.js";
import { groupsFrom } from "./directory.js";
import { readSecretEnv } from "./secret-env.js";

/**
 * Single sign-on through any OpenID Connect provider: the authorization code flow with
 * PKCE, a state and a nonce, and an ID token whose signature, issuer, audience, expiry and
 * nonce are all checked here before anyone is signed in. Nothing from the provider is
 * trusted because it arrived over TLS; a token that fails one check is refused whole.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  /** The ID token claim that lists a person's groups, for directory sync. */
  groupsClaim: string;
  /** What the orchestrator asks for; left out, `openid email profile`. */
  scope?: string;
  /**
   * For a provider that signs people of many directories in at one address (Microsoft's
   * `common`): its discovery names the issuer with `{tenantid}`, and each token's issuer has to
   * be that with the token's own directory id in it.
   */
  tenantIssuer?: boolean;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  /** The groups the token lists; left out when it lists none the orchestrator reads, which keeps the groups recorded before. */
  groups?: string[];
  /** Every claim of the checked token, for a caller with rules of its own about a provider's claims. */
  claims?: Record<string, unknown>;
}

export interface OidcClient {
  /** What the Security page shows: never the client secret. */
  issuer: string;
  groupsClaim: string;
  start(): Promise<{ url: string; login: Omit<OidcLogin, "tenant"> }>;
  finish(code: string, login: Pick<OidcLogin, "nonce" | "verifier">): Promise<OidcIdentity>;
}

interface Metadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const LOGIN_MINUTES = 10;
const CLOCK_SKEW_S = 60;
const ALGORITHMS = new Set(["RS256", "ES256"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv, publicUrl: string | undefined): OidcConfig | null {
  const issuer = env.ORCHESTRATOR_OIDC_ISSUER;
  if (!issuer) return null;
  const clientId = env.ORCHESTRATOR_OIDC_CLIENT_ID;
  const clientSecret = readSecretEnv(env, "ORCHESTRATOR_OIDC_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("ORCHESTRATOR_OIDC_ISSUER needs ORCHESTRATOR_OIDC_CLIENT_ID and ORCHESTRATOR_OIDC_CLIENT_SECRET (or ORCHESTRATOR_OIDC_CLIENT_SECRET_FILE)");
  if (!publicUrl) throw new Error("ORCHESTRATOR_OIDC_ISSUER needs ORCHESTRATOR_PUBLIC_URL, the address the provider sends people back to");
  // The discovery document and the signing keys come from the issuer; over plain http
  // anyone on the path hands the orchestrator keys of their own.
  const url = new URL(issuer);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Error("ORCHESTRATOR_OIDC_ISSUER has to be https (plain http only for an issuer on this machine)");
  }
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret,
    redirectUrl: `${publicUrl.replace(/\/+$/, "")}/api/auth/oidc/callback`,
    groupsClaim: env.ORCHESTRATOR_OIDC_GROUPS_CLAIM || "groups",
  };
}

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function decodePart(part: string | undefined): Record<string, unknown> {
  if (!part) throw new Error("the ID token is not a JWT");
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the ID token is not a JWT");
  return value as Record<string, unknown>;
}

async function getJson(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the identity provider answered ${res.status} at ${new URL(url).pathname}`);
  return (await res.json()) as Record<string, unknown>;
}

/** The checks on an ID token's claims, apart from its signature. Exported so each one is tested on its own. */
export function checkClaims(claims: Record<string, unknown>, config: OidcConfig, nonce: string, now = Date.now(), issuer = config.issuer): OidcIdentity {
  if (claims.iss !== issuer) throw new Error("the ID token names another issuer");
  const aud = claims.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(config.clientId)) throw new Error("the ID token was issued to another client");
  if (audiences.length > 1 && claims.azp !== config.clientId) throw new Error("the ID token was issued to another client");
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < now / 1000) throw new Error("the ID token has expired");
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now / 1000) throw new Error("the ID token is dated in the future");
  if (claims.nonce !== nonce) throw new Error("the ID token answers another sign-in");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("the ID token names no subject");
  return {
    issuer,
    subject: claims.sub,
    // An address the provider does not say it verified is not evidence of who signed in; a
    // missing claim counts as unverified.
    ...(typeof claims.email === "string" && claims.email_verified === true ? { email: claims.email } : {}),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    ...(groupsFrom(claims[config.groupsClaim]) ? { groups: groupsFrom(claims[config.groupsClaim])! } : {}),
    claims,
  };
}

const DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The issuer a token from a many-directory provider has to name: the discovery's `{tenantid}` filled with the token's own `tid`. */
export function tenantIssuer(template: string, claims: Record<string, unknown>): string {
  if (typeof claims.tid !== "string" || !DIRECTORY_ID.test(claims.tid)) throw new Error("the ID token names no directory");
  return template.replace("{tenantid}", claims.tid);
}

export function createOidcClient(config: OidcConfig, fetchImpl: typeof fetch = fetch): OidcClient {
  let metadata: Promise<Metadata> | null = null;
  let keys: JsonWebKey[] = [];

  const discover = () => {
    metadata ??= getJson(fetchImpl, `${config.issuer}/.well-known/openid-configuration`).then((m) => {
      const expected = config.tenantIssuer ? config.issuer.replace(/\/common\//, "/{tenantid}/") : config.issuer;
      if (m.issuer !== expected) throw new Error("the provider's discovery document names another issuer");
      for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
        if (typeof m[key] !== "string") throw new Error(`the provider's discovery document has no ${key}`);
      }
      return m as unknown as Metadata;
    });
    return metadata.catch((err) => {
      metadata = null;
      throw err;
    });
  };

  const keyFor = async (kid: unknown, alg: string): Promise<JsonWebKey> => {
    const match = () => keys.find((k) => (kid === undefined || k.kid === kid) && (k.alg === undefined || k.alg === alg) && k.use !== "enc");
    if (!match()) {
      // A key the orchestrator has not seen means the provider rotated: fetch the set once more.
      const set = await getJson(fetchImpl, (await discover()).jwks_uri);
      keys = Array.isArray(set.keys) ? (set.keys as JsonWebKey[]) : [];
    }
    const key = match();
    if (!key) throw new Error("the ID token is signed with a key the provider does not publish");
    return key;
  };

  return {
    issuer: config.issuer,
    groupsClaim: config.groupsClaim,
    async start() {
      const m = await discover();
      const state = b64url(randomBytes(24));
      const nonce = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(32));
      const url = new URL(m.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: config.redirectUrl,
        scope: config.scope ?? "openid email profile",
        state,
        nonce,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      }).toString();
      return { url: url.toString(), login: { state, nonce, verifier, expiresAt: new Date(Date.now() + LOGIN_MINUTES * 60_000).toISOString() } };
    },

    async finish(code, login) {
      const m = await discover();
      const tokens = await getJson(fetchImpl, m.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUrl, code_verifier: login.verifier }).toString(),
      });
      const idToken = tokens.id_token;
      if (typeof idToken !== "string") throw new Error("the provider returned no ID token");
      const [headerPart, payloadPart, signaturePart] = idToken.split(".");
      const header = decodePart(headerPart);
      const alg = String(header.alg);
      if (!ALGORITHMS.has(alg)) throw new Error(`the ID token is signed with ${alg}, which this orchestrator does not accept`);
      const jwk = await keyFor(header.kid, alg);
      const signed = Buffer.from(`${headerPart}.${payloadPart}`);
      const signature = Buffer.from(signaturePart ?? "", "base64url");
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      const valid =
        alg === "ES256"
          ? verify("sha256", signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)
          : verify("sha256", signed, publicKey, signature);
      if (!valid) throw new Error("the ID token's signature does not check out");
      const claims = decodePart(payloadPart);
      return checkClaims(claims, config, login.nonce, Date.now(), config.tenantIssuer ? tenantIssuer(m.issuer, claims) : config.issuer);
    },
  };
}
