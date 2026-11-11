import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { SIGN_IN_PEOPLE, signInClients } from "../lab/cloud.js";
import { startSignInProviders } from "../lab/sign-in-providers.js";

/** The address the browser uses; the specs route it to the orchestrator's port. */
export const PUBLIC_URL = "https://orchestrator.example.invalid";

/**
 * A cloud orchestrator of its own for these specs: a fresh database, migrated as a cloud orchestrator has
 * to be before it starts, the lab's stand-in providers on a free port, and the orchestrator on
 * ORCHESTRATOR_E2E_PORT. Without ORCHESTRATOR_TEST_DATABASE_URL nothing starts and the specs skip.
 */
export default async function cloudSetup(): Promise<(() => Promise<void>) | void> {
  const admin = process.env.ORCHESTRATOR_TEST_DATABASE_URL;
  if (!admin) return;
  const port = Number(process.env.ORCHESTRATOR_E2E_PORT ?? 18192);
  const scratch = mkdtempSync(join(tmpdir(), "orchestrator-cloud-e2e-"));
  const name = `cloud_e2e_${randomBytes(6).toString("hex")}`;
  const database = new URL(admin);
  database.pathname = `/${name}`;
  const run = async (sql: string) => {
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    await client.query(sql);
    await client.end();
  };
  await run(`CREATE DATABASE ${name}`);
  execFileSync("npm", ["run", "build"], { stdio: "ignore" });
  const clients = signInClients([PUBLIC_URL]);
  const providers = await startSignInProviders({ port: 0, people: SIGN_IN_PEOPLE, clients, log: join(scratch, "providers.log") });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    ORCHESTRATOR_MODE: "cloud",
    ORCHESTRATOR_DATABASE_URL: database.toString(),
    ORCHESTRATOR_SECRET_KEY: "2".repeat(64),
    ORCHESTRATOR_PUBLIC_URL: PUBLIC_URL,
    ORCHESTRATOR_PORT: String(port),
    ORCHESTRATOR_DATA_DIR: join(scratch, "data"),
    ORCHESTRATOR_AGENTS: "fake",
    ORCHESTRATOR_TASK_ISOLATION: "container",
    ORCHESTRATOR_TASK_NETWORK: "none",
    ORCHESTRATOR_TASK_USER: "1000:1000",
    ORCHESTRATOR_TASK_IMAGE: "teamhandbook-task:e2e",
    ORCHESTRATOR_QUOTA_MEMBERS: "unlimited",
    ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: "unlimited",
    ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "unlimited",
    ORCHESTRATOR_PRIVACY_URL: "http://127.0.0.1:3050/en/teamhandbook/orchestrator/privacy",
    ORCHESTRATOR_TERMS_URL: "http://127.0.0.1:3050/en/teamhandbook/orchestrator/terms",
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: clients.google[0]!.id,
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET: clients.google[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER: `${providers.base}/google`,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID: clients.github[0]!.id,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_SECRET: clients.github[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GITHUB_URL: `${providers.base}/github`,
    ORCHESTRATOR_SIGN_IN_GITHUB_API_URL: `${providers.base}/github/api`,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_ID: clients.microsoft[0]!.id,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_SECRET: clients.microsoft[0]!.secret,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_ISSUER: `${providers.base}/microsoft/common/v2.0`,
  };
  execFileSync("node", ["dist/server.js", "migrate"], { env, stdio: "ignore" });
  const log = join(scratch, "console.log");
  const out = openSync(log, "a");
  const server = spawn("node", ["dist/server.js"], { env, stdio: ["ignore", out, out] });
  const origin = `http://127.0.0.1:${port}`;
  for (let tries = 0; ; tries++) {
    if (await fetch(`${origin}/api/health`).then((r) => r.ok, () => false)) break;
    if (tries > 360 || server.exitCode !== null) {
      server.kill();
      await providers.close();
      throw new Error(`the cloud orchestrator did not start: ${readFileSync(log, "utf8").trim().split("\n").slice(-5).join(" | ")}`);
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  process.env.CLOUD_E2E_ORIGIN = origin;
  process.env.CLOUD_E2E_PROVIDERS = providers.base;
  return async () => {
    server.kill();
    await providers.close();
    await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  };
}
