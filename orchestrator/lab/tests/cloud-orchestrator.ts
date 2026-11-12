import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PUBLIC_URL } from "../../browser-tests/cloud-setup.js";
import { freePort } from "../clean-machine.js";
import { SIGN_IN_PEOPLE, signInClients } from "../cloud.js";
import { startSignInProviders } from "../sign-in-providers.js";
import { lab, unique } from "./support.js";

export { PUBLIC_URL };

export interface CloudOrchestrator {
  /** Where the orchestrator listens; the browser reaches it at PUBLIC_URL through a route. */
  origin: string;
  providers: string;
  log: string;
  providersLog: string;
  /** Each table's rows in the orchestrator's database, for the evidence. */
  rows: () => Promise<Record<string, number>>;
  stop: () => Promise<void>;
}

/**
 * A cloud orchestrator of the scenario's own (ORCHESTRATOR_MODE=cloud) on a fresh database in the
 * lab's Postgres, migrated as a cloud orchestrator has to be before it starts, with stand-in
 * Google, GitHub and Microsoft of its own on a free port. It runs as a process of this machine and
 * starts no container: a scenario that runs no task needs none.
 */
export async function cloudOrchestrator(scenario: string): Promise<CloudOrchestrator> {
  const admin = lab.postgres!.url;
  const dir = join(lab.dir, scenario, unique("cloud"));
  mkdirSync(dir, { recursive: true });
  const name = unique("cloud_db").replace(/-/g, "_");
  const database = new URL(admin);
  database.pathname = `/${name}`;
  const run = async (sql: string, url = admin) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await run(`CREATE DATABASE ${name}`);
  const clients = signInClients([PUBLIC_URL]);
  const providersLog = join(dir, "providers.log");
  const providers = await startSignInProviders({ port: 0, people: SIGN_IN_PEOPLE, clients, log: providersLog });
  const port = await freePort();
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    ORCHESTRATOR_MODE: "cloud",
    ORCHESTRATOR_DATABASE_URL: database.toString(),
    ORCHESTRATOR_SECRET_KEY: "3".repeat(64),
    ORCHESTRATOR_PUBLIC_URL: PUBLIC_URL,
    ORCHESTRATOR_PORT: String(port),
    ORCHESTRATOR_DATA_DIR: join(dir, "data"),
    ORCHESTRATOR_WEB_ROOT: join(lab.orchestratorDir, "dist", "web"),
    ORCHESTRATOR_AGENTS: "fake",
    ORCHESTRATOR_TASK_ISOLATION: "container",
    ORCHESTRATOR_TASK_NETWORK: "none",
    ORCHESTRATOR_TASK_USER: "1000:1000",
    ORCHESTRATOR_TASK_IMAGE: "teamhandbook-task:lab",
    ORCHESTRATOR_QUOTA_MEMBERS: "unlimited",
    ORCHESTRATOR_QUOTA_TASKS_PER_MONTH: "unlimited",
    ORCHESTRATOR_QUOTA_CONCURRENT_TASKS: "unlimited",
    ORCHESTRATOR_PRIVACY_URL: "https://landing.example.invalid/privacy",
    ORCHESTRATOR_TERMS_URL: "https://landing.example.invalid/terms",
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
  const server = join(lab.orchestratorDir, "dist", "server.js");
  execFileSync("node", [server, "migrate"], { env, stdio: "ignore" });
  const log = join(dir, "orchestrator.log");
  const child = spawn("node", [server], { env, stdio: ["ignore", openSync(log, "a"), openSync(log, "a")] });
  // How the process ended is written down, so a scenario that finds it gone can say why.
  child.on("exit", (code, signal) => appendFileSync(log, `[the orchestrator process ended: exit ${code}, signal ${signal}, at ${new Date().toISOString()}]\n`));
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    await providers.close();
    await run(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  };
  for (let tries = 0; !(await fetch(`${origin}/api/health`).then((r) => r.ok, () => false)); tries++) {
    if (tries > 360 || child.exitCode !== null) {
      await stop();
      throw new Error(`the cloud orchestrator did not start: ${readFileSync(log, "utf8").trim().split("\n").slice(-5).join(" | ")}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // The browser helpers of the cloud suite (browser-tests/cloud-browser.ts) route to these.
  process.env.CLOUD_E2E_ORIGIN = origin;
  process.env.CLOUD_E2E_PROVIDERS = providers.base;
  const rows = async () => {
    const { rows: tables } = await run("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename", database.toString());
    const counted: Record<string, number> = {};
    for (const { tablename } of tables as { tablename: string }[]) counted[tablename] = Number((await run(`SELECT count(*) AS n FROM "${tablename}"`, database.toString())).rows[0].n);
    return counted;
  };
  return { origin, providers: providers.base, log, providersLog, rows, stop };
}
