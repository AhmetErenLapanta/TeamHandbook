import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import type { OrchestratorEnv } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { auditChange } from "../integrations/audit.js";
import { WorkCache } from "./cache.js";
import { manages } from "../auth.js";
import { addAutomation, automationsOn, changeAutomation, dismissDraft, draftsFor, readAutomations, removeAutomation, startDraft, turnAutomations } from "./automations.js";
import { moveByHand } from "./move.js";
import { readMoves, saveMoves } from "./moves.js";
import { SourceFailed } from "./provider.js";
import { describeSources, listBoards, listColumns, listItems, listSprints, readBoardTeams, saveBoardTeams, saveLayout, WorkNotFound } from "./service.js";
import type { WorkDeps } from "./service.js";
import { startersFor, StartersRefused } from "./starters.js";
import type { WorkStarters } from "../../shared/work.js";

/** The trackers' answers every org of this process shares; each key starts with its tenant. */
export const WORK_CACHE = new WorkCache();

/** What the routes, the task runner's hook and the merge hook read trackers with. */
export const WORK_DEPS: WorkDeps = { cache: WORK_CACHE, send: fetch };

export function workRoutes(ctx: OrchestratorContext, deps: WorkDeps = WORK_DEPS): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const answer = async (c: Context<OrchestratorEnv>, work: () => Promise<unknown>) => {
    try {
      return c.json(await work());
    } catch (err) {
      if (err instanceof WorkNotFound) return c.json({ error: err.message }, 404);
      if (err instanceof ChangeRefused) return c.json({ error: err.message }, err.message.startsWith("only an owner") ? 403 : 400);
      if (err instanceof SourceFailed) return c.json({ error: err.message, source: c.req.query("source") ?? null }, 502);
      throw err;
    }
  };
  const fresh = (c: Context<OrchestratorEnv>) => c.req.query("fresh") === "1";
  const given = (c: Context<OrchestratorEnv>, name: string) => {
    const value = c.req.query(name);
    if (!value) throw new ChangeRefused(`give ${name}`);
    return value;
  };

  app.get("/api/work/sources", (c) => answer(c, () => describeSources(ctx, c.get("user"), deps)));
  app.get("/api/work/boards", (c) => answer(c, () => listBoards(ctx, c.get("user"), given(c, "source"), deps, fresh(c))));
  app.get("/api/work/boards/teams", (c) => answer(c, () => readBoardTeams(ctx, c.get("user"), deps)));
  app.put("/api/work/boards/teams", (c) =>
    answer(c, async () => {
      const user = c.get("user");
      const { saved, changed } = await saveBoardTeams(ctx, user, await c.req.json().catch(() => null), deps);
      if (changed.length) await auditChange(ctx, user, "work.boards.teams", { subject: "work:tracker", detail: `mapped the organization's boards to teams: ${changed.join(", ")}` });
      return saved;
    }),
  );
  app.get("/api/work/moves", (c) => answer(c, () => readMoves(ctx, c.get("user"), given(c, "board"), deps)));
  app.put("/api/work/moves", (c) =>
    answer(c, async () => {
      const user = c.get("user");
      const { saved, detail } = await saveMoves(ctx, user, given(c, "board"), await c.req.json().catch(() => null), deps);
      await auditChange(ctx, user, "work.moves", { subject: `work:${given(c, "board")}`, detail });
      return saved;
    }),
  );
  app.post("/api/work/items/:key/transition", (c) => answer(c, async () => moveByHand(ctx, c.get("user"), c.req.param("key"), await c.req.json().catch(() => null), deps)));
  app.get("/api/work/automations", (c) =>
    answer(c, async () => {
      if (!manages(c.get("user"))) throw new ChangeRefused("only an owner or an admin sets up automations");
      return { enabled: await automationsOn(ctx), automations: await readAutomations(ctx) };
    }),
  );
  app.put("/api/work/automations", (c) =>
    answer(c, async () => {
      const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") throw new ChangeRefused("send enabled");
      await turnAutomations(ctx, c.get("user"), body.enabled);
      return { enabled: body.enabled };
    }),
  );
  app.post("/api/work/automations", (c) => answer(c, async () => ({ automation: await addAutomation(ctx, c.get("user"), await c.req.json().catch(() => null), deps) })));
  app.put("/api/work/automations/:id", (c) => answer(c, async () => ({ automation: await changeAutomation(ctx, c.get("user"), c.req.param("id"), await c.req.json().catch(() => null), deps) })));
  app.delete("/api/work/automations/:id", (c) =>
    answer(c, async () => {
      await removeAutomation(ctx, c.get("user"), c.req.param("id"));
      return { ok: true };
    }),
  );
  app.get("/api/work/automations/:id/deliveries", (c) =>
    answer(c, async () => {
      if (!manages(c.get("user"))) throw new ChangeRefused("only an owner or an admin sets up automations");
      const { events } = await ctx.store.eventPage(ctx.tenant, { subject: `automation:${c.req.param("id")}` }, null, 50);
      return { deliveries: events.filter((e) => e.kind === "automation.delivery").map((e) => ({ at: e.at, detail: e.detail })) };
    }),
  );
  app.get("/api/work/drafts", (c) => answer(c, async () => ({ drafts: await draftsFor(ctx, c.get("user")) })));
  app.post("/api/work/drafts/:id/start", async (c) => {
    const started = await startDraft(ctx, c.get("user"), c.req.param("id"));
    return "task" in started ? c.json(started) : c.json({ error: started.error }, started.status);
  });
  app.delete("/api/work/drafts/:id", async (c) => ((await dismissDraft(ctx, c.get("user"), c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "no such draft" }, 404)));
  app.get("/api/work/boards/:id/columns", (c) => answer(c, () => listColumns(ctx, c.get("user"), c.req.param("id"), deps)));
  app.get("/api/work/sprints", (c) => answer(c, () => listSprints(ctx, c.get("user"), given(c, "board"), deps, fresh(c))));
  app.put("/api/work/boards/:id/columns", (c) => answer(c, async () => saveLayout(ctx, c.get("user"), c.req.param("id"), await c.req.json().catch(() => null), deps)));

  app.get("/api/work/starters", async (c) => {
    try {
      return c.json<WorkStarters>({ starters: await startersFor(ctx, c.get("user"), c.req.query("project") ?? "") });
    } catch (err) {
      if (err instanceof StartersRefused) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  app.get("/api/work/items", (c) =>
    answer(c, () => {
      const sprint = c.req.query("sprint");
      const backlog = c.req.query("backlog");
      const board = c.req.query("board");
      if ([sprint, backlog, board].filter(Boolean).length !== 1) throw new ChangeRefused("give sprint, backlog or board");
      return listItems(ctx, c.get("user"), sprint ? { sprint } : backlog ? { backlog } : { board: board! }, deps, fresh(c));
    }),
  );
  return app;
}
