import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import { inConfiguration, mirrorDir, NOT_CONFIGURED, syncError } from "./app.js";
import { canEditTeam, manages } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { buildChange, ChangeRefused, commandRefusal, MCP_FILE, prepareChange } from "./changes.js";
import { proposedBranch, teamNaming } from "./branches.js";
import { OrchestratorError, errorAnswer } from "./errors.js";
import { recordEvent } from "./events.js";
import { RepositoryBusy } from "./store-postgres.js";
import { ForgeRefusal } from "./forge/local.js";
import type { ForgeConfig, PendingShare, RequestRecord } from "./forge/types.js";
import { scanPending } from "./pending-scan.js";
import type { PendingScan } from "./pending-scan.js";
import { gitAsyncMaybe, RepositoryGone } from "./git.js";
import { auditCommandText, auditServer, commandFile, commitMessagePrefix, commitSubject, declaredServers, refusalSummary } from "./plugin.js";
import { closeRequest, forgeTokenName, inRequestTurn, mergeRequest, propose, providerFor, refreshRequest, RequestRefused } from "./propose.js";
import type { RepoRecord, Store } from "./store.js";
import { taskMergeRefusal } from "./tasks/guards.js";
import { NO_VAULT, storeSecret } from "./vault.js";
import type { Vault } from "./vault.js";
import { FORGES, HOSTED_FORGES, isHostedForge } from "../shared/forge-def.js";
import { offeredForges } from "./connect.js";
import type { ForgeDefinition } from "../shared/forge-def.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROJECT = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PENDING_FRESH_MS = 30_000;

/**
 * The one gate every change goes through: the repository is looked up here, and the team
 * whose rights are checked is the one the store records for it - never a team named in the
 * request, which whoever sends the request controls.
 */
async function editable(ctx: OrchestratorContext, c: Context<OrchestratorEnv>): Promise<RepoRecord | Response> {
  const id = c.req.param("id") ?? "";
  const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
  if (!repo) return c.json({ error: "unknown repository" }, 404);
  if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: `only an admin or an owner of ${repo.team} can change this repository` }, 403);
  return repo;
}

function adminRepo(ctx: OrchestratorContext) {
  return async (c: Context<OrchestratorEnv>): Promise<RepoRecord | Response> => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin manages forge access" }, 403);
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    return repo ?? c.json({ error: "unknown repository" }, 404);
  };
}

function refused(c: Context, err: unknown) {
  // Told the same way on every route, by the app's error handler.
  if (err instanceof RepositoryGone) throw err;
  if (err instanceof OrchestratorError) return errorAnswer(c, err);
  // A provider's message is already masked of the token it used; git's first line is masked
  // of any credential in a URL, the same way a sync failure is.
  return c.json({ error: syncError(err) }, 502);
}


/** How a forge names a project, by its shape: owner/repository is exactly two parts, group/project a path of groups ending in the project. */
const PROJECT_PATH: Record<ForgeDefinition["projectShape"], { parts: number | null; says: string }> = {
  "group/project": { parts: null, says: "the project is its path, group/name" },
  "owner/repository": { parts: 2, says: "the project is owner/name" },
};

export function cleanForgeConfig(repoId: string, body: Record<string, unknown>): ForgeConfig {
  if (!isHostedForge(body.kind)) throw new ChangeRefused(`the forge is ${HOSTED_FORGES.join(" or ")}`);
  let url: URL;
  try {
    url = new URL(String(body.apiUrl ?? ""));
  } catch {
    throw new ChangeRefused("the API address is not a URL");
  }
  // A token is sent to this address, so it travels over TLS, except to this machine itself.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new ChangeRefused("the API address has to be https");
  if (url.username || url.password || url.search) throw new ChangeRefused("the API address carries no credentials or query");
  const project = String(body.project ?? "");
  const path = PROJECT_PATH[FORGES[body.kind].projectShape];
  if (!PROJECT.test(project) || (path.parts !== null && project.split("/").length !== path.parts)) throw new ChangeRefused(path.says);
  return { repoId, kind: body.kind, apiUrl: url.toString().replace(/\/+$/, ""), project };
}

/**
 * An admin setting where a repository's requests go. A token goes with the forge, address and
 * project it was entered for: changing any of them needs a new token, and a change sent without
 * one is refused with nothing altered. The old token is removed when the new one is stored.
 */
export async function saveForgeAccess(store: Store, vault: Vault | null, tenant: string, config: ForgeConfig, token: unknown, by: string): Promise<void> {
  const current = await store.getForgeConfig(tenant, config.repoId);
  const unchanged = current !== null && current.kind === config.kind && current.apiUrl === config.apiUrl && current.project === config.project;
  if (token !== undefined && token !== "") {
    if (typeof token !== "string" || token.length < 8 || token.length > 512 || /\s/.test(token)) throw new ChangeRefused("that token is not in a form a forge issues");
    if (!vault) throw new ChangeRefused(NO_VAULT);
    if (current) await store.deleteSecret(tenant, forgeTokenName(current));
    await storeSecret(store, vault, tenant, forgeTokenName(config), token, by);
  } else if (!unchanged) {
    // Refused with nothing changed: the stored token stays bound to the settings it was
    // entered for, and new settings start working only once a token is entered with them.
    throw new ChangeRefused(current ? "the forge, its address or the project changed; enter a token for the new settings" : "a token is needed the first time");
  } else if (!(await store.secretSetAt(tenant, forgeTokenName(config)))) {
    throw new ChangeRefused("no token is stored for these settings; enter one");
  }
  await store.setForgeConfig(tenant, config);
}

