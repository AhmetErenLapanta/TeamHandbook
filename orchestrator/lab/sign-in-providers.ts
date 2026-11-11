import { createHash, generateKeyPairSync, randomBytes, randomInt, sign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Stand-ins for the three providers a person signs up with, each under a path of its own on one
 * port and each in the shape the real one answers in:
 *
 * - Google (`/google`): OpenID Connect, RS256 ID tokens with `email_verified` and, for a Workspace
 *   account, `hd`; discovery, authorization, token, keys and userinfo.
 * - Microsoft (`/microsoft`): the identity platform's v2.0 OpenID Connect on the `common` tenant,
 *   whose discovery names its issuer with `{tenantid}` and whose ID token carries `tid`, `oid` and
 *   `preferred_username`, `email` only when the account has one, and `xms_edov` when Microsoft
 *   vouches for that address.
 * - GitHub (`/github`): OAuth, not OpenID Connect: an authorization page, an access-token endpoint
 *   that answers form-encoded unless asked for JSON, and the REST API's `/user` and `/user/emails`.
 *
 * Each checks its client, the exact redirect address registered for it, PKCE when the request
 * carries a challenge, and gives a code once. The consent page lists the lab's people of that
 * provider to pick from. Every token handed out is kept for a test at `/lab/logins`. Nothing here
 * talks to a real provider.
 */

export type ProviderName = "google" | "microsoft" | "github";

export interface ProviderPerson {
  /** Google's numeric subject, Microsoft's object id, GitHub's numeric user id. */
  id: string;
  name: string;
  email: string | null;
  /** Whether the provider says it verified the address. */
  verified: boolean;
  /** Google: the Workspace domain. Microsoft: the directory (tenant) id; a personal account's is Microsoft's consumer tenant. */
  domain?: string;
  /** GitHub's login. Microsoft's preferred_username. */
  login?: string;
}

export interface ProviderClient {
  id: string;
  secret: string;
  /** Registered redirect addresses, matched exactly. */
  redirects: string[];
}

export interface SignInProvidersConfig {
  port: number;
  people: Record<ProviderName, ProviderPerson[]>;
  clients: Record<ProviderName, ProviderClient[]>;
  log: string;
  /** The address it listens on; 127.0.0.1 unless it shares a container's network with the orchestrator and is published from there. */
  host?: string;
}

export interface ProviderLogin {
  at: string;
  provider: ProviderName;
  person: string;
  client: string;
}

/** Microsoft's own tenant for personal accounts. */
export const MICROSOFT_CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad";

interface Grant {
  provider: ProviderName;
  client: string;
  redirect: string;
  challenge: string | null;
  nonce: string;
  person: string;
  scope: string;
  expires: number;
}

/** The chooser's value for a Google person made up on the spot. */
const NEW_PERSON = "new";
const FIRST_NAMES = ["Lena", "Omar", "Priya", "Tomas", "Yuki", "Zara", "Felix", "Noor"];
const LAST_NAMES = ["Hale", "Moreau", "Sato", "Varga", "Quinn", "Lindqvist", "Okoro", "Brandt"];

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The providers as started: the address they answer at, and a way to stop them. */
export interface SignInProviders {
  base: string;
  close: () => Promise<void>;
}

/** Starts the providers; port 0 takes a free port, and the issuers are named from the one bound. */
export function startSignInProviders(config: SignInProvidersConfig): Promise<SignInProviders> {
  let base = `http://127.0.0.1:${config.port}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "RS256", use: "sig" };
  const grants = new Map<string, Grant>();
  const tokens = new Map<string, { provider: ProviderName; person: string; scope: string }>();
  const logins: ProviderLogin[] = [];

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const jwt = (claims: Record<string, unknown>) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signing = `${part({ alg: "RS256", typ: "JWT", kid })}.${part(claims)}`;
    return `${signing}.${sign("sha256", Buffer.from(signing), privateKey).toString("base64url")}`;
  };
  const personOf = (provider: ProviderName, id: string) => config.people[provider].find((p) => p.id === id);
  const issuerOf = (provider: ProviderName, person?: ProviderPerson) =>
    provider === "google" ? `${base}/google` : provider === "microsoft" ? `${base}/microsoft/${person?.domain ?? MICROSOFT_CONSUMERS}/v2.0` : `${base}/github`;

  const endpoints = {
    google: { authorize: "/google/o/oauth2/v2/auth", token: "/google/token", keys: "/google/oauth2/v3/certs", userinfo: "/google/v1/userinfo" },
    microsoft: { authorize: "/microsoft/common/oauth2/v2.0/authorize", token: "/microsoft/common/oauth2/v2.0/token", keys: "/microsoft/common/discovery/v2.0/keys", userinfo: "/microsoft/oidc/userinfo" },
    github: { authorize: "/github/login/oauth/authorize", token: "/github/login/oauth/access_token", keys: "", userinfo: "/github/api/user" },
  } as const;

  const discovery = (provider: "google" | "microsoft") => ({
    issuer: provider === "google" ? issuerOf("google") : `${base}/microsoft/{tenantid}/v2.0`,
    authorization_endpoint: `${base}${endpoints[provider].authorize}`,
    token_endpoint: `${base}${endpoints[provider].token}`,
    jwks_uri: `${base}${endpoints[provider].keys}`,
    userinfo_endpoint: `${base}${endpoints[provider].userinfo}`,
    response_types_supported: ["code"],
    subject_types_supported: provider === "google" ? ["public"] : ["pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: provider === "google" ? ["sub", "email", "email_verified", "name", "hd", "nonce"] : ["sub", "oid", "tid", "email", "name", "preferred_username", "xms_edov", "nonce"],
  });

  /**
   * A verified Google person made up on the spot, for a person trying the orchestrator by hand who
   * needs someone with no organization and no invitation each time. Kept until the stand-in stops.
   */
  let made = 0;
  const newPerson = (): ProviderPerson => {
    const first = FIRST_NAMES[made % FIRST_NAMES.length]!;
    const last = LAST_NAMES[Math.floor(made / FIRST_NAMES.length) % LAST_NAMES.length]!;
    made++;
    const person: ProviderPerson = { id: `1048576${randomInt(10 ** 13, 10 ** 14)}`, name: `${first} ${last}`, email: `${first}.${last}.${randomBytes(2).toString("hex")}@new-person.example.invalid`.toLowerCase(), verified: true };
    config.people.google.push(person);
    appendFileSync(config.log, `${new Date().toISOString()} google made ${person.id}\n`);
    return person;
  };

  const authorize = (provider: ProviderName, req: IncomingMessage, res: ServerResponse, params: URLSearchParams) => {
    const client = config.clients[provider].find((c) => c.id === params.get("client_id"));
    const redirect = params.get("redirect_uri") ?? "";
    // A provider shows its own error page for an unknown client or redirect, and never sends the browser back to it.
    if (!client || !client.redirects.includes(redirect)) return json(res, 400, { error: provider === "github" ? "redirect_uri_mismatch" : "invalid_client" });
    if (provider !== "github" && params.get("response_type") !== "code") return json(res, 400, { error: "unsupported_response_type" });
    const challenge = params.get("code_challenge");
    if (challenge && params.get("code_challenge_method") !== "S256") return json(res, 400, { error: "invalid_request" });
    const chosen = req.method === "POST" ? params.get("person") : null;
    const person = chosen === NEW_PERSON && provider === "google" ? newPerson() : chosen ? personOf(provider, chosen) : undefined;
    if (!person) {
      const hidden = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "prompt", "login_hint"]
        .map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name) ?? "")}">`)
        .join("");
      const choices = [
        ...config.people[provider].map((p) => `<button type="submit" name="person" value="${escape(p.id)}">Continue as ${escape(p.name)}${p.email ? ` (${escape(p.email)})` : ""}</button>`),
        ...(provider === "google" ? [`<button type="submit" name="person" value="${NEW_PERSON}">Continue as a new person</button>`] : []),
      ].join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Lab ${provider} sign-in</title><h1>Sign in with the lab's ${provider}</h1><form method="post" action="${endpoints[provider].authorize}">${hidden}${choices}</form>`);
      return;
    }
    const code = randomBytes(20).toString("hex");
    grants.set(code, { provider, client: client.id, redirect, challenge, nonce: params.get("nonce") ?? "", person: person.id, scope: params.get("scope") ?? "", expires: Date.now() + 60_000 });
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    if (params.get("state")) back.searchParams.set("state", params.get("state")!);
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  const token = (provider: ProviderName, req: IncomingMessage, res: ServerResponse, form: URLSearchParams) => {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const [basicId, basicSecret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent) : [];
    const id = basicId ?? form.get("client_id");
    const secret = basicSecret ?? form.get("client_secret");
    const client = config.clients[provider].find((c) => c.id === id && c.secret === secret);
    const answer = (status: number, body: Record<string, unknown>) => {
      // GitHub answers form-encoded unless the request accepts JSON, as its own endpoint does.
      if (provider === "github" && !(req.headers.accept ?? "").includes("application/json")) {
        res.writeHead(status, { "content-type": "application/x-www-form-urlencoded" });
        res.end(new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString());
        return;
      }
      json(res, status, body);
    };
    // GitHub answers a bad exchange with 200 and an error field.
    const refuse = (error: string, status: number) => answer(provider === "github" ? 200 : status, { error });
    if (!client) return refuse(provider === "github" ? "incorrect_client_credentials" : "invalid_client", 401);
    if (provider !== "github" && form.get("grant_type") !== "authorization_code") return refuse("unsupported_grant_type", 400);
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier");
    const verified = !grant?.challenge || (verifier !== null && createHash("sha256").update(verifier).digest("base64url") === grant.challenge);
    if (!grant || grant.provider !== provider || grant.client !== client.id || grant.expires < Date.now() || !verified || (form.get("redirect_uri") !== null && form.get("redirect_uri") !== grant.redirect)) {
      return refuse(provider === "github" ? "bad_verification_code" : "invalid_grant", 400);
    }
    const person = personOf(provider, grant.person)!;
    const access = provider === "github" ? `gho_${randomBytes(18).toString("hex")}` : randomBytes(24).toString("base64url");
    tokens.set(access, { provider, person: person.id, scope: grant.scope });
    logins.push({ at: new Date().toISOString(), provider, person: person.id, client: client.id });
    appendFileSync(config.log, `${new Date().toISOString()} ${provider} token for ${person.id}\n`);
    if (provider === "github") return answer(200, { access_token: access, token_type: "bearer", scope: grant.scope || "read:user,user:email" });
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> =
      provider === "google"
        ? { iss: issuerOf("google"), azp: client.id, aud: client.id, sub: person.id, email: person.email, email_verified: person.verified, name: person.name, ...(person.domain ? { hd: person.domain } : {}), nonce: grant.nonce, iat: now, exp: now + 3600 }
        : {
            ver: "2.0",
            iss: issuerOf("microsoft", person),
            aud: client.id,
            sub: createHash("sha256").update(`${client.id}:${person.id}`).digest("base64url").slice(0, 43),
            oid: person.id,
            tid: person.domain ?? MICROSOFT_CONSUMERS,
            name: person.name,
            preferred_username: person.login ?? person.email ?? person.name,
            ...(person.email ? { email: person.email } : {}),
            // Microsoft vouches for the email claim only with this optional claim set.
            ...(person.email && person.verified ? { xms_edov: true } : {}),
            nonce: grant.nonce,
            iat: now,
            nbf: now,
            exp: now + 3600,
          };
    json(res, 200, { token_type: "Bearer", access_token: access, expires_in: 3599, scope: grant.scope, id_token: jwt(claims) });
  };

  const bearer = (req: IncomingMessage, provider: ProviderName) => {
    const given = /^(?:Bearer|token) (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const held = given ? tokens.get(given) : undefined;
    return held && held.provider === provider ? personOf(provider, held.person) : undefined;
  };

  /** Who each provider signs in, for a person trying the orchestrator by hand: the chooser lists the same people. */
  const peoplePage = (res: ServerResponse) => {
    const rows = (["google", "github", "microsoft"] as const).flatMap((provider) =>
      config.people[provider].map((p) => `<tr><td>${provider}</td><td>${escape(p.name)}</td><td>${escape(p.email ?? "no address")}</td><td>${p.verified ? "verified" : "not verified"}</td></tr>`),
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Lab sign-in people</title><h1>The lab's stand-in sign-in people</h1><p>Each provider's sign-in page offers these people; nothing here is a real account.</p><table><tr><th>Provider</th><th>Name</th><th>Address</th><th>Address checked</th></tr>${rows.join("")}</table>`);
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const path = url.pathname;
      const params = req.method === "POST" ? new URLSearchParams(raw) : url.searchParams;
      appendFileSync(config.log, `${new Date().toISOString()} ${req.method} ${path}\n`);
      if (path === "/health") return json(res, 200, { ok: true });
      if (path === "/lab/logins") return json(res, 200, { logins });
      if (path === "/" || path === "/lab/people") return peoplePage(res);
      if (path === "/google/.well-known/openid-configuration") return json(res, 200, discovery("google"));
      if (path === "/microsoft/common/v2.0/.well-known/openid-configuration") return json(res, 200, discovery("microsoft"));
      if (path === endpoints.google.keys || path === endpoints.microsoft.keys) return json(res, 200, { keys: [jwk] });
      for (const provider of ["google", "microsoft", "github"] as const) {
        if (path === endpoints[provider].authorize) return authorize(provider, req, res, params);
        if (path === endpoints[provider].token && req.method === "POST") return token(provider, req, res, new URLSearchParams(raw));
      }
      if (path === endpoints.google.userinfo || path === endpoints.microsoft.userinfo) {
        const provider = path === endpoints.google.userinfo ? "google" : "microsoft";
        const person = bearer(req, provider);
        if (!person) return json(res, 401, { error: "invalid_token" });
        return json(res, 200, provider === "google" ? { sub: person.id, email: person.email, email_verified: person.verified, name: person.name, ...(person.domain ? { hd: person.domain } : {}) } : { sub: person.id, name: person.name, ...(person.email ? { email: person.email } : {}), ...(person.email && person.verified ? { xms_edov: true } : {}) });
      }
      if (path === "/github/api/user" || path === "/github/api/user/emails") {
        const person = bearer(req, "github");
        if (!person) return json(res, 401, { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" });
        if (path === "/github/api/user") return json(res, 200, { login: person.login, id: Number(person.id), type: "User", name: person.name, email: person.verified ? person.email : null, avatar_url: `${base}/github/avatars/${person.id}` });
        return json(res, 200, person.email ? [{ email: person.email, primary: true, verified: person.verified, visibility: person.verified ? "public" : null }] : []);
      }
      json(res, 404, { error: "not_found" });
    });
  });
  return new Promise((resolve) =>
    server.listen(config.port, config.host ?? "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ base, close: () => new Promise<void>((done) => server.close(() => done())) });
    }),
  );
}

/** Run as `lab.mjs sign-in <config.json>`: the providers live until down.sh stops them. */
export async function signInProvidersMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as SignInProvidersConfig;
  await startSignInProviders(config);
  appendFileSync(config.log, `sign-in providers listening on 127.0.0.1:${config.port}\n`);
}
