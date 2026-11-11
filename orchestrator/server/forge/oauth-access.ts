import { forgetMintedFor, githubToken, installationNow, liftSuspension, SUSPENDED } from "./oauth-github.js";
import { ConnectionUnusable, forgeApp, ForgeSignInFailed, gitlabAccount, gitlabToken, markBroken, readConnection, readGitLabTokens, sealGitLabTokens } from "./oauth.js";
import type { ForgeAppContext } from "./oauth.js";
import type { AppForge } from "./oauth.js";

type AccessContext = ForgeAppContext;

/** How long an account checked against the forge counts as checked. */
export const VERIFIED_MS = 10 * 60_000;

const verified = new Map<string, number>();

/** Forgets every check: for a test that changes what the forge answers. */
export function forgetVerified(): void {
  verified.clear();
}

/**
 * Whether the connection still reaches the account it was made for: the GitLab user the token
 * signs in as, the GitHub account the installation is on and that it is not suspended. Checked at
 * most every ten minutes; a different account or a gone installation marks the connection to be
 * made again, since its repositories were connected as the account it was made for. A check the
 * forge cannot answer refuses this call and marks nothing.
 */
async function verifyAccount(ctx: AccessContext, kind: AppForge, token: string, now = Date.now()): Promise<void> {
  const record = await readConnection(ctx, kind);
  if (!record) return;
  const key = `${ctx.tenant}:${kind}:${record.at}`;
  if ((verified.get(key) ?? 0) > now) return;
  let seen: string;
  if (kind === "gitlab") {
    try {
      seen = await gitlabAccount((await forgeApp(ctx, "gitlab"))!, token);
    } catch (err) {
      if (err instanceof ForgeSignInFailed) throw new ConnectionUnusable(`the GitLab connection's account was not checked: ${err.message}; press Check connection to try again`);
      throw err;
    }
  } else {
    const installation = await installationNow(ctx.forgeApps!.github!, record.installationId!);
    if (!installation) return markBroken(ctx, kind, record, `the app is no longer installed on ${record.account}`);
    if (installation.suspended) return markBroken(ctx, kind, record, `${SUSPENDED} on ${record.account}`, liftSuspension(record.account));
    seen = installation.login;
  }
  if (seen.toLowerCase() !== record.account.toLowerCase()) return markBroken(ctx, kind, record, `the connection now reaches ${seen || "another account"}, not ${record.account}, which its repositories were connected as`);
  verified.set(key, now + VERIFIED_MS);
}

/**
 * A token the forge refused (401) is not used again: GitHub's minted one is forgotten, GitLab's
 * is taken as lapsed so the next call renews it. Only when that renewal is refused too is the
 * connection marked to be made again, so one refusal does not send a person to reconnect.
 */
export async function forgetRefusedToken(ctx: AccessContext, kind: AppForge, token: string): Promise<void> {
  for (const key of verified.keys()) if (key.startsWith(`${ctx.tenant}:${kind}:`)) verified.delete(key);
  if (kind === "github") return forgetMintedFor(ctx.tenant);
  const sealed = await readGitLabTokens(ctx);
  const record = await readConnection(ctx, kind);
  // Only the token the forge refused: one renewed since stays.
  if (sealed && record && sealed.accessToken === token) await sealGitLabTokens(ctx, { ...sealed, expiresAt: new Date(0).toISOString() }, record.byEmail);
}

/** A fetch that, when the forge refuses the connection's token, forgets that token before answering. */
export function forgettingRefused(ctx: AccessContext, kind: AppForge, token: string, send: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await send(input, init);
    if (res.status === 401) await forgetRefusedToken(ctx, kind, token).catch(() => undefined);
    return res;
  }) as typeof fetch;
}

/**
 * The token a repository connected through the org's connection is reached with, for this one call,
 * once its account is checked. On GitHub `permissions` narrows it to what the call needs; GitLab has
 * no narrower scope than the connection's.
 */
export async function connectionToken(ctx: AccessContext, kind: AppForge, permissions?: Record<string, "read" | "write">): Promise<string> {
  const token = kind === "gitlab" ? await gitlabToken(ctx) : await githubToken(ctx, permissions);
  await verifyAccount(ctx, kind, token);
  return token;
}

/**
 * What reads a forge's issues through the org's connection: the API root and the headers to send.
 * On GitHub the token is narrowed to reading issues and metadata. GitLab has no narrower scope
 * than the connection's `api`, so on GitLab reading only is the caller's promise. Null when the
 * org has no connection to that forge.
 */
export async function forgeIssueAccess(ctx: AccessContext, kind: AppForge): Promise<{ baseUrl: string; headers: Record<string, string>; send: typeof fetch } | null> {
  if (!(await readConnection(ctx, kind))) return null;
  if (kind === "gitlab") {
    const token = await gitlabToken(ctx);
    await verifyAccount(ctx, kind, token);
    const app = (await forgeApp(ctx, "gitlab"))!;
    // An org's own GitLab is read only at the address judged for it now, as every other call to it.
    return { baseUrl: app.apiUrl, headers: { authorization: `Bearer ${token}` }, send: app.send ?? fetch };
  }
  const token = await githubToken(ctx, { issues: "read", metadata: "read" });
  await verifyAccount(ctx, kind, token);
  return { baseUrl: ctx.forgeApps!.github!.apiUrl, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, send: fetch };
}
