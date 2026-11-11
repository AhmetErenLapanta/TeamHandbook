import { quotaSettingsRefused } from "./quotas.js";

export type OrchestratorMode = "local" | "self-hosted" | "cloud";

const given = (env: NodeJS.ProcessEnv, name: string) => Boolean(env[name] || env[`${name}_FILE`]);

/**
 * Whether anything says this orchestrator serves more than the one person on this machine: a way
 * to sign in, a setup code, an address others reach it at, a shared database, or an auth mode
 * chosen on purpose. A team install that already has accounts says one of these, so it never
 * opens without sign-in because ORCHESTRATOR_MODE was left out.
 */
function servesATeam(env: NodeJS.ProcessEnv): boolean {
  if (Object.keys(env).some((name) => name.startsWith("ORCHESTRATOR_SIGN_IN_") && env[name])) return true;
  return ["ORCHESTRATOR_OIDC_ISSUER", "ORCHESTRATOR_SETUP_TOKEN", "ORCHESTRATOR_PUBLIC_URL", "ORCHESTRATOR_DATABASE_URL"].some((name) => given(env, name)) || Boolean(env.ORCHESTRATOR_AUTH);
}

/**
 * ORCHESTRATOR_MODE, read in one place. `local` is one person's orchestrator on their own machine, and
 * what a start with nothing configured is; `self-hosted` is a team's, with sign-in; `cloud` is
 * one many organizations reach over the internet. Every part that behaves differently asks this
 * function, so no two of them read the setting apart.
 */
export function orchestratorMode(env: NodeJS.ProcessEnv = process.env): OrchestratorMode {
  const value = env.ORCHESTRATOR_MODE;
  if (value === "local" || value === "self-hosted" || value === "cloud") return value;
  if (value !== undefined && value !== "") throw new Error(`ORCHESTRATOR_MODE=${JSON.stringify(value)} is not a mode this orchestrator knows; use local, self-hosted or cloud`);
  return servesATeam(env) ? "self-hosted" : "local";
}

export function cloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return orchestratorMode(env) === "cloud";
}

export function localMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return orchestratorMode(env) === "local";
}

/**
 * What a cloud orchestrator refuses to start without, or with, all named at once so one start shows
 * the operator everything to change. Each guards a failure that only shows later: SQLite or a
 * generated key holds one node's data and leaves the next node unable to read it, a plain
 * http address sends sign-in cookies in the clear, and dev-admin lets anyone who reaches the
 * address in as an admin.
 */
export function cloudSettingsRefused(env: NodeJS.ProcessEnv = process.env): string | null {
  const missing: string[] = [];
  if (!given(env, "ORCHESTRATOR_DATABASE_URL")) missing.push("ORCHESTRATOR_DATABASE_URL (a Postgres database)");
  if (!given(env, "ORCHESTRATOR_SECRET_KEY")) missing.push("ORCHESTRATOR_SECRET_KEY (the same key on every node)");
  if (!(env.ORCHESTRATOR_PUBLIC_URL ?? "").startsWith("https://")) missing.push("ORCHESTRATOR_PUBLIC_URL as an https:// address");
  if (env.ORCHESTRATOR_AUTH === "dev-admin") missing.push("ORCHESTRATOR_AUTH other than dev-admin");
  // A task's setup, agent and tests run what one organization's repository says. On this host
  // they run as the orchestrator's user, which reads every organization's mirrors and task
  // directories and the orchestrator's own environment, the database URL and the secret key with it.
  if (env.ORCHESTRATOR_TASK_ISOLATION !== "container") missing.push("ORCHESTRATOR_TASK_ISOLATION=container");
  // On the default bridge a task reaches the node's metadata address, and the credentials every
  // organization's data sits behind, the host's own services and other organizations' task
  // containers; with no network it reaches only what the egress proxy lets through.
  if (env.ORCHESTRATOR_TASK_NETWORK !== "none") missing.push("ORCHESTRATOR_TASK_NETWORK=none");
  // Numbers both: a name the image does not list, or a user with no group, runs in group 0, and Docker reads 00 as 0.
  const user = /^(\d+):(\d+)$/.exec(env.ORCHESTRATOR_TASK_USER ?? "");
  if (!user || Number(user[1]) === 0 || Number(user[2]) === 0) missing.push("ORCHESTRATOR_TASK_USER as uid:gid, both numbers other than 0");
  missing.push(...quotaSettingsRefused(env));
  const shared = ["ORCHESTRATOR_TASK_PROFILE=personal", "ORCHESTRATOR_TASK_ENV_PASS", "ORCHESTRATOR_LOCAL_REPOS_ROOT", "ORCHESTRATOR_MCP_LOCAL=1"].filter((setting) => {
    const [name, value] = setting.split("=") as [string, string | undefined];
    return value === undefined ? Boolean(env[name]?.trim()) : env[name] === value;
  });
  const needs = missing.length ? `needs ${missing.join(", ")}` : "";
  const refuses = shared.length ? `refuses ${shared.join(", ")}, which hand one organization this host's profile, environment, folders or local addresses` : "";
  return needs || refuses ? `ORCHESTRATOR_MODE=cloud ${[needs, refuses].filter(Boolean).join("; and ")}` : null;
}
