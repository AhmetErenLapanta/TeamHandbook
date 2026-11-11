import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A stand-in OpenID Connect provider for the lab: discovery, an authorization page that lists
 * the lab's single sign-on people to pick from, a token endpoint that checks the client secret
 * and the PKCE verifier, and the key set that signs its ES256 ID tokens. Each person carries an
 * address the provider says it verified, unless the lab says otherwise, and their groups. Nothing
 * here talks to a real provider.
 */

export interface IdpPerson {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  verified: boolean;
}

export interface IdpClient {
  id: string;
  secret: string;
  redirect: string;
}

export interface IdpConfig {
  port: number;
  people: IdpPerson[];
  clients: IdpClient[];
  log: string;
}

interface Grant {
  client: string;
  redirect: string;
  nonce: string;
  challenge: string;
  sub: string;
  expires: number;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function startIdp(config: IdpConfig): Promise<void> {
  const issuer = `http://127.0.0.1:${config.port}`;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomBytes(8).toString("hex");
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>), kid, alg: "ES256", use: "sig" };
  const grants = new Map<string, Grant>();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const idToken = (key: KeyObject, claims: Record<string, unknown>) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signing = `${part({ alg: "ES256", typ: "JWT", kid })}.${part(claims)}`;
    return `${signing}.${sign("sha256", Buffer.from(signing), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };

  const authorize = (req: IncomingMessage, res: ServerResponse, url: URL, form: URLSearchParams) => {
    const params = req.method === "POST" ? form : url.searchParams;
    const client = config.clients.find((c) => c.id === params.get("client_id"));
    const redirect = params.get("redirect_uri") ?? "";
    if (!client || client.redirect !== redirect) return json(res, 400, { error: "invalid_client" });
    if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return json(res, 400, { error: "invalid_request" });
    const sub = req.method === "POST" ? params.get("sub") : null;
    const person = config.people.find((p) => p.sub === sub);
    if (!person) {
      // The page a person signs in on: here, the lab's people to pick from, the request's own parameters carried in hidden fields.
      const hidden = ["client_id", "redirect_uri", "response_type", "scope", "state", "nonce", "code_challenge", "code_challenge_method"]
        .map((name) => `<input type="hidden" name="${name}" value="${escape(params.get(name) ?? "")}">`)
        .join("");
      const choices = config.people.map((p) => `<button type="submit" name="sub" value="${escape(p.sub)}">${escape(p.name)} (${escape(p.email)})</button>`).join("");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Lab sign-in</title><h1>Lab sign-in</h1><form method="post" action="/authorize">${hidden}${choices}</form>`);
      return;
    }
    const code = randomBytes(24).toString("base64url");
    grants.set(code, { client: client.id, redirect, nonce: params.get("nonce") ?? "", challenge: params.get("code_challenge")!, sub: person.sub, expires: Date.now() + 60_000 });
    const back = new URL(redirect);
    back.searchParams.set("code", code);
    back.searchParams.set("state", params.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    res.end();
  };

  const token = (req: IncomingMessage, res: ServerResponse, form: URLSearchParams) => {
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const [id, secret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":").map(decodeURIComponent) : [];
    const client = config.clients.find((c) => c.id === id && c.secret === secret);
    if (!client) return json(res, 401, { error: "invalid_client" });
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!grant || grant.client !== client.id || grant.redirect !== form.get("redirect_uri") || grant.expires < Date.now() || grant.challenge !== challenge) {
      return json(res, 400, { error: "invalid_grant" });
    }
    const person = config.people.find((p) => p.sub === grant.sub)!;
    const now = Math.floor(Date.now() / 1000);
    json(res, 200, {
      token_type: "Bearer",
      access_token: randomBytes(24).toString("base64url"),
      expires_in: 300,
      id_token: idToken(privateKey, {
        iss: issuer,
        aud: client.id,
        sub: person.sub,
        nonce: grant.nonce,
        iat: now,
        exp: now + 300,
        email: person.email,
        email_verified: person.verified,
        name: person.name,
        groups: person.groups,
      }),
    });
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", issuer);
      const form = new URLSearchParams(raw);
      appendFileSync(config.log, `${new Date().toISOString()} ${req.method} ${url.pathname}\n`);
      if (url.pathname === "/.well-known/openid-configuration") {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          claims_supported: ["sub", "email", "email_verified", "name", "groups"],
        });
      }
      if (url.pathname === "/jwks") return json(res, 200, { keys: [jwk] });
      if (url.pathname === "/authorize") return authorize(req, res, url, form);
      if (url.pathname === "/token" && req.method === "POST") return token(req, res, form);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      // The lab's own door, never a provider's: a person's groups change, as a directory changes them.
      if (url.pathname === "/lab/groups" && req.method === "POST") {
        const { sub, groups } = JSON.parse(raw || "{}") as { sub?: string; groups?: string[] };
        const person = config.people.find((p) => p.sub === sub);
        if (!person || !Array.isArray(groups)) return json(res, 400, { error: "sub and groups" });
        person.groups = groups;
        return json(res, 200, { sub, groups });
      }
      json(res, 404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => server.listen(config.port, "127.0.0.1", () => resolve()));
}

/** Run as `lab.mjs idp <config.json>`: the provider lives until down.sh stops it. */
export async function idpMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as IdpConfig;
  await startIdp(config);
  appendFileSync(config.log, `identity provider listening on 127.0.0.1:${config.port}\n`);
}
