import type { OrchestratorContext } from "../app.js";
import { manages } from "../auth.js";
import type { Principal } from "../auth.js";
import { seesTeamTasks } from "../tasks/guards.js";
import type { IssueLink } from "../tasks/issue.js";

/** Which team sees each board read with the organization's token, by board id; set by an owner or an admin. */
export const TEAMS_KEY = "work.boards.teams";
/** The project each mapped board holds, kept with the mapping, so an issue is matched to a board without asking the tracker. */
export const PROJECTS_KEY = "work.boards.projects";

async function readMap(ctx: Pick<OrchestratorContext, "store" | "tenant">, key: string): Promise<Record<string, string>> {
  const raw = await ctx.store.getSetting(ctx.tenant, key);
  try {
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const boardTeams = (ctx: Pick<OrchestratorContext, "store" | "tenant">) => readMap(ctx, TEAMS_KEY);
export const boardProjects = (ctx: Pick<OrchestratorContext, "store" | "tenant">) => readMap(ctx, PROJECTS_KEY);

/** The project an issue belongs to as a board names it: a Jira key's or a Linear team's prefix, a GitLab or GitHub project's path. */
export function issueProject(issue: Pick<IssueLink, "kind" | "key">): string | null {
  if (!issue.key) return null;
  if (issue.kind === "jira" || issue.kind === "linear") return issue.key.slice(0, issue.key.lastIndexOf("-"));
  return issue.key.slice(0, issue.key.lastIndexOf("#"));
}

/**
 * Whether the organization's tracker token reads this issue for this person: the token sees
 * more than any one person should, so a person gets an issue's text through it only when its
 * project is on a board an owner or an admin mapped to a team whose work they read. Owners and admins
 * read every issue; with no board mapped nobody else reads through the token, and a person's
 * own MCP server still reads what their own sign-in sees.
 */
export async function trackerReadsFor(ctx: Pick<OrchestratorContext, "store" | "tenant">, user: Principal, issue: Pick<IssueLink, "kind" | "key">): Promise<boolean> {
  if (manages(user)) return true;
  const teams = await boardTeams(ctx);
  const project = issueProject(issue);
  if (!project) return false;
  const projects = await boardProjects(ctx);
  return Object.entries(teams).some(([id, team]) => seesTeamTasks(user, team) && projects[id] === project);
}
