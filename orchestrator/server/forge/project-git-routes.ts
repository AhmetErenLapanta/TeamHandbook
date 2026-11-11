import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { AccountError } from "../accounts.js";
import { publicRepo, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { localMode } from "../mode.js";
import { openProject } from "../project-routes.js";
import { projectFacts, projectFolder } from "../projects.js";
import { route } from "../route-scopes.js";
import { localRepoPath } from "./local.js";
import { cloneRepository, cloneTarget, commitChanges, commitPreview, initRepository, ProjectGitRefused } from "./project-git.js";

const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** How long a command's answer is kept for a retry whose first answer was lost. */
const REPLAY_MS = 10 * 60_000;
const REPLAY_MAX = 100;

/**
 * "Make this a Git repository", "Commit these changes" and a clone from GitHub or GitLab, for the
 * owner of a local orchestrator alone. Every call takes the project's folder through the one folder
 * rule again (projectFolder), so a folder turned into a link since it was opened leads nowhere.
 */
export function projectGitRoutes(ctx: OrchestratorContext, home: string = homedir()): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const answered = new Map<string, { at: number; status: number; body: unknown }>();
  const owner = (user: Principal) => !user.key && manages(user);

  /** The same answer for the same commandId of the same person, so a retry after a lost answer changes nothing twice. */
  const once = async (c: Context<OrchestratorEnv>, commandId: unknown, run: () => Promise<{ status: number; body: unknown }>) => {
    if (typeof commandId !== "string" || !COMMAND_ID.test(commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    const key = `${c.get("user").id}\0${commandId}`;
    const now = Date.now();
    for (const [k, v] of answered) if (now - v.at > REPLAY_MS) answered.delete(k);
    const kept = answered.get(key);
    const result = kept ?? (await run().catch((err: unknown) => {
      if (err instanceof ProjectGitRefused || err instanceof AccountError) return { status: err.status, body: { error: err.message, code: err.code } };
      throw err;
    }));
    if (!kept) {
      answered.set(key, { at: now, ...result });
      if (answered.size > REPLAY_MAX) answered.delete(answered.keys().next().value!);
    }
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  };

  /** The project's folder as the folder rule finds it now, or the answer that refuses it. */
  const folderOf = async (id: string) => {
    const repo = await ctx.store.getRepo(ctx.tenant, id);
    const path = repo && localRepoPath(repo.url);
    if (!repo || !path) return { refused: { status: 404, body: { error: "unknown project" } } };
    const at = await projectFolder(path, { home, dataDir: ctx.dataDir });
    if ("refused" in at) return { refused: { status: at.refused === "not-found" ? 404 : 400, body: { error: at.message, code: at.refused } } };
    // The project is the folder opened, by its real path then: one that leads elsewhere now, even within the home, is not it.
    if (at.real !== path) return { refused: { status: 409, body: { error: "this folder moved or became a link since it was opened; open it again", code: "moved" } } };
    return { repo, real: at.real };
  };

  const shown = async (repo: NonNullable<Awaited<ReturnType<typeof ctx.store.getRepo>>>, real: string) => ({ ...publicRepo(ctx, repo), facts: await projectFacts(real, { home, dataDir: ctx.dataDir }) });

  const gate = (c: Context<OrchestratorEnv>) => {
    if (!localMode()) return c.json({ error: "not found" }, 404);
    if (!owner(c.get("user"))) return c.json({ error: "only this machine's owner works on its folders" }, 403);
    return null;
  };

  route(app, "POST /api/projects/:id/git/init", async (c) => {
    const closed = gate(c);
    if (closed) return closed;
    const body = (await c.req.json().catch(() => ({}))) as { commandId?: unknown };
    return once(c, body.commandId, async () => {
      const at = await folderOf(c.req.param("id") ?? "");
      if ("refused" in at) return at.refused!;
      await initRepository(at.real);
      return { status: 200, body: { project: await shown(at.repo, at.real) } };
    });
  });

  route(app, "GET /api/projects/:id/git/commit", async (c) => {
    const closed = gate(c);
    if (closed) return closed;
    const at = await folderOf(c.req.param("id") ?? "");
    if ("refused" in at) return c.json(at.refused!.body as Record<string, unknown>, at.refused!.status as 404);
    try {
      const preview = await commitPreview(at.real);
      return c.json({ ...preview, message: preview.first ? `Start ${at.repo.name}` : `Update ${at.repo.name}` });
    } catch (err) {
      if (err instanceof ProjectGitRefused) return c.json({ error: err.message, code: err.code }, err.status);
      throw err;
    }
  });

  route(app, "POST /api/projects/:id/git/commit", async (c) => {
    const closed = gate(c);
    if (closed) return closed;
    const body = (await c.req.json().catch(() => ({}))) as { commandId?: unknown; message?: unknown; exclude?: unknown };
    return once(c, body.commandId, async () => {
      const at = await folderOf(c.req.param("id") ?? "");
      if ("refused" in at) return at.refused!;
      const exclude = Array.isArray(body.exclude) ? body.exclude.filter((p): p is string => typeof p === "string") : [];
      const { headSha } = await commitChanges(at.real, typeof body.message === "string" ? body.message : "", exclude);
      // The orchestrator's copy follows the commit, and one made a repository just now gets its first.
      await syncRepo(ctx, at.repo.id);
      const synced = (await ctx.store.getRepo(ctx.tenant, at.repo.id)) ?? at.repo;
      return { status: 200, body: { project: await shown(synced, at.real), headSha } };
    });
  });

  route(app, "POST /api/projects/clone", async (c) => {
    const closed = gate(c);
    if (closed) return closed;
    const body = (await c.req.json().catch(() => ({}))) as { commandId?: unknown; url?: unknown; into?: unknown };
    return once(c, body.commandId, async () => {
      const target = cloneTarget(typeof body.url === "string" ? body.url : "", home, typeof body.into === "string" && body.into.trim() ? body.into.trim() : undefined);
      // The nearest folder that exists on the way takes the folder rule as a listing does; the
      // folders the clone makes below it are neither hidden nor in ~/Library.
      let ancestor = dirname(target.into);
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      const near = await projectFolder(ancestor, { home, dataDir: ctx.dataDir }, true);
      if ("refused" in near) return { status: 403, body: { error: `the clone goes where no project is opened: ${near.message}`, code: near.refused } };
      const below = relative(ancestor, target.into).split(sep);
      if (below.some((part) => part.startsWith(".")) || (relative(home, ancestor) === "" && below[0]?.toLowerCase() === "library")) {
        return { status: 403, body: { error: "the clone goes where no project is opened: a hidden folder or ~/Library", code: "hidden" } };
      }
      await cloneRepository(target.url, target.into);
      // Opened by the one folder rule as any folder is; a clone the rule refuses is not left behind.
      try {
        const { project, facts, existing } = await openProject(ctx, c.get("user"), target.into);
        return { status: 200, body: { project: { ...publicRepo(ctx, project), facts }, existing } };
      } catch (err) {
        await rm(target.into, { recursive: true, force: true });
        throw err;
      }
    });
  });

  return app;
}
