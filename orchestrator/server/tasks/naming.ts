import { branchProblem } from "../branches.js";
import { commitMessagePrefix, commitSubject, detectSecret } from "../plugin.js";
import type { IssueLink } from "./issue.js";

/** A ticket key at the front of a name, the plugin's own rule: `PAY-12` in `PAY-12-fix-login`. */
const TICKET_KEY = /^[A-Z][A-Z0-9]+-\d+/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const EXAMPLE_MAX = 100;

export interface TeamNaming {
  commitPrefix?: string;
  branchExample?: string;
}

export function ticketKey(value: string | undefined): string | undefined {
  return value?.trim().match(TICKET_KEY)?.[0];
}

function slugOf(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
}

/** The part of the team's example branch before its last slash, when the example is one a branch can be built from. */
function examplePrefix(example: string | undefined): string | undefined {
  const value = example?.trim();
  if (!value || value.length > EXAMPLE_MAX || !BRANCH.test(value) || detectSecret(value)) return undefined;
  const slash = value.lastIndexOf("/");
  if (slash <= 0) return undefined;
  const prefix = value.slice(0, slash + 1);
  // git refuses a component that starts with a dot or ends in .lock, and refs/ or HEAD/ in
  // front makes a name that reads as another ref.
  const parts = prefix.split("/").slice(0, -1);
  if (parts.some((p) => p.startsWith(".") || p.endsWith(".lock")) || parts[0] === "refs" || parts[0] === "HEAD") return undefined;
  return prefix;
}

/** A task's branch, or the team's example when its rule starts a branch with a ticket and the task gives none. */
export type TaskBranch = { branch: string } | { needsTicket: string };

/**
 * The branch a task's request goes on, named the way the team names branches, in the
 * plugin's own order (`proposeBranch`): the issue the task works on first, being the most
 * specific ticket, then a ticket key in the team's commit prefix, then the shape of the
 * example branch the team recorded. An example that starts with a ticket key shows where a
 * ticket goes, not which one: an issue fills it, and without one there is no name the team's
 * rule accepts - a forge that holds branches to it refuses `task/<id>` - so the task does not
 * run. The task id keeps every name unique; with no rule at all the branch is `task/<id>`.
 */
export function taskBranch(id: string, title: string, team: TeamNaming | null, issue: Pick<IssueLink, "key" | "branchToken"> | null = null): TaskBranch {
  const words = issue?.key ? title.split(issue.key).join(" ") : title;
  // The id's last characters are its random ones: an id's first ones are its time, which tasks
  // started together share.
  const short = `${slugOf(words)}-${id.slice(-6)}`;
  const prefix = examplePrefix(team?.branchExample);
  const key = ticketKey(team?.commitPrefix);
  if (!issue?.branchToken && !key && ticketKey(team?.branchExample)) return { needsTicket: team!.branchExample!.trim() };
  const name = issue?.branchToken
    ? `${prefix ?? ""}${issue.branchToken}-${short}`
    : key
      ? `${key}-${short}`
      : prefix
        ? `${prefix}${short}`
        : null;
  return { branch: name && BRANCH.test(name) && !name.includes("..") && !name.includes("//") ? name : `task/${id}` };
}

/** Why a task cannot start: the team's branch rule wants a ticket the task does not name. */
export function ticketNeeded(repoName: string, example: string): string {
  return `${repoName} names branches with a ticket first (its example is ${example}), and this task names none: start it with an issue link whose key fills it`;
}

/**
 * The branch as named when it passes the screens every orchestrator branch passes - no trace of a
 * machine, no credential, a name git accepts - else `task/<id>` and why, without repeating the
 * refused name: the branch list is read by the whole team.
 */
export async function screenedBranch(named: string, id: string): Promise<{ branch: string; problem: string | null }> {
  const problem = await branchProblem(named);
  return problem ? { branch: `task/${id}`, problem } : { branch: named, problem: null };
}

/**
 * The request's title and commit subject: the team's commit prefix in front, as for every
 * orchestrator change, and the issue's key in it. A prefix that is itself a ticket key gives way to
 * the issue's, so a subject never names two tickets; and a subject that already starts with a
 * key carrying the prefix keeps it there, so `PAY` and `PAY-990` make `PAY-990 ...`, never
 * `PAY PAY-990 ...`. A title naming the key further in still gets the prefix in front.
 */
export function taskSubject(title: string, team: TeamNaming | null, issueKey: string | null = null): string {
  if (!issueKey) return commitSubject(commitMessagePrefix(team?.commitPrefix), title);
  const keyed = title.includes(issueKey) ? title : `${issueKey} ${title}`;
  const prefix = team?.commitPrefix?.trim() ?? "";
  const carried = prefix !== "" && keyed.toUpperCase().startsWith(`${prefix.toUpperCase()}-`);
  return ticketKey(prefix) || carried ? keyed : commitSubject(commitMessagePrefix(prefix), keyed);
}
