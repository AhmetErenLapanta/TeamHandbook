import { Hono } from "hono";
import { FORGES } from "../../shared/forge-def.js";
import { mirrorDir } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { seesRequest } from "./request-access.js";
import { repoForgeAccess } from "../propose.js";
import { fetchMedia, MediaRefused } from "./media.js";
import { CAPABILITIES, readRequestWatch, watchFingerprint } from "./read-model.js";
import type { Mergeability, RequestDetail, RequestStatusRead } from "./read-model.js";
import { DRIVERS } from "./registry.js";
import { gitAsyncMaybe } from "../git.js";
import { localRepoPath } from "./local.js";
import { readRequestChanges, readRequestFile } from "./request-diff.js";
import { readRequestTemplate } from "./templates.js";
import { repoBranches } from "./branches.js";
import { readOnForge } from "./pushed.js";
import { shownProjects } from "../projects.js";
import { route } from "../route-scopes.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface Source {
  dir: string;
  repoHead: string;
  /** The branch the request goes into, where the source names it. */
  target?: string;
  refs: string[];
}

/**
 * Where a request's commits are read. One on the local forge of a repository read by path is read
 * in the person's own repository, its branch against the branch it goes into (that repository's
 * HEAD unless its task started from another), as fresh as their runner left it; any other from the
 * orchestrator's mirror: the orchestrator's own by its branch, a teammate's by the forge's ref for
 * its number. Null for a request this repository has none of.
 */
