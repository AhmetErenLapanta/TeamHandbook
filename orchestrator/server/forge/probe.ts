import type { OrchestratorContext } from "../app.js";
import { installationNow, liftSuspension, SUSPENDED } from "./oauth-github.js";
import { apiGet, forgeApp, gitlabAccount, gitlabToken, readConnection } from "./oauth.js";
import type { AppForge } from "./oauth.js";

/**
 * What the Integrations card shows when an owner checks the org's connection: whether its token
 * opens, which account it is, whether what it was granted covers what the orchestrator does with
 * it, and the forge's version. It reads the forge and changes nothing, on it or in the orchestrator.
 */
export interface ConnectionCheck {
  ok: boolean;
  account: string | null;
  /** What the forge says the connection may do: GitLab's scopes, GitHub's installation permissions. */
  granted: string[];
  /** What the orchestrator needs and the connection was not granted. */
  missing: string[];
  version: string | null;
  problem: string | null;
}

/** GitLab opens requests, writes commits and sets hooks under one scope. */
const GITLAB_NEEDS = ["api"];

/**
 * What the GitHub App's installation has to allow for each thing the orchestrator does: open pull
 * requests from a branch with whole files, set a check, read the request's check runs, read and set
 * webhooks, read issues. Without checks a request's page fails to read, since its head's check runs
 * are read with it. Creating a team repository in an organization needs administration too; it is reported apart.
 */
const GITHUB_NEEDS: Record<string, "read" | "write"> = { contents: "write", pull_requests: "write", statuses: "write", checks: "read", metadata: "read", repository_hooks: "write", issues: "read" };

const covers = (granted: string | undefined, needed: "read" | "write") => granted === "write" || (needed === "read" && granted === "read");

export async function checkConnection(ctx: OrchestratorContext, kind: AppForge): Promise<ConnectionCheck> {
  const failed = (problem: string, account: string | null = null): ConnectionCheck => ({ ok: false, account, granted: [], missing: [], version: null, problem });
  const record = await readConnection(ctx, kind);
  if (!record) return failed(`${kind === "gitlab" ? "GitLab" : "GitHub"} is not connected`);
  try {
    if (kind === "gitlab") {
      const app = (await forgeApp(ctx, "gitlab"))!;
      const token = await gitlabToken(ctx);
      const bearer = { authorization: `Bearer ${token}` };
      const account = await gitlabAccount(app, token);
      const info = await apiGet<{ scope?: unknown; scopes?: unknown }>(`${app.webUrl}/oauth/token/info`, bearer, [token], app.send);
      const granted = (Array.isArray(info.scope) ? info.scope : Array.isArray(info.scopes) ? info.scopes : []).filter((s): s is string => typeof s === "string");
      const version = await apiGet<{ version?: unknown }>(`${app.apiUrl}/version`, bearer, [token], app.send).then((v) => (typeof v.version === "string" ? v.version : null), () => null);
      const missing = GITLAB_NEEDS.filter((scope) => !granted.includes(scope));
      return { ok: missing.length === 0 && account === record.account, account, granted, missing, version, problem: account === record.account ? null : `the token signs in as ${account}, not ${record.account}; press Reconnect with GitLab and sign in as ${record.account}` };
    }
    const installation = await installationNow(ctx.forgeApps!.github!, record.installationId!);
    if (!installation) return failed(`the app is no longer installed on ${record.account}; press Reconnect with GitHub to install it again`);
    if (installation.suspended) return failed(`${SUSPENDED} on ${record.account}; ${liftSuspension(record.account)}`, installation.login);
    const granted = Object.entries(installation.permissions).map(([name, level]) => `${name}: ${level}`).sort();
    const missing = Object.entries(GITHUB_NEEDS).filter(([name, level]) => !covers(installation.permissions[name], level)).map(([name, level]) => `${name}: ${level}`);
    if (record.organization && !covers(installation.permissions.administration, "write")) missing.push("administration: write (only to create the team repository here)");
    return { ok: missing.length === 0, account: installation.login, granted, missing, version: "2022-11-28", problem: null };
  } catch (err) {
    return failed((err as Error).message, record.account);
  }
}