/**
 * What waits to be merged, each marked when it is a request the orchestrator opened. A branch name
 * is one anyone can repeat in a fork, so a forge's request is the orchestrator's only under the
 * number the orchestrator recorded for that branch: a forge numbers requests once per repository,
 * so no fork's request carries it. A local branch has no number, and no fork. One the orchestrator
 * has merged or closed is left out: it waits for nothing, whatever an earlier answer of the
 * forge, or a branch a close left behind, still says.
 */
export function markOurs(listed: PendingShare[], requests: RequestRecord[]): (PendingShare & { byOrchestrator: boolean })[] {
  const byBranch = new Map<string, RequestRecord[]>();
  for (const r of requests) byBranch.set(r.branch, [...(byBranch.get(r.branch) ?? []), r]);
  return listed.flatMap((p) => {
    const named = byBranch.get(p.branch) ?? [];
    const request = p.number === null ? (named.find((r) => r.status === "open") ?? named[0]) : named.find((r) => r.number === p.number);
    if (request && request.status !== "open") return [];
    return [{ ...p, number: p.number ?? request?.number ?? null, byOrchestrator: Boolean(request) }];
  });
}

export function editRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  // Every look at a repository's page reads its forge with the orchestrator's token, and anyone
  // signed in looks: kept a short while, a member reloading the page cannot spend the team's
  // rate limit on it.
  const pendingRead = new Map<string, { at: number; shares: PendingShare[] }>();

  app.get("/api/repos/:id/skills/:slug", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo?.head || !SLUG.test(slug)) return c.json({ error: "unknown skill" }, 404);
    const content = await gitAsyncMaybe(["show", `${repo.head}:skills/${slug}/SKILL.md`], mirrorDir(ctx, id));
    return content === null ? c.json({ error: "unknown skill" }, 404) : c.json({ head: repo.head, content });
  });

  // A command's text for its edit form, under the same rule: one the share rule refuses is
  // withheld, since what it was refused for is usually the credential written into it.
  app.get("/api/repos/:id/commands/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    const named = auditCommandText(name, "");
    const content = repo?.head && named.shareable ? await gitAsyncMaybe(["show", `${repo.head}:commands/${commandFile(name)}`], mirrorDir(ctx, id)) : null;
    if (content === null) return c.json({ error: "unknown command" }, 404);
    const audit = auditCommandText(name, content);
    if (!audit.shareable) return c.json({ error: `its text is withheld: ${commandRefusal(name, audit)}` }, 409);
    return c.json({ head: repo!.head, content });
  });

  // What the edit form starts from. A definition the share rule refuses usually holds the
  // credential it was refused for, so it is withheld here as the inventory withholds it.
  app.get("/api/repos/:id/mcp-servers/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    const servers = repo?.head ? declaredServers(await gitAsyncMaybe(["show", `${repo.head}:${MCP_FILE}`], mirrorDir(ctx, id))) : {};
    if (!repo?.head || !Object.hasOwn(servers, name)) return c.json({ error: "unknown server" }, 404);
    const audit = auditServer(servers[name]);
    if (!audit.migratable) return c.json({ error: `its definition is withheld: ${refusalSummary(audit)}` }, 409);
    return c.json({ head: repo.head, config: servers[name] });
  });

  app.post("/api/repos/:id/changes/proposal", async (c) => {
    const repo = await editable(ctx, c);
    if (repo instanceof Response) return repo;
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    try {
      const body = (await c.req.json().catch(() => ({}))) as { change?: unknown };
      const mirror = mirrorDir(ctx, repo.id);
      const naming = await teamNaming(mirror, repo.head);
      const built = await buildChange(mirror, repo.head, body.change);
      return c.json({ proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), built.proposal), branch: proposedBranch(built.topic, naming) });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/repos/:id/changes", async (c) => {
    const repo = await editable(ctx, c);
    if (repo instanceof Response) return repo;
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { baseSha?: unknown; change?: unknown; message?: unknown; branch?: unknown };
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    // The change is built against what the person saw. If the repository moved since, a
    // builder reading the new head would propose something they never looked at.
    if (body.baseSha !== repo.head) return c.json({ error: "the repository changed since this page was opened; reload and make the change again" }, 409);
    const user = c.get("user");
    try {
      const mirror = mirrorDir(ctx, repo.id);
      const head = repo.head;
      const request = await inRequestTurn(ctx, repo.id, async () => {
        const prepared = await prepareChange(mirror, head, body.change, body.message, user.name, await teamNaming(mirror, head), body.branch);
        return propose(ctx, repo, user, prepared);
      });
      // The request just opened waits to be merged too; the next look reads the forge again.
      pendingRead.delete(repo.id);
      return c.json({ request });
    } catch (err) {
      return refused(c, err);
    }
  });

  // What waits to be merged in the team repository, read from its forge at each look: the
  // requests the orchestrator opened beside the ones teammates' TeamHandbook or anyone else did.
  app.get("/api/repos/:id/pending", async (c) => {
    const id = c.req.param("id");
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    const provider = await providerFor(ctx, repo);
    if (!provider?.list) return c.json({ pending: null, reason: "No forge access is set for this repository, so what waits to be merged there is not read." });
    let listed = pendingRead.get(repo.id);
    if (!listed || Date.now() - listed.at > PENDING_FRESH_MS) {
      try {
        listed = { at: Date.now(), shares: await provider.list(repo) };
      } catch (err) {
        return c.json({ error: `the forge did not answer: ${syncError(err)}` }, 502);
      }
      pendingRead.set(repo.id, listed);
    }
    const pending = markOurs(listed.shares, await ctx.store.listRequests(ctx.tenant, repo.id));
    // Each one is read against the plugin's share rules from the orchestrator's own copy, so the
    // forge is asked nothing more and nothing is written to it.
    const head = repo.head;
    const mirror = mirrorDir(ctx, repo.id);
    const scans: (PendingScan | null)[] = [];
    for (const share of pending) scans.push(head ? await scanPending(mirror, head, provider.kind, share) : null);
    return c.json({ pending: pending.map((share, i) => ({ ...share, scan: scans[i] })) });
  });

  for (const [action, run] of [
    ["merge", (repo: RepoRecord, n: number, c: Context<OrchestratorEnv>) => mergeRequest(ctx, repo, n, c.get("user"))],
    ["close", (repo: RepoRecord, n: number, c: Context<OrchestratorEnv>) => closeRequest(ctx, repo, n, c.get("user"))],
    ["refresh", (repo: RepoRecord, n: number, c: Context<OrchestratorEnv>) => refreshRequest(ctx, repo, n, c.get("user"))],
  ] as const) {
    app.post(`/api/repos/:id/requests/:number/${action}`, async (c) => {
      const repo = await editable(ctx, c);
      if (repo instanceof Response) return repo;
      const number = Number(c.req.param("number"));
      if (!Number.isInteger(number) || number < 1) return c.json({ error: "unknown request" }, 404);
      const ownTask = action === "merge" ? await taskMergeRefusal(ctx, repo, number, c.get("user")) : null;
      if (ownTask) return c.json({ error: ownTask }, 403);
      try {
        const request = await run(repo, number, c);
        // A merge, a close or a forge's answer changes what waits to be merged; the next look reads it again.
        pendingRead.delete(repo.id);
        return c.json({ request });
      } catch (err) {
        return refused(c, err);
      }
    });
  }

  const forAdmin = adminRepo(ctx);

  app.get("/api/repos/:id/forge", async (c) => {
    const repo = await forAdmin(c);
    if (repo instanceof Response) return repo;
    const config = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
    const token = config ? await ctx.store.secretSetAt(ctx.tenant, forgeTokenName(config)) : null;
    return c.json({ config, token: token ? { set: true, ...token } : { set: false }, vault: Boolean(ctx.vault), connection: ctx.addedRepos?.get(repo.id)?.connection ?? null, forges: offeredForges(ctx) });
  });

  // A repository reached through the org's connection has no token of its own to replace; it is removed and connected again to change that.
  const throughConnection = (c: Context, repo: RepoRecord) => {
    const via = ctx.addedRepos?.get(repo.id)?.connection;
    return via ? c.json({ error: `${repo.name} reaches ${FORGES[via].label} through the organization's connection; remove it and connect it again to change where its requests go` }, 409) : null;
  };

  app.put("/api/repos/:id/forge", async (c) => {
    const repo = await forAdmin(c);
    if (repo instanceof Response) return repo;
    const via = throughConnection(c, repo);
    if (via) return via;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const config = cleanForgeConfig(repo.id, body);
      await saveForgeAccess(ctx.store, ctx.vault ?? null, ctx.tenant, config, body.token, c.get("user").email);
      await recordEvent(ctx, c.get("user"), "forge.set", { repoId: repo.id, subject: "forge", detail: `${FORGES[config.kind].label} project ${config.project} at ${config.apiUrl}, with a new token` });
      return c.json({ config, token: { set: true } });
    } catch (err) {
      return refused(c, err);
    }
  });

  app.delete("/api/repos/:id/forge", async (c) => {
    const repo = await forAdmin(c);
    if (repo instanceof Response) return repo;
    const via = throughConnection(c, repo);
    if (via) return via;
    const config = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
    if (config) await ctx.store.deleteSecret(ctx.tenant, forgeTokenName(config));
    await ctx.store.deleteForgeConfig(ctx.tenant, repo.id);
    if (config) await recordEvent(ctx, c.get("user"), "forge.removed", { repoId: repo.id, subject: "forge", detail: `removed the access to ${FORGES[config.kind].label} project ${config.project} and its token` });
    return c.json({ ok: true });
  });

  return app;
}
