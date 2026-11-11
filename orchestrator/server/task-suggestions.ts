import type { OrchestratorContext } from "./app.js";
import type { Principal } from "./auth.js";
import type { FollowUpQuote, FollowUpRecord } from "./task-followups.js";
import { canStartOnTeam } from "./tasks/guards.js";
import type { TaskRecord } from "./tasks/types.js";

/**
 * A teammate's follow-up on a task someone else started: the task runs with its starter's whole
 * setup, their own MCP servers included, so another person's words never drive it. The words wait
 * as a suggestion in front of the starter, who continues the task with them or dismisses them.
 */
export type SuggestionStatus = "waiting" | "continued" | "dismissed" | "expired";

export interface SuggestionView {
  id: string;
  by: { name: string };
  text: string;
  quotes: FollowUpQuote[] | null;
  createdAt: string;
  status: SuggestionStatus;
  canAnswer: boolean;
}

/** Whether this person, signed in, started the task: only they answer a teammate's follow-up. */
export function startedTask(user: Principal, task: Pick<TaskRecord, "createdBy">): boolean {
  return !user.key && (task.createdBy === user.email || task.createdBy === user.id);
}

/** Where a suggestion stands: a proposed one waits while the task's request is open and lapses once it is merged or closed. */
export function suggestionStatus(followUp: Pick<FollowUpRecord, "status">, requestOpen: boolean): SuggestionStatus {
  if (followUp.status === "proposed") return requestOpen ? "waiting" : "expired";
  return followUp.status === "dismissed" ? "dismissed" : "continued";
}

/** Whether this person suggests a follow-up now: someone who starts tasks on the team but did not start this one, while its request is open and the task takes one. */
export function suggestsOn(user: Principal, task: Pick<TaskRecord, "createdBy" | "team">, offered: "steer" | "continue" | null, requestOpen: boolean): boolean {
  return !user.key && !startedTask(user, task) && canStartOnTeam(user, task.team) && offered !== null && requestOpen;
}

/** A person's name as a suggestion shows it, from the address or id a record keeps; never the address itself. */
export function nameReader(ctx: Pick<OrchestratorContext, "store" | "tenant">): (who: string) => Promise<string> {
  const names = new Map<string, Promise<string>>();
  const read = async (who: string) => {
    const person = (who.includes("@") ? await ctx.store.getUserByEmail(ctx.tenant, who) : null) ?? (await ctx.store.getUser(ctx.tenant, who));
    return person?.name || "A teammate";
  };
  return (who) => {
    if (!names.has(who)) names.set(who, read(who));
    return names.get(who)!;
  };
}

/**
 * The task views as this person reads them: the starter sees every suggestion and answers the
 * waiting ones, a teammate sees only their own with how it stands, and `suggests` opens their box.
 */
export async function withSuggestions<T extends Pick<TaskRecord, "id" | "createdBy" | "team" | "repoId" | "requestNumber"> & { followUp: "steer" | "continue" | null; request: { status: string } | null }>(
  ctx: Pick<OrchestratorContext, "store" | "tenant">,
  viewer: Principal,
  views: T[],
): Promise<(T & { suggestions: SuggestionView[]; suggests: boolean; startedBy: { name: string } })[]> {
  const rows = views.length ? await ctx.store.reviewerFollowUps(ctx.tenant, views.map((v) => v.id)) : [];
  const nameOf = nameReader(ctx);
  return Promise.all(
    views.map(async (view) => {
      const starter = startedTask(viewer, view);
      const shown = rows.filter((f) => f.taskId === view.id && (starter || f.createdBy === viewer.email));
      const candidate = !starter && view.followUp !== null && canStartOnTeam(viewer, view.team);
      // A view built without its request reads the request's status from the store, only when a suggestion depends on it.
      const open = view.request
        ? view.request.status === "open"
        : (shown.length || candidate) && view.requestNumber !== null && (await ctx.store.getRequest(ctx.tenant, view.repoId, view.requestNumber))?.status === "open";
      const suggestions = await Promise.all(
        shown.map(async (f) => {
          const status = suggestionStatus(f, !!open);
          return { id: f.id, by: { name: await nameOf(f.createdBy) }, text: f.text, quotes: f.quotes, createdAt: f.createdAt, status, canAnswer: starter && status === "waiting" };
        }),
      );
      return { ...view, suggestions, suggests: suggestsOn(viewer, view, view.followUp, !!open), startedBy: { name: await nameOf(view.createdBy) } };
    }),
  );
}
