import { randomBytes } from "node:crypto";
import { FORGES } from "../../shared/forge-def.js";
import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { connectRepo } from "../connect.js";
import { OrchestratorError } from "../errors.js";
import { recordEvent } from "../events.js";
import { hostFromUrl, marketplaceNameProblem, SCAFFOLD_COMMIT_TITLE, skeletonFiles } from "../plugin.js";
import { ORCHESTRATOR_RELEASE } from "../setup.js";
import type { RepoRecord } from "../store.js";
import { readSecret, storeSecret } from "../vault.js";
import { forgeCall, SetupRefused } from "./admin.js";
import type { RepoAdmin, RepoTarget } from "./admin.js";
import type { ForgeHttp } from "./http.js";
import { connectionHttp, listConnectionRepos } from "./oauth-repos.js";
import { forgeApp, readConnection } from "./oauth.js";
import type { AppForge, ConnectionRecord } from "./oauth.js";
import { installationSettingsUrl } from "./oauth-github.js";
import { DRIVERS } from "./registry.js";

export { MakeItOnGitHub, NOT_EMPTY } from "./admin.js";
export type { ForgeStep } from "./admin.js";

/**
 * The team's skills repository, set up on the customer's own forge by the orchestrator: a new
 * repository, or one that is truly empty, gets TeamHandbook's scaffold as its first commit,
 * written straight to it, then is connected here and given a webhook back to the orchestrator.
 *
 * This is the one place the orchestrator writes to a default branch without a request, and it is
 * held narrow: only a repository this call created or found with no branch and no commit at
 * all, never with force, and only when the person pressed Create. A repository with even one
 * commit is written to only through requests, as every other change is.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface TeamRepoInput {
  /** The new repository's name, or, with `existing`, nothing. */
  name?: unknown;
  /** An empty repository the connection lists, as owner/name or group/name, to scaffold instead of creating one. */
  existing?: unknown;
  team: unknown;
  visibility?: unknown;
  /** GitLab only: the group to create it in; the connected person's own namespace when left out. */
  namespace?: unknown;
}

export interface TeamRepoResult {
  repo: RepoRecord;
  /** "installed", or why the orchestrator set no webhook; the repository works either way, read on its own schedule. */
  webhook: string;
}

/** The secret a forge signs its deliveries for this repository with, sealed beside the repository. */
export const hookSecretName = (repoId: string) => `forge.hook.${repoId}`;

/**
 * Takes the webhook the orchestrator set off the forge, as the repository leaves the orchestrator. Best
 * effort: a forge that refuses or a connection that is gone leaves a webhook whose deliveries
 * the orchestrator answers as unknown, since its secret goes either way.
 */
export async function removeForgeHook(ctx: OrchestratorContext, repoId: string): Promise<void> {
  const raw = await ctx.store.getSetting(ctx.tenant, hookSecretName(repoId));
  await ctx.store.deleteSetting(ctx.tenant, hookSecretName(repoId));
  if (!raw) return;
  const { kind, path } = JSON.parse(raw) as { kind: AppForge; path: string };
  await connectionHttp(ctx, kind)
    .then(({ http }) => http.request("DELETE", path))
    .catch((err: Error) => console.error(`the webhook of ${repoId} stays on ${FORGES[kind].label}: ${err.message}`));
}

export async function forgeHookSecret(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, repoId: string): Promise<string | null> {
  return readSecret(ctx.store, ctx.vault ?? null, ctx.tenant, hookSecretName(repoId)).catch(() => null);
}

export async function createTeamRepo(ctx: OrchestratorContext, user: Principal, kind: AppForge, input: TeamRepoInput): Promise<TeamRepoResult> {
  if (user.key || !manages(user)) throw new SetupRefused("only an owner or an admin signed in to the orchestrator sets up the team repository", 403);
  const record = await readConnection(ctx, kind);
  const name = FORGES[kind].label;
  if (!record) throw new SetupRefused(`connect ${name} first under Integrations`, 409);
  const team = typeof input.team === "string" ? input.team.trim() : "";
  if (!team || team.length > 120) throw new SetupRefused("enter the team");
  const { admin } = DRIVERS[kind];
  const { http } = await connectionHttp(ctx, kind);

  const target = typeof input.existing === "string" && input.existing ? await emptyExisting(ctx, kind, admin, http, input.existing) : await createNew(ctx, kind, admin, http, record, input);
  const marketplace = target.fullName.split("/").pop()!.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (marketplaceNameProblem(marketplace)) throw new SetupRefused(`${target.fullName} does not make a plugin name: ${marketplaceNameProblem(marketplace)}; choose another name`);
  const files = skeletonFiles(marketplace, target.url, hostFromUrl(target.url), "", false, undefined, {}, ORCHESTRATOR_RELEASE);
  const where = `${target.url}${target.created ? ", which the orchestrator created," : ""}`;

  try {
    await admin.writeScaffold(http, target, files, { name: user.name, email: user.email }, SCAFFOLD_COMMIT_TITLE);
  } catch (err) {
    if (err instanceof SetupRefused) throw err;
    // The repository is the customer's from the moment it exists: it is named, never deleted.
    throw new SetupRefused(`${where} has no scaffold: ${(err as Error).message}. It is still empty there; pick it as an existing empty repository to try again, or delete it on ${name}`, 502);
  }

  let repo: RepoRecord;
  try {
    repo = await connectRepo(ctx, user, { forge: kind, url: target.url, team, kind: "skills" }, kind);
  } catch (err) {
    throw new SetupRefused(`${where} has its scaffold, but the orchestrator did not connect it: ${(err as Error).message}. Connect it from the list of ${name} repositories`, err instanceof OrchestratorError ? (err.status as 409) : 502);
  }
  await recordEvent(ctx, user, "forge.team-repo", { repoId: repo.id, subject: `repo:${repo.id}`, detail: `${target.created ? "created" : "set up the empty"} ${target.fullName} on ${name} as team ${team}'s skills repository, its scaffold written as the first commit` });
  return { repo, webhook: await installWebhook(ctx, kind, admin, http, target, repo.id) };
}