async function requestSource(ctx: OrchestratorContext, user: Principal, id: string, number: number): Promise<Source | null> {
  const repo = ID.test(id) && Number.isInteger(number) && number > 0 ? await ctx.store.getRepo(ctx.tenant, id) : null;
  if (!repo) return null;
  const request = await ctx.store.getRequest(ctx.tenant, id, number);
  if (!(await seesRequest(ctx, user, repo, number, request))) return null;
  const kind = request?.provider ?? (await ctx.store.getForgeConfig(ctx.tenant, id))?.kind;
  if (!kind || (kind === "local" && !request)) return null;
  const own = localRepoPath(repo.url);
  const chosen = request?.targetBranch;
  if (kind === "local" && own) {
    const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `${chosen ? `refs/heads/${chosen}` : "HEAD"}^{commit}`], own))?.trim();
    const target = chosen ?? (await gitAsyncMaybe(["symbolic-ref", "--short", "HEAD"], own))?.trim();
    return head ? { dir: own, repoHead: head, ...(target ? { target } : {}), refs: [`refs/heads/${request!.branch}`] } : null;
  }
  if (!repo.head) return null;
  const dir = mirrorDir(ctx, id);
  const refs = kind === "local" ? [`refs/heads/${request!.branch}`] : [FORGES[kind].requestRef(number), ...(request ? [`refs/heads/${request.branch}`] : [])];
  const targetHead = chosen ? (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${chosen}^{commit}`], dir))?.trim() : null;
  return { dir, repoHead: targetHead || repo.head, refs };
}

/**
 * What the forge says of a request the orchestrator opened, and the repository's request template.
 * Anyone signed in reads them, as they read the request itself; the forge is read with the
 * orchestrator's own access, so a member sees no more than the request's page on the forge shows.
 */
export function forgeReadRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();



  // Where a request stands: its checks, whether it merges, its review and what was said on it.
  route(app, "GET /api/repos/:id/requests/:number/status", async (c) => {
    const id = c.req.param("id") ?? "";
    const number = Number(c.req.param("number"));
    const repo = ID.test(id) && Number.isInteger(number) && number > 0 ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown request" }, 404);
    const request = await ctx.store.getRequest(ctx.tenant, id, number);
    if (!(await seesRequest(ctx, c.get("user"), repo, number, request))) return c.json({ error: "unknown request" }, 404);
    if (request?.provider === "local") {
      const source = await requestSource(ctx, c.get("user"), id, number);
      const head = source && (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `${source.refs[0]}^{commit}`], source.dir))?.trim();
      if (!source || !head) return c.json({ error: "the request's branch is no longer in the repository" }, 409);
      // A clean merge is what git computes from objects alone, as the local forge's own merge does.
      const merges = request.status !== "open" ? null : (await gitAsyncMaybe(["merge-tree", "--write-tree", source.repoHead, head], source.dir)) !== null;
      const mergeability: Mergeability = merges === null ? { state: "not-open", reason: null } : merges ? { state: "mergeable", reason: null } : { state: "conflict", reason: "the branch conflicts with its base" };
      const detail: RequestDetail = { number, status: request.status, headSha: head, ...(source.target ? { target: source.target } : {}), mergeability, review: { decision: "none", approvedBy: [] }, checks: { state: "no-ci", checks: [] } };
      const onForge = await readOnForge(ctx, repo, request, c.get("user"));
      const status: RequestStatusRead = { source: "local", capabilities: null, detail, comments: [], fingerprint: watchFingerprint(detail, []), ...(onForge ? { onForge } : {}) };
      return c.json({ status });
    }
    const config = await ctx.store.getForgeConfig(ctx.tenant, id);
    if (!config) return c.json({ error: "unknown request" }, 404);
    const watch = await readRequestWatch(ctx, repo, number);
    // A teammate's request is read only while it is open, as the list of what waits shows it.
    if (!request && watch.detail.status !== "open") return c.json({ error: "unknown request" }, 404);
    const status: RequestStatusRead = { source: "forge", capabilities: CAPABILITIES[config.kind], ...watch };
    return c.json({ status });
  });

  // The files a request changes, with no patch: the list a screen shows first.
  route(app, "GET /api/repos/:id/requests/:number/changes", async (c) => {
    const source = await requestSource(ctx, c.get("user"), c.req.param("id") ?? "", Number(c.req.param("number")));
    if (!source) return c.json({ error: "unknown request" }, 404);
    const changes = await readRequestChanges(source.dir, source.repoHead, source.refs);
    return typeof changes === "string" ? c.json({ error: changes }, 409) : c.json({ changes });
  });

  // One changed file's patch, when the screen opens it.
  route(app, "GET /api/repos/:id/requests/:number/changes/:path{.+}", async (c) => {
    const source = await requestSource(ctx, c.get("user"), c.req.param("id") ?? "", Number(c.req.param("number")));
    if (!source) return c.json({ error: "unknown request" }, 404);
    const file = await readRequestFile(source.dir, source.repoHead, source.refs, c.req.param("path") ?? "");
    if (file === null) return c.json({ error: "this request does not change that file" }, 404);
    return typeof file === "string" ? c.json({ error: file }, 409) : c.json({ file });
  });

  // An image a request's description names, for a browser that holds no sign-in to the forge. It is
  // read as the request it shows in is; asked for without one, by the team's owners and the
  // organization's owners and admins alone.
  route(app, "GET /api/repos/:id/media", async (c) => {
    const id = c.req.param("id") ?? "";
    const src = c.req.query("src") ?? "";
    const number = Number(c.req.query("request"));
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    const config = repo ? await ctx.store.getForgeConfig(ctx.tenant, id) : null;
    const user = c.get("user");
    const reads = repo && (Number.isInteger(number) && number > 0 ? await seesRequest(ctx, user, repo, number, await ctx.store.getRequest(ctx.tenant, id, number)) : canEditTeam(user, repo.team));
    if (!repo || !config || !reads) return c.json({ error: "unknown repository" }, 404);
    const start = DRIVERS[config.kind].media(config, new URL(repo.url).origin, src);
    if (!start) throw new MediaRefused(`that is not an image attached on ${FORGES[config.kind].label} to ${repo.name}`, 422);
    const access = await repoForgeAccess(ctx, repo);
    if (!access) throw new MediaRefused(`the orchestrator has no access to ${repo.name}'s forge`, 409);
    const media = await fetchMedia(ctx, start, access.headers);
    return new Response(media.body, {
      headers: { "content-type": media.type, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" },
    });
  });

  // The branches a task can start from, for the start form; a folder on another person's machine is not shown, as in the project list.
  route(app, "GET /api/repos/:id/branches", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? (await shownProjects(ctx, c.get("user"), await ctx.store.listRepos(ctx.tenant))).find((r) => r.id === id) : undefined;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    const read = await repoBranches(ctx, repo);
    if (!read) return c.json({ error: `${repo.name}'s branches are not read here yet: a folder on a machine is read by that machine, and a repository is read at its first sync`, code: "no-branches" }, 409);
    return c.json(read);
  });

  route(app, "GET /api/repos/:id/request-template", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    const config = await ctx.store.getForgeConfig(ctx.tenant, repo.id);
    return c.json({ template: await readRequestTemplate(ctx, repo, config?.kind ?? null) });
  });

  return app;
}
