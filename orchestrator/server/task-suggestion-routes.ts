import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "./app.js";
import type { OrchestratorEnv } from "./auth.js";
import { recordEvent } from "./events.js";
import { isId, newId, OLDER_IDS } from "./ids.js";
import { route } from "./route-scopes.js";
import { nameReader, startedTask, suggestionStatus } from "./task-suggestions.js";
import { canStartOnTeam, readsTask } from "./tasks/guards.js";
import { COMMAND_ID, goOn, goOnRefusal, maskedFollowUp, MESSAGE_MAX, NO_FOLLOW_UP, offeredFollowUp, readQuotes } from "./tasks/routes.js";
import { START_REFUSED } from "./tasks/runner.js";
import type { TaskRunner } from "./tasks/runner.js";
import type { TaskRecord } from "./tasks/types.js";

const NOT_YOURS = { error: "unknown task" };
const isTaskId = (id: string) => isId("tsk", id, OLDER_IDS.task);

/**
 * A teammate reviewing a task's request suggests a follow-up, and the task's starter continues the
 * task with it or dismisses it. The suggestion is kept proposed and reaches no agent: Continue is the
 * starter's own follow-up, held to the rights and policies theirs is, and the log names both people.
 */
export function taskSuggestionRoutes(ctx: OrchestratorContext, runner: TaskRunner): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const taskOf = async (c: Context<OrchestratorEnv>) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    return task && readsTask(c.get("user"), task) ? task : null;
  };
  const requestOf = (task: TaskRecord) => (task.requestNumber !== null ? ctx.store.getRequest(ctx.tenant, task.repoId, task.requestNumber) : Promise.resolve(null));

  route(app, "POST /api/tasks/:id/suggestions", async (c) => {
    const user = c.get("user");
    const task = await taskOf(c);
    if (!task) return c.json(NOT_YOURS, 404);
    // A teammate's words wait in front of a person, so they come from a person signed in, never from a key's automation.
    if (user.key) return c.json({ error: "an API key cannot do this; it takes a person signed in to the orchestrator" }, 403);
    if (startedTask(user, task)) return c.json({ error: "you started this task; send its agent a follow-up yourself", code: "use-messages" }, 409);
    const repo = await ctx.store.getRepo(ctx.tenant, task.repoId);
    if (!repo || !canStartOnTeam(user, repo.team)) return c.json({ error: START_REFUSED }, 403);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; quotes?: unknown; commandId?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MESSAGE_MAX) return c.json({ error: `a follow-up is 1 to ${MESSAGE_MAX} characters`, code: "message-too-long" }, 400);
    const commandId = typeof body?.commandId === "string" ? body.commandId : "";
    if (!COMMAND_ID.test(commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    const quotes = readQuotes(body?.quotes);
    if (quotes && "error" in quotes) return c.json({ error: quotes.error, code: "quote-outside-request" }, 400);
    // A suggestion is about a request someone reviews: none is kept once it is merged or closed.
    const request = await requestOf(task);
    if (request?.status !== "open" || !offeredFollowUp(runner, task, request)) return c.json({ error: NO_FOLLOW_UP, code: "follow-up-not-offered" }, 409);
    const masked = maskedFollowUp(text, quotes);
    let kept;
    try {
      kept = await ctx.store.addFollowUp({ tenant: ctx.tenant, id: newId("fup"), taskId: task.id, source: "reviewer", key: `reviewer:${user.id}:${commandId}`, text: masked.text, quotes: masked.quotes, createdAt: new Date().toISOString(), createdBy: user.email });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!kept.created && (kept.followUp.text !== masked.text || JSON.stringify(kept.followUp.quotes) !== JSON.stringify(masked.quotes))) {
      return c.json({ error: "that commandId already sent another follow-up", code: "command-reused" }, 409);
    }
    if (kept.created) {
      await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} suggested a follow-up on request #${task.requestNumber}; it waits for the task's starter.`]);
      await recordEvent(ctx, user, "task.followup_suggested", { repoId: task.repoId, subject: `task:${task.id}`, detail: `suggested a follow-up of ${masked.text.length} characters${masked.quotes ? ` with ${masked.quotes.length} quote(s)` : ""}` });
    }
    return c.json({ suggestion: { id: kept.followUp.id, status: suggestionStatus(kept.followUp, true), createdAt: kept.followUp.createdAt } }, kept.created ? 202 : 200);
  });

  const answer = async (c: Context<OrchestratorEnv>, to: "pending" | "dismissed") => {
    const user = c.get("user");
    const task = await taskOf(c);
    if (!task) return c.json(NOT_YOURS, 404);
    if (!startedTask(user, task)) return c.json({ error: "only whoever started the task answers a teammate's follow-up" }, 403);
    const suggestion = (await ctx.store.reviewerFollowUps(ctx.tenant, [task.id])).find((f) => f.id === c.req.param("sid"));
    if (!suggestion) return c.json({ error: "no such follow-up on this task" }, 404);
    const request = await requestOf(task);
    const done = to === "pending" ? "continued" : "dismissed";
    const status = suggestionStatus(suggestion, request?.status === "open");
    // A second click answers nothing more and says how it stands.
    if (status === done) return c.json({ suggestion: { id: suggestion.id, status } });
    if (status !== "waiting") return c.json({ error: `that follow-up is ${status}`, code: `suggestion-${status}` }, 409);
    const reviewer = await nameReader(ctx)(suggestion.createdBy);
    if (to === "pending") {
      const offered = offeredFollowUp(runner, task, request);
      if (!offered) return c.json({ error: NO_FOLLOW_UP, code: "follow-up-not-offered" }, 409);
      if (offered === "continue") {
        const refused = await goOnRefusal(ctx, user, task);
        if (refused) return c.json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}) }, refused.status);
      }
      if (!(await ctx.store.answerFollowUp(ctx.tenant, task.id, suggestion.id, "pending"))) return c.json({ error: "that follow-up was answered meanwhile", code: "suggestion-answered" }, 409);
      const line = `${user.name} continued with ${reviewer}'s follow-up on request #${task.requestNumber}.`;
      if (offered === "continue" && task.status !== "queued") await goOn(ctx, task, line);
      else await ctx.store.appendTaskLog(ctx.tenant, task.id, [line]);
      await recordEvent(ctx, user, "task.followup", { repoId: task.repoId, subject: `task:${task.id}`, detail: `continued with a follow-up ${suggestion.createdBy} suggested, of ${suggestion.text.length} characters` });
    } else {
      if (!(await ctx.store.answerFollowUp(ctx.tenant, task.id, suggestion.id, "dismissed"))) return c.json({ error: "that follow-up was answered meanwhile", code: "suggestion-answered" }, 409);
      await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} dismissed ${reviewer}'s follow-up.`]);
      await recordEvent(ctx, user, "task.followup_dismissed", { repoId: task.repoId, subject: `task:${task.id}`, detail: `dismissed a follow-up ${suggestion.createdBy} suggested` });
    }
    return c.json({ suggestion: { id: suggestion.id, status: done } });
  };

  route(app, "POST /api/tasks/:id/suggestions/:sid/continue", (c) => answer(c, "pending"));
  route(app, "POST /api/tasks/:id/suggestions/:sid/dismiss", (c) => answer(c, "dismissed"));

  return app;
}