/** A repository the connection lists with no branch and no tag: nothing in it to protect, so the first commit can go straight in. */
async function emptyExisting(ctx: OrchestratorContext, kind: AppForge, admin: RepoAdmin, http: ForgeHttp, fullName: string): Promise<RepoTarget> {
  const listed = (await forgeCall(() => listConnectionRepos(ctx, kind))).find((r) => r.fullName === fullName);
  if (!listed) throw new SetupRefused(`${FORGES[kind].label} does not list ${fullName} for this connection. ${FORGES[kind].emptyListHint}`, 404);
  if (listed.connected) throw new SetupRefused(`${fullName} is already connected as ${listed.connected}`, 409);
  return admin.emptyTarget(http, fullName, listed.url);
}

async function createNew(ctx: OrchestratorContext, kind: AppForge, admin: RepoAdmin, http: ForgeHttp, record: ConnectionRecord, input: TeamRepoInput): Promise<RepoTarget> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!NAME.test(name) || name.endsWith(".git")) throw new SetupRefused("a repository name is letters, digits, dots, dashes and underscores");
  const visibility = typeof input.visibility === "string" ? input.visibility : "private";
  if (!admin.visibilities.includes(visibility)) throw new SetupRefused(`visibility is ${admin.visibilities.join(", ").replace(/, ([^,]+)$/, " or $1")}`);
  const namespace = typeof input.namespace === "string" && input.namespace.trim() ? input.namespace.trim() : undefined;
  const app = await forgeApp(ctx, kind);
  const webUrl = app?.webUrl ?? `https://${FORGES[kind].homeHosts[0]}`;
  const manageUrl = kind === "github" && record.installationId !== undefined ? installationSettingsUrl({ webUrl }, record) : null;
  return admin.create(http, { name, visibility, ...(namespace ? { namespace } : {}) }, { account: record.account, organization: Boolean(record.organization), webUrl, manageUrl });
}

/**
 * A push and a request's change reach the orchestrator at once through a webhook signed with a secret
 * of the repository's own. Without ORCHESTRATOR_PUBLIC_URL there is nowhere for the forge to send it.
 */
async function installWebhook(ctx: OrchestratorContext, kind: AppForge, admin: RepoAdmin, http: ForgeHttp, target: RepoTarget, repoId: string): Promise<string> {
  if (!ctx.publicUrl) return `not set: whoever runs the orchestrator sets ORCHESTRATOR_PUBLIC_URL so ${FORGES[kind].label} can reach it; until then the repository is read on the orchestrator's own schedule`;
  const url = `${ctx.publicUrl.replace(/\/+$/, "")}${ctx.webBase ? `/api/orgs/${encodeURIComponent(ctx.tenant)}` : "/api"}/hooks/forge/${encodeURIComponent(repoId)}`;
  const secret = randomBytes(32).toString("base64url");
  try {
    await storeSecret(ctx.store, ctx.vault ?? null, ctx.tenant, hookSecretName(repoId), secret, "orchestrator");
    const hook = admin.webhook(target, url, secret);
    const made = await http.request<{ id?: unknown }>("POST", hook.path, hook.body);
    // Kept so removing the repository from the orchestrator takes its webhook off the forge too.
    if (typeof made.id === "number") await ctx.store.setSetting(ctx.tenant, hookSecretName(repoId), JSON.stringify({ kind, path: `${hook.path}/${made.id}` }));
    return "installed";
  } catch (err) {
    await ctx.store.deleteSecret(ctx.tenant, hookSecretName(repoId));
    return `not set: ${(err as Error).message}; the repository is read on the orchestrator's own schedule`;
  }
}
