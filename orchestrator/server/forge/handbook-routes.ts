import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { inConfiguration, mirrorDir, NOT_CONFIGURED, syncError } from "../app.js";
import { changesTeamHandbook } from "../handbook-team.js";
import type { OrchestratorEnv } from "../auth.js";
import { proposedBranch, teamNaming } from "../branches.js";
import { prepareBuilt } from "../changes.js";
import { errorAnswer, OrchestratorError } from "../errors.js";
import { commitMessagePrefix, commitSubject, pluginFreshness } from "../plugin.js";
import { inRequestTurn, propose } from "../propose.js";
import { route } from "../route-scopes.js";
import type { RepoRecord } from "../store.js";
import { buildHandbookChange, ownHandbook, teamHandbook } from "./handbook.js";
import { manifestVersion, skillChanges, skillPatch, versionDiff } from "./team-changes.js";
import { pluginCopies, pluginExtraChanges, pluginSkillPatch } from "./plugin-changes.js";
import { ownCliHere } from "./own-cli-here.js";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
const SKILL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const NOT_HERE = "your Claude Code is read only by an orchestrator on your own machine that you alone reach; add with /handbook:share from your terminal";

/**
 * The Team handbook's two needs of the forge: what the person's own Claude Code holds, and one
 * request that takes what they picked of it into a team repository. The request opens when they
 * press, after they confirm its message; merging it stays with a person.
 */
export function handbookRoutes(ctx: OrchestratorContext, claudeDir: string = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude")): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  const editable = async (c: Context<OrchestratorEnv>, id: string): Promise<RepoRecord | Response> => {
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!changesTeamHandbook(c.get("user"), repo.team)) return c.json({ error: `only an admin or an owner of ${repo.team} can change this repository` }, 403);
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

  // What changed in a team repository's handbook: each skill's last change, and what a person on the version `from` gets by updating.
  route(app, "GET /api/repos/:id/handbook/changes", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    const from = c.req.query("from");
    if (from !== undefined && !VERSION.test(from)) return c.json({ error: "from is a version, such as 1.4.0" }, 400);
    const mirror = mirrorDir(ctx, repo.id);
    const [team, changes, version, diff] = await Promise.all([teamHandbook(mirror, repo.head), skillChanges(mirror, repo.head), manifestVersion(mirror, repo.head), from ? versionDiff(mirror, repo.head, from) : null]);
    return c.json({ version, skills: team.skills.sort().map((name) => ({ name, lastChange: changes.get(name) ?? null })), diff });
  });

  // One skill's change from the version `from` to the team repository's current one, read before updating.
  route(app, "GET /api/repos/:id/handbook/changes/skills/:name", async (c) => {
    const id = c.req.param("id") ?? "";
    const repo = ID.test(id) ? await ctx.store.getRepo(ctx.tenant, id) : null;
    if (!repo) return c.json({ error: "unknown repository" }, 404);
    if (!inConfiguration(ctx, repo.id)) return c.json({ error: NOT_CONFIGURED }, 409);
    if (!repo.head) return c.json({ error: "this repository has not been read yet" }, 409);
    const from = c.req.query("from") ?? "";
    const name = c.req.param("name") ?? "";
    if (!VERSION.test(from) || !SKILL.test(name)) return c.json({ error: "a skill's name and the version from, such as 1.4.0" }, 400);
    const patch = await skillPatch(mirrorDir(ctx, repo.id), repo.head, from, name);
    return patch ? c.json(patch) : c.json({ error: `${name} did not change since ${from}, or ${from} is not in ${repo.name}'s history` }, 404);
  });

  const installedPlugin = (marketplace: string, plugin: string) => pluginCopies(claudeDir, marketplace, plugin);

  // What updating one of the person's plugins brings: the shared freshness reading of its skills, and its commands and MCP servers by name.
  route(app, "GET /api/handbook/plugins/:marketplace/:plugin/changes", async (c) => {
    if (!(await ownCliHere(ctx))) return c.json({ error: NOT_HERE }, 409);
    const dirs = installedPlugin(c.req.param("marketplace") ?? "", c.req.param("plugin") ?? "");
    const freshness = dirs ? pluginFreshness(dirs.installed, dirs.available) : null;
    if (!dirs || !freshness) return c.json({ error: "no such plugin is installed here with a marketplace copy to compare" }, 404);
    return c.json({ freshness, ...pluginExtraChanges(dirs.installed, dirs.available) });
  });

  route(app, "GET /api/handbook/plugins/:marketplace/:plugin/changes/skills/:name", async (c) => {
    if (!(await ownCliHere(ctx))) return c.json({ error: NOT_HERE }, 409);
    const name = c.req.param("name") ?? "";
    const dirs = SKILL.test(name) ? installedPlugin(c.req.param("marketplace") ?? "", c.req.param("plugin") ?? "") : null;
    if (!dirs) return c.json({ error: "no such plugin is installed here with a marketplace copy to compare" }, 404);
    const patch = await pluginSkillPatch(dirs.installed, dirs.available, name);
    return patch ? c.json(patch) : c.json({ error: `${name} is the same in the installed plugin and its marketplace copy` }, 404);
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
