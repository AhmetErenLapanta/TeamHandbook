import { randomBytes } from "node:crypto";
import { gitAsyncMaybe } from "./git.js";
import { branchExampleProblem, branchTrace, commitPrefixProblem, DEFAULT_BRANCH_PREFIX, proposeBranch, TEAM_PREFIX_FILE } from "./plugin.js";

/** Every branch the orchestrator names for a change of its own when the team records no naming; a start clears one that no request names. */
export const ORCHESTRATOR_BRANCH_PREFIX = `${DEFAULT_BRANCH_PREFIX}orchestrator-`;

/** Where a proposed name leaves the ticket for the person to fill in, as the plugin's share does. */
export const TICKET_PLACEHOLDER = "<TICKET>";

const BRANCH_MAX = 200;

/** How the team names commits and branches, from its team file. */
export interface TeamNaming {
  commitPrefix?: string;
  branchExample?: string;
}

/**
 * The commit prefix a team file records, read as the plugin's join reads it: trimmed, and
 * left unused with the reason when the plugin's rule refuses it. Anyone who can push to the
 * team repository writes this value, and it reaches commit titles, request titles and the
 * CI job the scaffold refresh writes.
 */
export function recordedCommitPrefix(value: unknown): { prefix?: string; problem?: string } {
  if (typeof value !== "string") return {};
  const prefix = value.trim();
  const problem = commitPrefixProblem(prefix);
  return problem ? { problem } : { prefix };
}

/**
 * The team's naming as its file records it at `head`. A prefix or an example the plugin would
 * refuse to read - a trace of a machine, a credential, a control character, a character a
 * shell acts on - is left out, as the plugin leaves it out.
 */
export async function teamNaming(mirror: string, head: string): Promise<TeamNaming> {
  const text = await gitAsyncMaybe(["show", `${head}:${TEAM_PREFIX_FILE}`], mirror);
  let json: { commitPrefix?: unknown; branchExample?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    return {};
  }
  const example = typeof json.branchExample === "string" ? json.branchExample.trim() : "";
  const { prefix } = recordedCommitPrefix(json.commitPrefix);
  return {
    ...(prefix !== undefined ? { commitPrefix: prefix } : {}),
    ...(example && !branchExampleProblem(example) ? { branchExample: example } : {}),
  };
}

/**
 * The branch the orchestrator proposes for a change on `topic`, named the way the plugin's share
 * names one: a ticket key in the team's commit prefix first, then the shape of the team's
 * example branch, and the orchestrator's own prefix only when the team records neither. An
 * example that starts with a ticket key gives a name with the ticket left to fill in. A short
 * random part keeps two requests on one topic apart.
 */
export function proposedBranch(topic: string, naming: TeamNaming): string {
  const slug = `${topic}-${randomBytes(3).toString("hex")}`;
  const proposal = proposeBranch(slug, { repoUrl: "", marketplaceName: "", ...(naming.commitPrefix !== undefined ? { commitPrefix: naming.commitPrefix } : {}) }, naming.branchExample, {}, new Set());
  if (!("branch" in proposal)) return proposal.template.replace("<TICKET>", TICKET_PLACEHOLDER);
  return proposal.branch === slug ? `${ORCHESTRATOR_BRANCH_PREFIX}${slug}` : proposal.branch;
}

/**
 * Why `name` cannot be the branch of a request the orchestrator opens, or null. The branch list is
 * read by every teammate, so it passes the plugin's screens for a machine's trace and a
 * credential; git then decides whether it is a branch name at all.
 */
export async function branchProblem(name: string): Promise<string | null> {
  if (!name.trim() || name !== name.trim()) return "the branch name is empty or starts or ends with a space";
  if (name.includes(TICKET_PLACEHOLDER)) return `put the ticket in place of ${TICKET_PLACEHOLDER} in the branch name`;
  if (name.length > BRANCH_MAX) return `the branch name is longer than ${BRANCH_MAX} characters`;
  if (/\p{C}/u.test(name)) return "the branch name carries a control character";
  const trace = branchTrace(name);
  if (trace) return `that branch name cannot be used: ${trace}`;
  if (name.startsWith("-") || name.includes("@{") || (await gitAsyncMaybe(["check-ref-format", "--branch", name], process.cwd())) === null) {
    return "git does not accept that as a branch name";
  }
  return null;
}
