import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { SIGN_IN_PEOPLE, signInClients } from "./cloud.js";
import type { SignInProvidersConfig } from "./sign-in-providers.js";

/**
 * A cloud orchestrator on this machine for a person to sign up to, rather than for a test: the
 * orchestrator's own image with Postgres and tasks in containers, the lab's stand-in Google, GitHub
 * and Microsoft, and a front that answers on plain http and serves the orchestrator over TLS, the
 * only address a cloud orchestrator starts on. lab/cloud-local.sh starts and stops it; this writes
 * what it starts from, once, so the clients and secrets stay the same across restarts.
 */

/** The orchestrator inside its container, and where the containers find Postgres. */
const ORCHESTRATOR_PORT = 8080;

export interface FrontConfig {
  http: number;
  https: number;
  publicUrl: string;
  cert: string;
  key: string;
  log: string;
}

/** Usage: `lab.mjs cloud-local-config <dir> <http port> <postgres host> [privacy url] [terms url] [help url]`. */
export function cloudLocalConfig(args: string[]): void {
  const [dir, httpPort, postgres, privacy, terms, help] = args;
  if (!dir || !httpPort || !postgres) throw new Error("usage: lab.mjs cloud-local-config <dir> <http port> <postgres host> [privacy url] [terms url] [help url]");
  const ports = { http: Number(httpPort), https: Number(httpPort) + 1, providers: Number(httpPort) + 3 };
  const publicUrl = `https://localhost:${ports.https}`;
  const run = join(dir, "run");
  const secrets = join(dir, "secrets");
  // Made once; on a later start only the people are written again, so one added to the lab is offered without new clients.
  if (existsSync(join(dir, "orchestrator.env"))) {
    const kept = JSON.parse(readFileSync(join(run, "sign-in.json"), "utf8")) as SignInProvidersConfig;
    writeFileSync(join(run, "sign-in.json"), JSON.stringify({ ...kept, people: SIGN_IN_PEOPLE }, null, 2) + "\n");
    return;
  }
  mkdirSync(run, { recursive: true });
  mkdirSync(secrets, { recursive: true, mode: 0o700 });

  const clients = signInClients([publicUrl]);
  const providers: SignInProvidersConfig = { port: ports.providers, host: "0.0.0.0", people: SIGN_IN_PEOPLE, clients, log: "/lab/sign-in.log" };
  writeFileSync(join(run, "sign-in.json"), JSON.stringify(providers, null, 2) + "\n");
  const front: FrontConfig = { http: ports.http, https: ports.https, publicUrl, cert: "/lab/cert.pem", key: "/lab/key.pem", log: "/lab/front.log" };
  writeFileSync(join(run, "front.json"), JSON.stringify(front, null, 2) + "\n");

  // Readable by the orchestrator's own user inside its container, in a directory only this user opens.
  const secret = (name: string, value: string) => writeFileSync(join(secrets, name), value, { mode: 0o644 });
  const pgPassword = randomBytes(24).toString("hex");
  secret("pg_password", pgPassword);
  secret("database_url", `postgres://orchestrator:${pgPassword}@${postgres}:5432/orchestrator`);
  secret("secret_key", randomBytes(32).toString("base64"));
  for (const provider of ["google", "github", "microsoft"] as const) secret(`${provider}_client_secret`, clients[provider][0]!.secret);

  const providersUrl = `http://127.0.0.1:${ports.providers}`;
  const env: Record<string, string> = {
    ORCHESTRATOR_MODE: "cloud",
    ORCHESTRATOR_AUTH: "local",
    ORCHESTRATOR_PUBLIC_URL: publicUrl,
    ORCHESTRATOR_ALLOWED_HOSTS: "localhost,127.0.0.1",
    // The front reaches the orchestrator from inside its container.
    ORCHESTRATOR_TRUSTED_PROXY: "127.0.0.1",
    ORCHESTRATOR_DATABASE_URL_FILE: "/run/secrets/database_url",
    ORCHESTRATOR_SECRET_KEY_FILE: "/run/secrets/secret_key",
    ORCHESTRATOR_AGENTS: "fake",
    ORCHESTRATOR_QUOTA_MEMBERS: "unlimited",
    ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: "unlimited",
    ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "2",
    // A preview is signed up to again and again by the same few stand-in people.
    ORCHESTRATOR_ORGS_PER_IDENTITY_DAY: "100",
    ORCHESTRATOR_SERVER_TASKS: "1",
    ORCHESTRATOR_TASK_ISOLATION: "container",
    ORCHESTRATOR_TASK_NETWORK: "none",
    ORCHESTRATOR_TASK_USER: "1000:1000",
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: clients.google[0]!.id,
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/google_client_secret",
    ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER: `${providersUrl}/google`,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID: clients.github[0]!.id,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_SECRET_FILE: "/run/secrets/github_client_secret",
    ORCHESTRATOR_SIGN_IN_GITHUB_URL: `${providersUrl}/github`,
    ORCHESTRATOR_SIGN_IN_GITHUB_API_URL: `${providersUrl}/github/api`,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_ID: clients.microsoft[0]!.id,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_SECRET_FILE: "/run/secrets/microsoft_client_secret",
    ORCHESTRATOR_SIGN_IN_MICROSOFT_ISSUER: `${providersUrl}/microsoft/common/v2.0`,
    ...(privacy ? { ORCHESTRATOR_PRIVACY_URL: privacy } : {}),
    ...(terms ? { ORCHESTRATOR_TERMS_URL: terms } : {}),
    ...(help ? { ORCHESTRATOR_HELP_URL: help } : {}),
  };
  writeFileSync(join(dir, "orchestrator.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

/**
 * The orchestrator's TLS front: https on its own port, passed on to the orchestrator with the address it
 * came from, and plain http answered with the same path on the https address.
 */
export function frontMain(file: string): void {
  const config = JSON.parse(readFileSync(file, "utf8")) as FrontConfig;
  const forward = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = request(
      { host: "127.0.0.1", port: ORCHESTRATOR_PORT, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress ?? "", "x-forwarded-proto": "https" } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      appendFileSync(config.log, `${new Date().toISOString()} ${req.method} ${req.url} unreachable: ${err.message}\n`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("the orchestrator is not answering yet\n");
    });
    req.pipe(upstream);
  };
  createHttpsServer({ cert: readFileSync(config.cert), key: readFileSync(config.key) }, forward).listen(config.https, "0.0.0.0");
  createHttpServer((req, res) => {
    res.writeHead(302, { location: new URL(req.url ?? "/", config.publicUrl).toString() });
    res.end();
  }).listen(config.http, "0.0.0.0", () => appendFileSync(config.log, `front on ${config.http} (http) and ${config.https} (https) for ${config.publicUrl}\n`));
}
