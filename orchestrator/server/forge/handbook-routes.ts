import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { inConfiguration, mirrorDir, NOT_CONFIGURED, syncError } from "../app.js";
import { canEditTeam } from "../auth.js";
import type { OrchestratorEnv } from "../auth.js";
import { proposedBranch, teamNaming } from "../branches.js";
import { prepareBuilt } from "../changes.js";
import { errorAnswer, OrchestratorError } from "../errors.js";
import { commitMessagePrefix, commitSubject } from "../plugin.js";
import { inRequestTurn, propose } from "../propose.js";
import { route } from "../route-scopes.js";
import type { RepoRecord } from "../store.js";
import { buildHandbookChange, ownHandbook, teamHandbook } from "./handbook.js";
import { ownCliHere } from "./own-cli-here.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NOT_HERE = "your Claude Code is read only by an orchestrator on your own machine that you alone reach; add with /handbook:share from your terminal";

/**
 * The Team handbook's two needs of the forge: what the person's own Claude Code holds, and one
 * request that takes what they picked of it into a team repository. The request opens when they
 * press, after they confirm its message; merging it stays with a person.
 */
export function handbookRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  const editable = async (c: Context<OrchestratorEnv>, id: string): Promise<RepoRecord | Response> => {
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!canEditTeam(c.get("user"), repo.team)) return c.json({ error: `only an admin or an owner of ${repo.team} can change this repository` }, 403);
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    return repo;
  };
  const refused = (c: Context, err: unknown) => (err instanceof OrchestratorError ? errorAnswer(c, err) : c.json({ error: syncError(err) }, 502));

  route(app, "GET /api/handbook/own", async (c) => {
    if (!(await ownCliHere(ctx))) return c.json({ available: false, why: NOT_HERE });
    const id = c.req.query("repo");
    const repo = id ? await editable(c, id) : null;
    if (repo instanceof Response) return repo;
    const team = repo ? await teamHandbook(mirrorDir(ctx, repo.id), repo.head!) : null;
    return c.json({ available: true, ...ownHandbook(team) });
  });

  route(app, "POST /api/repos/:id/handbook/proposal", async (c) => {
    if (!(await ownCliHere(ctx))) return c.json({ error: NOT_HERE }, 409);
    const repo = await editable(c, c.req.param("id") ?? "");
    if (repo instanceof Response) return repo;
    try {
      const mirror = mirrorDir(ctx, repo.id);
      const naming = await teamNaming(mirror, repo.head!);
      const built = await buildHandbookChange(mirror, repo.head!, await c.req.json().catch(() => ({})));
      return c.json({ proposal: commitSubject(commitMessagePrefix(naming.commitPrefix), built.proposal), branch: proposedBranch(built.topic, naming) });
    } catch (err) {
      return refused(c, err);
    }
  });

  route(app, "POST /api/repos/:id/handbook", async (c) => {
    if (!(await ownCliHere(ctx))) return c.json({ error: NOT_HERE }, 409);
    const repo = await editable(c, c.req.param("id") ?? "");
    if (repo instanceof Response) return repo;
    const body = (await c.req.json().catch(() => ({}))) as { baseSha?: unknown; message?: unknown; branch?: unknown };
    // Built against what the person saw: a team repository that moved since would be proposed something they never looked at.
    if (body.baseSha !== repo.head) return c.json({ error: "the team repository changed since this page was opened; reload and pick again" }, 409);
    const user = c.get("user");
    try {
      const mirror = mirrorDir(ctx, repo.id);
      const head = repo.head!;
      const request = await inRequestTurn(ctx, repo.id, async () => {
        const built = await buildHandbookChange(mirror, head, body);
        return propose(ctx, repo, user, await prepareBuilt(mirror, head, built, body.message, user.name, await teamNaming(mirror, head), body.branch));
      });
      return c.json({ request: { number: request.number, url: request.url } });
    } catch (err) {
      return refused(c, err);
    }
  });

  return app;
}
