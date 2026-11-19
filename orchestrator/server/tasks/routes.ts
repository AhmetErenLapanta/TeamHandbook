import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isId, newId, OLDER_IDS } from "../ids.js";
import { followUpAttachments, startAttachments } from "../attachments.js";
import { lastLimits } from "./agent-limits.js";
import { branchHead, filesAsAt, placeOfTurn } from "./turns.js";
import { noteChecksFound } from "./verify-routes.js";
import { newRepeat, readRepeat, REPEATS_MAX, runTimes } from "./repeats.js";
import { offChanges, readOff, setupOf } from "./handbook-use.js";
import { handbookOff } from "../handbook-defaults.js";
import { localRepoPath } from "../forge/local.js";
import { repoBranches } from "../forge/branches.js";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { inConfiguration, maskUrl, memberUrl, mirrorDir, NOT_CONFIGURED, NOT_READ_YET, syncRepo } from "../app.js";
import { dropFromRequest, remoteForge, updateRequestBranch } from "../forge/pushed.js";
import { recheckRequest } from "./pushed-check.js";
import { taskMask } from "./task-text.js";
import { canEditTeam, manages, secureOrchestrator, stillAuthorized } from "../auth.js";
import type { OrchestratorEnv, Principal } from "../auth.js";
import { ChangeRefused } from "../changes.js";
import { fence } from "./changes.js";
import type { RequestRecord } from "../forge/types.js";
import type { RepoRecord } from "../store.js";
import { machineFolderOf } from "../projects.js";
import { undoOnMachine } from "../machine-changes.js";
import { toolChoiceOf } from "../task-tools.js";
import { nextTaskWrite } from "./log-bus.js";
import { eachAtMost, gitAsyncMaybe, oneAtATime } from "../git.js";
import { REFRESH_COMMIT_TITLE } from "../plugin.js";
import { SKILL_SLUG } from "../skill-rules.js";
import { issuePreview, issueReach, reachText } from "../integrations/issue-preview.js";
import { issueAddress, readTracker } from "../integrations/tracker.js";
import { issueGone, readIssue } from "../integrations/issue-read.js";
import { tooMany, windowLimiter } from "../limits.js";
import { canStartOnTeam, readsTask, seesTask, visibleTasks } from "./guards.js";
import { taskPhase } from "./phase.js";
import { MAX_TARGETS, readTargets, skillSource, startRefusals, targetCandidates, teamSkills } from "./targets.js";
import { MAX_TASK_SKILLS, suggestionPrompt } from "./skills.js";
import type { SkillSuggestion } from "./skills.js";
import type { TargetChoice } from "./targets.js";
import { parseIssueLink } from "./issue.js";
import type { IssueLink } from "./issue.js";
import { taskBranch, ticketNeeded } from "./naming.js";
import { recordEvent } from "../events.js";
import { route } from "../route-scopes.js";
import type { FollowUpQuote } from "../task-followups.js";
import { Redactor } from "./redact.js";
import { nameReader, withSuggestions } from "../task-suggestions.js";
import { choicesProblem } from "./adapters/contract.js";
import type { AgentChoices } from "./adapters/contract.js";
import { DEFAULT_MODE, highestWithin, isPermissionMode, MODE_LABEL, PERMISSION_MODES } from "../../shared/permission-mode.js";
import { agentTimeMs, answerProblem } from "../task-requests.js";
import type { TaskAnswer, TaskRequestRecord } from "../task-requests.js";
import { memberTags } from "../directory.js";
import { localMachineId } from "../local.js";
import { ownCliHere } from "../forge/own-cli-here.js";
import { localMode } from "../mode.js";
import { inPlaceFolder, opensInPlace, projectTrust, setFolderTrust, trustsOwnFolder } from "./folder-trust.js";
import type { FolderTrust } from "./folder-trust.js";
import { budgetLedger, ownSetupFor, taskCreators, taskStartRefusal, unnamedMode } from "../policies.js";
import { orchestratorPolicies } from "../policy-routes.js";
import { autoContinuedKey, CODE_TEMPLATE, waitingBehind, MAX_CHILD_TASKS, TASK_LIMITS_SETTING, taskLimits, MAX_DELEGATION_DEPTH, namingFor, NO_RUNNER, ORCHESTRATOR_ONLY, OUTPUT_CUT, machineWaits, printable, START_REFUSED, SUGGESTIONS_AT_ONCE } from "./runner.js";
import { machineOffers } from "../../runner/machine-agents.js";
import type { FollowUpOffer, TaskRunner } from "./runner.js";
import { taskPaths } from "./isolation.js";
import { CLAUDE_PLANS_DIR } from "./profile.js";
import { PLAN_TEXT_MAX } from "../../shared/runner-wire.js";
import { shadowChanges, shadowFile, shadowPlaceOf, shadowSnapshot, shadowUndo } from "../shadow-git.js";
import { inPlaceReview, inWorkspace, ORCHESTRATOR_AGENT, FINISHED } from "./types.js";
import { folderLoaded, loadedLine, mostUsed, routed, routingLine, routingPrompt } from "./routing.js";
import { taskForge, taskState } from "./state.js";
import { approvedVerification, approveVerification, changedSince, repoReader } from "./verify.js";
import { detectVerification } from "./verify-detect.js";
import type { ReadFile } from "./verify-detect.js";
import type { ApprovedVerification, DetectedStep } from "../../shared/verification.js";
import type { Routing } from "./routing.js";
import { openProject } from "../project-routes.js";
import { AccountError } from "../accounts.js";
import type { TaskCursor, TaskFilter, TaskRecord, TaskTemplate } from "./types.js";

/** A template as the form sends it, or a refusal; absent and null both mean any change. */
function parseTemplate(raw: unknown): { template: TaskTemplate | null } | { error: string } {
  if (raw === undefined || raw === null) return { template: null };
  const { kind, skill, commitVersioning } = raw as { kind?: unknown; skill?: unknown; commitVersioning?: unknown };
  if (kind === "scaffold.refresh") {
    if (commitVersioning !== undefined && typeof commitVersioning !== "boolean") return { error: "commitVersioning is true or false" };
    return { template: { kind, commitVersioning: commitVersioning === true } };
  }
  if ((kind !== "skill.write" && kind !== "skill.improve") || typeof skill !== "string" || !SKILL_SLUG.test(skill)) {
    return { error: "a template writes or improves one skill, named with lower-case letters, digits and dashes" };
  }
  return { template: { kind, skill } };
}

const REPO_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const isTaskId = (id: string) => isId("tsk", id, OLDER_IDS.task);
/** How many tasks one page of the list holds. */
export const TASKS_PER_PAGE = 50;

/** A page cursor as the list sent it, null for the first page, undefined for one that is not a cursor. */
function readTaskCursor(text: string): TaskCursor | null | undefined {
  if (!text) return null;
  try {
    const { createdAt, id } = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Partial<TaskCursor>;
    return typeof createdAt === "string" && typeof id === "string" && id.length <= 64 ? { createdAt, id } : undefined;
  } catch {
    return undefined;
  }
}

/** A time as the store keeps it, a UTC ISO time; null for anything else. */
function isoTime(text: string): string | null {
  const at = text.length <= 40 ? Date.parse(text) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** How often a stream reads the store, how many lines one event carries, and how long a quiet stream waits before it says it is alive. */
export const STREAM_TICK_MS = 500;
export const STREAM_BATCH = 500;
export const HEARTBEAT_MS = 15_000;
/** How long an open stream outlives the session, member or key that opened it, once that is ended. */
export const AUTH_RECHECK_MS = 20_000;
/** Streams one orchestrator process keeps open at once; past it a page polls, as it did before streams. */
export const MAX_STREAMS = 200;
/** Streams one person keeps open at once, each tab one: past it, their next page polls, and no one person takes the process's all. */
export const STREAMS_PER_PERSON = 12;
/** How long a page waits before it opens a stream again after losing one. */
export const STREAM_RETRY_MS = 2_000;
/** Lines a read of a task's log returns at most; the answer says where the next read starts. */
export const LOG_PAGE = 2_000;
/** What a find in a task's log takes and gives: words of a few characters, and the first hundred lines, each cut short. */
const FIND_MIN = 2;
const FIND_MAX = 100;
const FIND_LINES = 100;
const FIND_TEXT = 300;
let streams = 0;
const streamsOf = new Map<string, number>();
export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 8000;
/** The most tasks one batch starts: a sprint's worth of issues, picked on a board. */
export const MAX_BATCH = 20;

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Skill suggestions one person asks for in a minute, counted per piece of work: each is an agent's run, paid for by the organization. */
export const SUGGESTIONS_PER_MINUTE = 20;

/** A start's picked skills: absent, or up to MAX_TASK_SKILLS distinct names. */
function readSkills(raw: unknown): string[] | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_TASK_SKILLS || raw.some((name) => typeof name !== "string" || !SKILL_NAME.test(name)) || new Set(raw).size !== raw.length) {
    return { error: `skills is a list of up to ${MAX_TASK_SKILLS} team skill names` };
  }
  return raw as string[];
}

/** The repositories whose team skills a piece of work reads: its own, the ones it names, or every candidate the planning step could choose. */
async function skillRepos(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, repo: RepoRecord, targets: TargetChoice | undefined): Promise<RepoRecord[]> {
  if (!targets) return [repo];
  if (targets === "orchestrator") return targetCandidates(ctx, user, (r) => runner.codeTarget(r));
  return (await Promise.all(targets.map((id) => ctx.store.getRepo(ctx.tenant, id)))).filter((r): r is RepoRecord => r !== null);
}

/** The names of the team skills a piece of work on these repositories can be started with. */
async function skillsOf(ctx: OrchestratorContext, runner: TaskRunner, repos: readonly RepoRecord[]) {
  return teamSkills(ctx, repos.flatMap((r) => skillSource(r, (one) => runner.codeTarget(one)) ?? []));
}

/** The issue a start or a suggestion names, read as the tracker gives its addresses; null for none. */
async function issueOf(ctx: OrchestratorContext, issueUrl: string): Promise<IssueLink | null | { error: string }> {
  if (!issueUrl) return null;
  try {
    const tracker = await readTracker(ctx);
    return parseIssueLink(issueAddress(issueUrl, tracker), tracker);
  } catch (err) {
    if (err instanceof ChangeRefused) return { error: err.message };
    throw err;
  }
}

/**
 * Which of the team's skills fit one piece of work, for a person who may start it: the agent
 * reads the issue and the skills of the repositories it would run in, and the orchestrator keeps
 * only the skills those repositories have.
 */
async function suggestSkills(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, agent: string, body: Record<string, unknown>): Promise<{ suggestions: SkillSuggestion[]; skills: { name: string; description: string }[]; note?: string } | { error: string; status: 400 | 403 | 404 | 409 | 502 }> {
  const repoId = typeof body.repoId === "string" ? body.repoId : "";
  const repo = REPO_ID.test(repoId) ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
  if (!repo) return { error: "unknown repository", status: 404 };
  if (!canStartOnTeam(user, repo.team)) return { error: START_REFUSED, status: 403 };
  const issue = await issueOf(ctx, typeof body.issueUrl === "string" ? body.issueUrl.trim() : "");
  if (issue && "error" in issue) return { error: issue.error, status: 400 };
  const asked = readTargets(body.targets);
  if (asked && typeof asked === "object" && "error" in asked) return { error: asked.error, status: 400 };
  const refused = (await startRefusals(ctx, user))(repo);
  if (refused) return { error: refused.message, status: refused.status };

  const description = typeof body.description === "string" ? body.description.trim().slice(0, MAX_DESCRIPTION) : "";
  const skills = await skillsOf(ctx, runner, await skillRepos(ctx, runner, user, repo, asked as TargetChoice | undefined));
  const listed = skills.map((skill) => ({ name: skill.name, description: skill.description }));
  if (!skills.length) return { suggestions: [], skills: listed };
  if (!runner.runsHere(agent)) return { suggestions: [], skills: listed, note: NO_RUNNER };
  const read = issue ? await readIssue(ctx, issue, user) : null;
  const prompt = suggestionPrompt({ title: issue?.key ? `Work on ${issue.key}` : repo.name, description }, issue, read && "text" in read ? read.text : null, skills);
  const answer = await runner.suggestSkills(agent, prompt, skills.map((skill) => skill.name));
  await ctx.store.recordExtraSpend({ tenant: ctx.tenant, id: `spend_${randomUUID()}`, createdBy: user.email, repoId: repo.id, team: repo.team, at: new Date().toISOString(), kind: "skill-suggestion", ...answer.cost });
  await recordEvent(ctx, user, "task.skills.suggested", {
    repoId: repo.id,
    subject: `repo:${repo.id}`,
    detail: `${answer.suggestions ? `suggested ${answer.suggestions.length} team skill(s)` : "the agent did not answer"} for ${issue?.key ?? repo.name}${answer.cost.usd !== null ? `; the agent reported $${answer.cost.usd.toFixed(4)}` : ""}`,
  });
  if (!answer.suggestions) return { error: "the agent did not answer; pick the skills yourself", status: 502 };
  return { suggestions: answer.suggestions, skills: listed };
}

/**
 * A folder on a person's machine is theirs: a task there is leased to that machine alone, so only
 * its person starts one, and anyone else's would wait in line for good.
 */
async function machineAgentOffers(ctx: OrchestratorContext, runner: TaskRunner, user: Principal) {
  if (!runner.keptForMachine() || ctx.mode === "local") return null;
  const reported = (await ctx.store.listMachines(ctx.tenant, user.id)).filter((m) => m.userId === user.id && !m.revokedAt).flatMap((m) => m.agents);
  return reported.length ? machineOffers(reported) : null;
}

async function machineRefusal(ctx: OrchestratorContext, user: Principal, repo: RepoRecord): Promise<string | null> {
  const folder = machineFolderOf(repo.url);
  if (!folder) return null;
  if ((await ctx.store.listMachines(ctx.tenant, user.id)).some((m) => m.id === folder.machineId && m.userId === user.id && !m.revokedAt)) return null;
  const machine = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === folder.machineId);
  const person = machine ? await ctx.store.getUser(ctx.tenant, machine.userId) : null;
  return `this project is on ${person ? `${person.name || person.email}'s` : "another person's"} machine; only they start tasks in it`;
}

/**
 * Starts a task for `user`, or says why not: the one way a task begins, from the form and from
 * the orchestrator's MCP server alike. Starting one takes the same right as proposing any other
 * change to that team's repository.
 */
export async function startTask(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, body: Record<string, unknown> | null, parent?: TaskRecord, seedFrom?: { taskId: string; n: number }): Promise<{ task: TaskRecord } | { error: string; status: 400 | 403 | 404 | 409; code?: string }> {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  const repoId = typeof body?.repoId === "string" ? body.repoId : "";
  const agent = typeof body?.agent === "string" ? body.agent : "";
  const issueUrl = typeof body?.issueUrl === "string" ? body.issueUrl.trim() : "";
  const repo = REPO_ID.test(repoId) ? await ctx.store.getRepo(ctx.tenant, repoId) : null;
  if (!repo) return { error: "unknown repository", status: 404 };
  if (!canStartOnTeam(user, repo.team)) return { error: START_REFUSED, status: 403 };
  const onMachine = await machineRefusal(ctx, user, repo);
  if (onMachine) return { error: onMachine, status: 403, code: "on-another-machine" };
  let issue: ReturnType<typeof parseIssueLink> | null = null;
  if (issueUrl) {
    try {
      const tracker = await readTracker(ctx);
      issue = parseIssueLink(issueAddress(issueUrl, tracker), tracker);
    } catch (err) {
      if (err instanceof ChangeRefused) return { error: err.message, status: 400 };
      throw err;
    }
  }
  if (issue && "error" in issue) return { error: issue.error, status: 400 };
  const parsed = parseTemplate(body?.template);
  if ("error" in parsed) return { error: parsed.error, status: 400 };
  const { template } = parsed;
  const asked = readTargets(body?.targets);
  if (asked && typeof asked === "object" && "error" in asked) return { error: asked.error, status: 400 };
  const targets = asked as TargetChoice | undefined;
  if (targets && !issue) return { error: "a task over several repositories needs an issue link", status: 400 };
  if (targets && template) return { error: "a task over several repositories works on an issue, not from a template", status: 400 };
  const picked = readSkills(body?.skills);
  if (picked && !Array.isArray(picked)) return { error: picked.error, status: 400 };
  // A start that says nothing of what to leave out takes its person's own list; one that says it, an empty list
  // included, holds as sent.
  const ownOff = await handbookOff(ctx.store, ctx.tenant, user.id);
  const off = readOff(body?.off ?? ownOff);
  if (off && "error" in off) return { error: off.error, status: 400 };
  const offMoved = body?.off === undefined || body.off === null ? 0 : offChanges(off, ownOff);
  if (body?.readOnly !== undefined && typeof body.readOnly !== "boolean") return { error: "readOnly is true or false", status: 400 };
  const readOnly = body?.readOnly === true;
  if (readOnly && (template || targets)) return { error: "a question reads one repository or folder, from no template", status: 400 };
  const gone = readOnly && issue ? issueGone(await readIssue(ctx, issue, user), issue.key) : null;
  if (gone) return { error: gone, status: 409 };
  const baseBranch = typeof body?.baseBranch === "string" && body.baseBranch.trim() ? body.baseBranch.trim() : undefined;
  if (body?.baseBranch !== undefined && body.baseBranch !== null && typeof body.baseBranch !== "string") return { error: "baseBranch is a branch's name", status: 400 };
  const branches = baseBranch ? await repoBranches(ctx, repo) : null;
  // Named only as refs/heads/<name> from here on, and only a name the orchestrator's own copy of the repository has.
  const onCopy = baseBranch && branches?.branches.includes(baseBranch) ? await gitAsyncMaybe(["--git-dir", mirrorDir(ctx, repo.id), "rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}^{commit}`], mirrorDir(ctx, repo.id)) : null;
  if (baseBranch && !onCopy) return { error: `${baseBranch} is not a branch of ${repo.name} a task can start from`, status: 400, code: "unknown-base-branch" };
  // The default is no choice: a task on it keeps following the repository's default, as one started without picking does.
  const baseChoice = baseBranch && baseBranch !== branches?.default ? baseBranch : undefined;
  const attachments = await startAttachments(ctx, user, body?.attachments);
  if (!attachments) return { error: "attachments names files you uploaded for this start in the last hour, each once", status: 400, code: "attachment-unknown" };
  if (picked?.length) {
    const known = (await skillsOf(ctx, runner, await skillRepos(ctx, runner, user, repo, targets))).map((skill) => skill.name);
    const unknown = picked.find((name) => !known.includes(name));
    if (unknown) return { error: `${unknown} is not one of the team's skills for ${repo.name}`, status: 400 };
  }
  const tools = await toolChoiceOf(ctx, repo.id, body?.projectSkills, body?.mcpServers, body?.mcpConfirmed);
  if ("error" in tools) return { error: tools.error, status: 400, code: tools.code };
  const fromTemplate = !template
    ? ""
    : template.kind === "scaffold.refresh"
      ? template.commitVersioning ? "chore: switch the plugin to versioning by commit" : REFRESH_COMMIT_TITLE
      : `${template.kind === "skill.write" ? "Write" : "Improve"} the skill ${template.skill}`;
  const titled = title || (issue?.key ? `Work on ${issue.key}` : fromTemplate);
  if (!titled || titled.length > MAX_TITLE || /[\u0000-\u001f\u007f]/.test(titled)) {
    return { error: `a title is one line of plain text of at most ${MAX_TITLE} characters; it can be left out when the issue link names an issue`, status: 400 };
  }
  if (description.length > MAX_DESCRIPTION) return { error: `a description is at most ${MAX_DESCRIPTION} characters`, status: 400 };
  // A store refuses a NUL in text, and git a NUL in an argument; tabs and line breaks are ordinary text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) return { error: "a description holds a control character; remove it and send it again", status: 400 };
  // The orchestrator refreshes the scaffold itself; any agent named with it is not asked.
  const runBy = template?.kind === "scaffold.refresh" ? ORCHESTRATOR_AGENT : agent;
  const machineAgents = await machineAgentOffers(ctx, runner, user);
  const known = machineAgents ?? runner.agents();
  if (runBy !== ORCHESTRATOR_AGENT && !known.some((a) => a.id === agent)) return machineAgents ? { error: `no machine of yours runs ${agent || "that agent"}; install it on your machine, or pick an agent your machine runs`, status: 409, code: "agent-not-on-machine" } : { error: "unknown agent", status: 400 };
  // What the person chose of the agent's own options; a value the agent does not offer is refused, never passed on.
  const picks = body?.choices ?? undefined;
  if (picks !== undefined && (!picks || typeof picks !== "object" || Array.isArray(picks) || Object.values(picks).some((v) => typeof v !== "string"))) return { error: "choices names an option and the value picked for it, as text", status: 400 };
  const choices = picks as AgentChoices | undefined;
  const offers = runBy === ORCHESTRATOR_AGENT ? [] : known.find((a) => a.id === agent)!.options;
  const choiceProblem = choices ? choicesProblem(offers, choices) : null;
  if (choiceProblem) return { error: choiceProblem, status: 400 };
  const named = body?.mode ?? undefined;
  if (named !== undefined && !isPermissionMode(named)) return { error: `mode is one of ${PERMISSION_MODES.join(", ")}`, status: 400 };
  const offered = runBy === ORCHESTRATOR_AGENT ? [DEFAULT_MODE] : known.find((a) => a.id === agent)!.modes;
  if (named !== undefined && !offered.includes(named)) return { error: `this agent runs in ${offered.map((m) => MODE_LABEL[m]).join(" or ")}, not in ${MODE_LABEL[named]}`, status: 409, code: "mode-not-offered" };
  const planFirst = body?.planFirst === true;
  if (planFirst && (runBy === ORCHESTRATOR_AGENT || !known.find((a) => a.id === agent)!.plan)) return { error: "this agent does not plan first; start it without a plan, or with an agent that plans", status: 409, code: "plan-not-offered" };
  if (!inConfiguration(ctx, repo.id)) return { error: NOT_CONFIGURED, status: 409 };
  // Refused before a task exists: a task kept for its starter's machine that the machine cannot run
  // would wait for nothing. A local orchestrator's own runner runs all but one over several
  // repositories; a connected machine runs one project's task alone.
  if (runner.keptForMachine() && (targets || (ctx.mode !== "local" && (parent || template?.kind === "scaffold.refresh")))) return { error: ORCHESTRATOR_ONLY, status: 409, code: "runs-on-orchestrator" };
  // A folder without git has no commit to read and no branch to name: its task works on it in place.
  // A folder worked on in place, on this machine or the person's own, has no head the orchestrator reads.
  const folder = await opensInPlace(repo);
  if (!folder && !repo.head) return { error: repo.error ? maskUrl(repo.error) : NOT_READ_YET, status: 409 };
  if (folder && (template || targets || parent)) return { error: "a folder without git takes a task of its own, with no template, other repositories or delegation", status: 409, code: "in-place-task" };
  const code = runner.codeTarget(repo);
  if (code && template) return { error: CODE_TEMPLATE, status: 409 };
  const personal = await runner.personal();
  if (personal?.refused) return { error: personal.refused, status: 409 };
  // Asked before a task is queued, so a start the team's branch rule would refuse never waits in line.
  const branch = folder ? null : taskBranch("000000000000", titled, await namingFor(code, mirrorDir(ctx, repo.id), repo.head!), issue);
  if (branch && "needsTicket" in branch) return { error: ticketNeeded(repo.name, branch.needsTicket), status: 409 };
  if (template?.kind === "scaffold.refresh" && !memberUrl(ctx, repo.id)) {
    return { error: `${repo.name} has no memberUrl in the orchestrator's configuration: the scaffold writes the address teammates add the repository by, so it is not refreshed without one`, status: 409 };
  }
  if (template && template.kind !== "scaffold.refresh") {
    // Read at the head the task will check out: writing a skill that is there, or improving one
    // that is not, would leave the agent to guess which the person meant.
    const exists = (await gitAsyncMaybe(["cat-file", "-e", `${repo.head}:skills/${template.skill}/SKILL.md`], mirrorDir(ctx, repo.id))) !== null;
    if (template.kind === "skill.write" && exists) return { error: `${repo.name} already has the skill ${template.skill}; improve it instead`, status: 409 };
    if (template.kind === "skill.improve" && !exists) return { error: `${repo.name} has no skill ${template.skill} to improve`, status: 409 };
  }
  // A task no runner here can carry out is refused before it waits in line. One kept for its starter's machine runs
  // there on the person's own Claude Code sign-in, so a cloud orchestrator's model key is no condition for it.
  if (runBy !== ORCHESTRATOR_AGENT && !runner.keptForMachine() && !runner.runsHere(runBy)) return { error: NO_RUNNER, status: 409, code: "no-runner" };
  // From reading the budget to queuing the task is one turn for the organization: two starts
  // read side by side would each find the budget the other is about to hold.
  return oneAtATime(join(ctx.dataDir, "task-starts", ctx.tenant), async () => {
    // Counted in the same turn as the start, so two delegations at once cannot both take the last place.
    if (parent && (parent.depth ?? 0) >= MAX_DELEGATION_DEPTH) return { error: "a delegated task does not delegate further", status: 409, code: "delegation-depth" };
    if (parent && (await ctx.store.taskChildren(ctx.tenant, parent.id)).length >= MAX_CHILD_TASKS) return { error: `a task delegates at most ${MAX_CHILD_TASKS} tasks`, status: 409, code: "delegation-count" };
    // The orchestrator's own policies: who may start tasks on this repository, and what this month's tasks may cost.
    const tags = (await memberTags(ctx.store, ctx.tenant)).get(user.id)?.map((t) => t.tag) ?? [];
    const policies = await orchestratorPolicies(ctx);
    // A start that names no mode runs in the most its agent offers within Auto and the ceiling:
    // lowering is free, so only a mode asked for above the ceiling is refused.
    const fits = named ?? highestWithin(offered, unnamedMode(policies, user, tags, repo));
    const mode = fits ?? DEFAULT_MODE;
    const byPolicy = taskStartRefusal(policies, user, tags, repo, await budgetLedger(ctx), await ctx.store.listRepos(ctx.tenant), await taskCreators(ctx), fits ?? undefined);
    if (byPolicy) {
      await recordEvent(ctx, user, "task.refused", { repoId: repo.id, subject: byPolicy.policy?.id ? `policy:${byPolicy.policy.id}` : null, detail: `${byPolicy.code}: a task on ${repo.name} was refused by the orchestrator policy "${byPolicy.policy?.name}"` });
      return { error: byPolicy.message, status: byPolicy.status, code: byPolicy.code };
    }
    if (targets) {
      // Asked of every repository before the task is queued, as of the one it starts from: a
      // start that one of them would refuse never waits in line.
      const candidates = await targetCandidates(ctx, user, (r) => runner.codeTarget(r), mode);
      if (!candidates.length) return { error: "no code repository is open to you for tasks", status: 409 };
      if (targets !== "orchestrator") {
        const refusal = await startRefusals(ctx, user, undefined, mode);
        for (const id of targets) {
          const target = candidates.find((r) => r.id === id) ?? null;
          if (!target) {
            const known = await ctx.store.getRepo(ctx.tenant, id);
            const refused = known && known.head && inConfiguration(ctx, id) && runner.codeTarget(known) && canStartOnTeam(user, known.team) ? refusal(known) : null;
            if (refused) return { error: `${known!.name}: ${refused.message}`, status: refused.status, code: refused.code };
            return { error: `${id} is not a code repository this orchestrator runs tasks on`, status: 400 };
          }
          const named = taskBranch("000000000000", titled, await namingFor(runner.codeTarget(target), mirrorDir(ctx, target.id), target.head!), issue);
          if ("needsTicket" in named) return { error: ticketNeeded(target.name, named.needsTicket), status: 409 };
        }
      }
    }
    const task = await runner.start({ repo, title: titled, description, issue, agent: runBy, user, template, mode, ...(choices ? { choices } : {}), ...(targets ? { targets } : {}), ...(picked?.length ? { skills: picked } : {}), tools, ...(parent ? { parent } : {}), ...(planFirst ? { planFirst } : {}), ...(attachments.length ? { attachments } : {}), ...(baseChoice ? { baseBranch: baseChoice } : {}), ...(readOnly ? { readOnly } : {}), ...(seedFrom ? { seedFrom } : {}), ...(off ? { off } : {}) });
    await recordEvent(ctx, user, "task.started", { repoId: repo.id, subject: `task:${task.id}`, detail: `${task.title} on ${repo.name}` });
    if (offMoved) {
      await ctx.store.updateTask(ctx.tenant, task.id, { offChanges: offMoved });
      task.offChanges = offMoved;
    }
    // What the person's handbooks held as the task started, kept by name for its page; read after the start, so no task waits on it.
    void runner
      .handbookSources(localRepoPath(repo.url) ?? undefined)
      .then((read) => (read ? ctx.store.updateTask(ctx.tenant, task.id, { setup: setupOf(read.sources) }) : undefined))
      .catch((err: Error) => console.error(`task ${task.id}: the handbooks it started with were not kept: ${err.message}`));
    if (!task.template && !task.targetMode && !task.readOnly) void noteChecksFound(ctx, repo, task.id).catch((err: Error) => console.error(`task ${task.id}: its folder's checks were not read: ${err.message}`));
    return { task };
  });
}

/**
 * The task API, mounted behind the orchestrator's sign-in. A task and its log are read by those who
 * may start tasks on its team and by the person who started it (`seesTask`); starting or
 * cancelling one takes the same right as proposing any other change to that team's repository.
 */
export function taskRoutes(ctx: OrchestratorContext, runner: TaskRunner): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();

  /**
   * A task as the screen shows it: its place in line while it waits, and where its request
   * stands now. The request's status is read from the request's own record at every read, not
   * copied onto the task: a merge, a close, a hosted forge's Refresh and the start-up
   * reconciliation all write that record, and a copy would drift from whichever of them did
   * not also write it.
   */
  const shown = async (tasks: TaskRecord[], requests: RequestRecord[], viewer: Principal) => {
    const line = runner.queued();
    const byNumber = new Map(requests.map((r) => [`${r.repoId}#${r.number}`, r]));
    const names = tasks.some((t) => t.targets) ? new Map((await ctx.store.listRepos(ctx.tenant)).map((r) => [r.id, r.name])) : new Map<string, string>();
    const kept = (task: TaskRecord) => task.runner === "local" && task.status === "queued";
    const waits = await machineWaits(ctx, tasks.filter(kept).map((t) => t.createdBy));
    // Whether the person trusts the folder's own settings, for each project the agent works in directly; asked once on the task's page.
    const trusts = new Map<string, FolderTrust>();
    for (const repoId of new Set(tasks.map((t) => t.repoId))) {
      const repo = await ctx.store.getRepo(ctx.tenant, repoId);
      const trust = repo ? await projectTrust(ctx, repo) : null;
      if (trust) trusts.set(repoId, trust);
    }
    // What stopped an interrupted task: its machine going away, or a stop of the orchestrator whose own runner held it.
    const cutOff = tasks.filter((t) => t.status === "interrupted");
    const ownMachine = cutOff.length ? await localMachineId(ctx.store, ctx.tenant) : null;
    const stoppedBy = new Map<string, "machine" | "restart">();
    for (const task of cutOff) stoppedBy.set(task.id, ownMachine && (await ctx.store.taskLease(ctx.tenant, task.id))?.claimedBy === ownMachine ? "restart" : "machine");
    // The machine a change kept on a person's machine stays on, by the name its person gave it.
    const keptOn = tasks.filter((t) => t.targets?.some((target) => target.status === "local"));
    const machineNames = keptOn.length ? new Map((await ctx.store.listMachines(ctx.tenant, null)).map((m) => [m.id, m.name])) : new Map<string, string>();
    const ranOn = new Map<string, string | null>();
    for (const task of keptOn) ranOn.set(task.id, machineNames.get((await ctx.store.taskLease(ctx.tenant, task.id))?.claimedBy ?? "") ?? null);
    // A running task waits on its person while one of its approvals is unanswered.
    const asking = new Set<string>();
    for (const task of tasks.filter((t) => t.status === "running")) if ((await ctx.store.taskRequests(ctx.tenant, task.id)).some((r) => r.status === "pending")) asking.add(task.id);
    const requestOf = (repoId: string, number: number) => byNumber.get(`${repoId}#${number}`);
    // A task in line behind one that waits on its person's answer says which.
    const behind = await waitingBehind(ctx, tasks);
    // A task on a folder of repositories goes on from what it left only on a machine that knows how.
    const goesOn = new Set<string>();
    for (const task of tasks.filter(inWorkspace)) if (await workspaceGoesOn(ctx, task)) goesOn.add(task.id);
    // A stopped task whose plan is still readable is offered to go on from it, whatever stopped it.
    const plans = new Set<string>();
    for (const task of tasks.filter((t) => t.runner === "local" && (t.status === "failed" || t.status === "cancelled" || t.status === "interrupted"))) if (await unansweredPlan(ctx, task)) plans.add(task.id);
    const views = tasks.map((task) => {
      const request = task.requestNumber !== null ? byNumber.get(`${task.repoId}#${task.requestNumber}`) : undefined;
      const at = line.indexOf(task.id);
      const targets = task.targets ?? null;
      const waitingFor = task.status === "interrupted" && task.limitResetAt ? "limit" : kept(task) ? waits.get(task.createdBy) ?? null : null;
      return {
        ...task,
        phase: taskPhase(task, (repoId, number) => byNumber.get(`${repoId}#${number}`)?.status ?? null),
        queuePosition: at >= 0 ? at + 1 : null,
        followUp: offeredFollowUp(runner, task, request, goesOn.has(task.id)),
        // Kept for the starter's own machine while none of theirs can take it: the card says how to connect one, or that it is away.
        // Cut off at their usage limit, it says when the limit resets and the task goes on.
        waitingFor,
        ...(behind.has(task.id) ? { waitingBehind: behind.get(task.id) } : {}),
        ...(task.limitResetAt ? { resetAt: task.limitResetAt } : {}),
        state: taskState(task, requestOf, waitingFor, asking.has(task.id)),
        forge: taskForge(task, requestOf),
        folderTrust: trusts.get(task.repoId) ?? null,
        interruptedBy: stoppedBy.get(task.id) ?? null,
        planToApprove: plans.has(task.id),
        ranOn: ranOn.get(task.id) ?? null,
        request: request ? { status: request.status, provider: request.provider, branch: request.branch, url: request.url, ...(request.heldHead ? { heldReason: request.heldReason } : {}) } : null,
        targets: targets?.map((t) => {
          const opened = t.requestNumber !== null ? byNumber.get(`${t.repoId}#${t.requestNumber}`) : undefined;
          return { repoId: t.repoId, name: names.get(t.repoId) ?? t.repoId, status: t.status, reason: t.reason, path: t.path ?? null, forge: t.origin ? remoteForge(ctx, t.origin) : null, branch: t.branch, tests: t.tests, error: t.error, cost: t.cost, request: opened ? { number: opened.number, url: opened.url, status: opened.status } : t.forgeRequest ? { number: t.forgeRequest.number, url: t.forgeRequest.url, status: "open" as const } : null };
        }) ?? null,
        // The task's cost leaves out a repository whose agent reported none. Only a task over several
        // repositories runs an agent per repository; in one working folder a single run changes
        // them all and its whole cost is the task's, so no repository there is a part left unreported.
        ...(task.targetMode && targets?.some((t) => t.status !== "planned" && t.status !== "skipped" && t.cost.usd === null) && task.cost.usd !== null ? { costPartial: true } : {}),
      };
    });
    return withSuggestions(ctx, viewer, views);
  };
  // One task's page draws a card for each thing its agent asked, so its read and its stream carry them; a list does not.
  // Its starter's words still waiting for the agent come with them, oldest first, for the page to show, change or take back.
  // An ended task says how long its agent worked: the runs on a machine as each counted it, a run here from its start to
  // its end, either way with the time its cards waited on a person left out.
  const withAsked = async <T extends Pick<TaskRecord, "id" | "startedAt" | "finishedAt" | "ranMs">>(view: T) => {
    const asked = await ctx.store.taskRequests(ctx.tenant, view.id);
    const ranMs = view.ranMs ?? (view.startedAt && view.finishedAt ? agentTimeMs(view.startedAt, Date.parse(view.finishedAt), asked) : undefined);
    return {
      ...view,
      ...(view.finishedAt && ranMs !== undefined ? { ranMs } : {}),
      requests: await shownRequests(ctx, asked),
      messages: (await ctx.store.pendingFollowUps(ctx.tenant, view.id)).filter((f) => f.source === "person").map(({ id, text, quotes, createdAt }) => ({ id, text, quotes, createdAt })),
    };
  };
  const requestsOf = async (task: TaskRecord) => {
    const pairs = [...(task.requestNumber !== null ? [{ repoId: task.repoId, number: task.requestNumber }] : []), ...(task.targets ?? []).flatMap((t) => (t.requestNumber !== null ? [{ repoId: t.repoId, number: t.requestNumber }] : []))];
    return (await Promise.all(pairs.map((p) => ctx.store.getRequest(ctx.tenant, p.repoId, p.number)))).filter((r): r is RequestRecord => r !== null);
  };

  app.get("/api/tasks/options", async (c) => {
    const user = c.get("user");
    // A repository out of the orchestrator's configuration keeps the head of its last sync; a task
    // would read that old copy and open a request on it, so it is not offered.
    const listed = (await ctx.store.listRepos(ctx.tenant)).filter((r) => canStartOnTeam(user, r.team) && inConfiguration(ctx, r.id));
    // A folder without git has no head and is offered all the same: its task works on it in place.
    const folders = await Promise.all(listed.map((r) => inPlaceFolder(r)));
    // A folder on the person's own machine is never synced here, so it has no head; it is offered to
    // them alone, as the only one who starts a task there, and ends as its machine read the folder:
    // changed in place without git, a pushed request with it.
    const machines = new Map((await ctx.store.listMachines(ctx.tenant, user.id)).filter((m) => m.userId === user.id && !m.revokedAt).map((m) => [m.id, m.name]));
    const machineOf = (r: RepoRecord) => {
      const folder = machineFolderOf(r.url);
      return folder ? (machines.get(folder.machineId) ?? null) : null;
    };
    const repos = listed.filter((r, i) => r.head || folders[i] || machineOf(r));
    const inPlace = new Set(listed.filter((r, i) => folders[i] || (machineOf(r) && ctx.addedRepos?.get(r.id)?.machine?.git === "none")).map((r) => r.id));
    // The form waits for no probe: it shows the last check, and starts a new one once that is
    // older than its lifetime.
    const checked = runner.lastReadiness();
    void runner.readiness();
    // The person's own commands and plugins are theirs to see: the owner of a one-person orchestrator, signed in, never a key.
    const own = localMode() && !user.key && manages(user);
    const setup = own ? runner.lastPersonalSetup() : null;
    if (own) void runner.personalSetup();
    // The form shows where each agent stands and nothing more; what each check found - a CLI's
    // path on the host, what it printed - is in the readiness report, which is the admin's.
    const machineAgents = await machineAgentOffers(ctx, runner, user);
    const agents = machineAgents
      ? machineAgents.map(({ signIn: _signIn, ...agent }) => ({ ...agent, personal: null }))
      : runner.agents().map((agent) => {
      const found = checked?.agents.find((a) => a.id === agent.id);
      const state = !found ? null : !found.ready ? "not-ready" : found.checks.some((check) => check.status === "warn") ? "warnings" : "ready";
      // The first failure, else the first warning, in its fixed few words: never what the check found.
      const worst = found ? (found.checks.find((check) => check.status === "fail") ?? found.checks.find((check) => check.status === "warn")) : undefined;
      // The repair is a command on the orchestrator's host, the readiness report's to give: only those who see the report get it.
      const repair = manages(user) ? { code: worst?.code ?? null, fix: worst?.fix ?? null } : {};
      return { ...agent, readiness: found ? { ready: found.ready, state, first: worst?.short ?? null, ...repair } : null, personal: setup && agent.id === "claude-code" ? { commands: setup.commands, plugins: setup.plugins, mcpServers: setup.mcpServers, claudeMd: setup.claudeMd, readAt: setup.readAt } : null };
    });
    // Whether each repository's branch rule wants a ticket, so the form asks for an issue link
    // before a start is refused for the lack of one.
    const tickets = await Promise.all(repos.map(async (r) => {
      if (inPlace.has(r.id) || !r.head) return null;
      const asked = taskBranch("000000000000", "task", await namingFor(runner.codeTarget(r), mirrorDir(ctx, r.id), r.head!));
      return "needsTicket" in asked ? asked.needsTicket : null;
    }));
    // Where each repository's requests open, so the form can say a reviewer merges there; none for a folder of this machine's.
    const forges = await Promise.all(repos.map(async (r) => (await ctx.store.getForgeConfig(ctx.tenant, r.id))?.kind ?? null));
    const personal = await runner.personal();
    const policies = await orchestratorPolicies(ctx);
    const tags = (await memberTags(ctx.store, ctx.tenant)).get(user.id)?.map((t) => t.tag) ?? [];
    // A task over several repositories is offered once two code repositories are open to this person.
    const candidates = await targetCandidates(ctx, user, (r) => runner.codeTarget(r));
    return c.json({
      agents,
      // `result` says before a start how its task ends: a request, or changes made in the folder itself.
      // `machine` names the person's machine a project's folder is on.
      repos: repos.map((r, i) => ({ id: r.id, name: r.name, team: r.team, kind: runner.codeTarget(r) ? "code" : "skills", ticketExample: tickets[i], result: inPlace.has(r.id) ? "changes" : "request", forge: forges[i] === "gitlab" || forges[i] === "github" ? forges[i] : null, ownSetup: ownSetupFor(policies, user, tags, r).allowed, ...(machineOf(r) ? { machine: machineOf(r) } : {}) })),
      readinessReport: manages(user),
      profile: personal ? { personal: true, note: personal.note, refused: personal.refused } : { personal: false },
      multiRepo: candidates.length >= 2 ? { candidates: candidates.map((r) => ({ id: r.id, name: r.name, team: r.team })), maxTargets: MAX_TARGETS } : null,
    });
  });

  // The person who opened a folder says once whether its own Claude Code settings load in their tasks: the owner of a one-person orchestrator for one of its folders, the machine's person for one of theirs.
  route(app, "PUT /api/projects/:id/trust", async (c) => {
    const user = c.get("user");
    const repo = await ctx.store.getRepo(ctx.tenant, c.req.param("id") ?? "");
    if (!repo) return c.json({ error: "unknown project" }, 404);
    const machine = machineFolderOf(repo.url);
    const theirs = machine ? !user.key && (await ctx.store.listMachines(ctx.tenant, user.id)).some((m) => m.id === machine.machineId && !m.revokedAt) : localMode() && !user.key && manages(user);
    if (!theirs) return c.json({ error: "only the person who opened this folder says whether its settings are trusted" }, 403);
    if (!(await trustsOwnFolder(ctx, repo))) return c.json({ error: "a project the orchestrator clones, or a folder holding repositories, loads its person's user settings alone; there is no folder of theirs to trust", code: "not-a-folder" }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { trusted?: unknown };
    if (typeof body.trusted !== "boolean") return c.json({ error: "say trusted: true or false" }, 400);
    return c.json({ trust: await setFolderTrust(ctx, user, repo.id, body.trusted) });
  });

  // What an agent last said of the person's own usage windows, for the line under Start; a week-old reading says nothing.
  route(app, "GET /api/agents/:id/limit", async (c) => {
    const user = c.get("user");
    return c.json({ windows: await lastLimits(ctx.store, ctx.tenant, c.req.param("id") ?? "", user.email) });
  });

  app.get("/api/agents/readiness", async (c) => {
    if (!manages(c.get("user"))) return c.json({ error: "only an owner or an admin can see agent readiness" }, 403);
    return c.json(await runner.readiness(c.req.query("fresh") === "1"));
  });

  // A page at a time, newest first: the screen asks for the first page while a task runs, and
  // for older ones only when a person asks. Who sees which task is the store's filter, so a page
  // is full whatever the person may see.
  app.get("/api/tasks", async (c) => {
    const repoId = c.req.query("repo");
    const repo = repoId && REPO_ID.test(repoId) ? repoId : undefined;
    const user = c.get("user");
    const after = readTaskCursor(c.req.query("after") ?? "");
    if (after === undefined) return c.json({ error: "that page of tasks cannot be read; start from the first" }, 400);
    const sinceText = c.req.query("since");
    const since = sinceText ? isoTime(sinceText) : undefined;
    if (since === null) return c.json({ error: "since is a UTC ISO time" }, 400);
    const filter: TaskFilter = { ...(repo ? { repoId: repo } : {}), ...(since ? { since } : {}), ...visibleTasks(user) };
    const page = await ctx.store.taskPage(ctx.tenant, filter, after, TASKS_PER_PAGE);
    const requests = (await Promise.all(page.tasks.map(requestsOf))).flat();
    return c.json({ tasks: await shown(page.tasks, requests, user), next: page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null });
  });

  // A person's own tasks that start again on a schedule; a start that names a repeat keeps it, and starts nothing now.
  app.get("/api/tasks/repeats", async (c) => {
    const user = c.get("user");
    const now = new Date();
    const mine = (await ctx.store.listRepeats(ctx.tenant)).filter((r) => r.createdBy === user.email && !r.stoppedAt);
    return c.json({ repeats: mine.map((r) => ({ id: r.id, title: r.title, every: r.every, at: r.at, next: runTimes(r, now).next.toISOString(), ...(r.skipped ? { skipped: r.skipped } : {}) })) });
  });

  route(app, "POST /api/tasks/repeats/:id/stop", async (c) => {
    const user = c.get("user");
    const repeat = (await ctx.store.listRepeats(ctx.tenant)).find((r) => r.id === c.req.param("id") && r.createdBy === user.email);
    if (!repeat) return c.json({ error: "unknown repeat" }, 404);
    await ctx.store.stopRepeat(ctx.tenant, repeat.id, new Date().toISOString());
    return c.json({ stopped: repeat.id });
  });

  app.post("/api/tasks", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body?.repeat !== undefined) {
      if (ctx.mode !== "local" || user.key) return c.json({ error: "a task repeats on a person's own orchestrator, set from its form" }, 400);
      const when = readRepeat(body.repeat);
      if ("error" in when) return c.json({ error: when.error }, 400);
      const { repeat: _repeat, ...start } = body;
      const repo = typeof start.repoId === "string" ? await ctx.store.getRepo(ctx.tenant, start.repoId) : null;
      const title = typeof start.title === "string" ? start.title.trim() : "";
      if (!repo || !title || typeof start.agent !== "string") return c.json({ error: "a repeat names the project, a title and an agent, as a start does" }, 400);
      if ((await ctx.store.listRepeats(ctx.tenant)).filter((r) => r.createdBy === user.email && !r.stoppedAt).length >= REPEATS_MAX) return c.json({ error: `a person keeps at most ${REPEATS_MAX} repeating tasks; stop one first`, code: "too-many-repeats" }, 409);
      const kept = newRepeat(ctx.tenant, user.email, start, title, when);
      await ctx.store.addRepeat(kept);
      return c.json({ repeat: { id: kept.id, title, every: kept.every, at: kept.at, next: runTimes(kept, new Date()).next.toISOString() } }, 201);
    }
    const started = await startAnywhere(ctx, runner, user, body);
    if ("error" in started) return c.json({ error: started.error, ...(started.code ? { code: started.code } : {}) }, started.status);
    return c.json({ task: (await shown([started.task], [], user))[0] }, 201);
  });

  // Where a start that names no project would go, before it starts: a form shows the folder, and a start that sends it
  // back as its path is not routed again. `folder` is null when the person is to pick one.
  route(app, "POST /api/tasks/where", async (c) => {
    const user = c.get("user");
    if (!manages(user) || ctx.mode !== "local" || !ctx.workFolders) return c.json({ error: "only the person whose orchestrator it is starts a task without naming its project" }, 403);
    const where = await whereTo(ctx, runner, user, ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>);
    if ("error" in where) return c.json({ error: where.error, ...(where.code ? { code: where.code } : {}) }, where.status);
    return c.json({ folder: where.routing ? { path: where.routing.path, reason: where.routing.reason, fallback: where.routing.fallback } : null, title: where.title });
  });

  // The folders a task with no project named is sent among, the newest first; none where the orchestrator picks no folder.
  route(app, "GET /api/work-folders", async (c) => {
    const user = c.get("user");
    if (!manages(user)) return c.json({ error: "only the person whose orchestrator it is reads their folders" }, 403);
    return c.json({ folders: ctx.mode === "local" && ctx.workFolders ? await ctx.workFolders(user) : [] });
  });

  // The starter answers what a stopped run asked: the task goes back in line and its next run takes the answer.
  route(app, "POST /api/tasks/:id/answer", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { answer?: unknown } | null;
    const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
    if (!answer || answer.length > ANSWER_MAX) return c.json({ error: `answer is the words to send, at most ${ANSWER_MAX} characters` }, 400);
    if (!task.question || task.question.answer) return c.json({ error: "the task asks nothing now", code: "no-question" }, 409);
    if (task.status === "queued" || task.status === "running") return c.json({ error: `the task is ${task.status}`, code: "task-running" }, 409);
    if (task.runner !== "local") return c.json({ error: "a task this orchestrator runs on its own goes on from a new start", code: "runs-on-orchestrator" }, 409);
    const masked = maskedFollowUp(answer, null).text;
    await ctx.store.updateTask(ctx.tenant, task.id, { question: { ...task.question, answer: masked } });
    await goOn(ctx, task, `${user.name} answered the agent's question: ${masked}`);
    return c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, task.id))!], [], user))[0] });
  });

  // The starter sends a task to another folder: it stops where it is and starts again there, with the same words.
  route(app, "POST /api/tasks/:id/move", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    const opened = await openProject(ctx, user, fromHome(body?.path)).catch((err: Error) => err);
    if (opened instanceof Error) return c.json({ error: opened.message, code: opened instanceof AccountError ? opened.code : "folder-refused" }, 409);
    const moved = `Moved to ${opened.project.url}.`;
    if (task.runner === "local" && task.status === "running") {
      await ctx.store.requestStop(ctx.tenant, task.id, new Date().toISOString(), moved);
      ctx.runnerService?.wake();
    } else if (!FINISHED.includes(task.status)) {
      await runner.cancel(task.id);
      await ctx.store.updateTask(ctx.tenant, task.id, { error: moved });
    }
    const started = await startTask(ctx, runner, user, { repoId: opened.project.id, title: task.title, description: task.description, agent: task.agent, ...(task.issueUrl ? { issueUrl: task.issueUrl } : {}), ...(task.mode ? { mode: task.mode } : {}) });
    if ("error" in started) return c.json({ error: started.error, ...(started.code ? { code: started.code } : {}) }, started.status);
    const routing = { path: opened.project.url, reason: "", fallback: false };
    await ctx.store.updateTask(ctx.tenant, started.task.id, { routing });
    await ctx.store.appendTaskLog(ctx.tenant, started.task.id, [routingLine(routing)]);
    return c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, started.task.id))!], [], user))[0] });
  });

  // One piece of work's suggested skills, or several at once from a board, each an agent's run.
  // Every item counts against the person's minute, so a board's call spends what as many single calls would.
  const suggestionsAllowed = windowLimiter(SUGGESTIONS_PER_MINUTE);
  app.post("/api/tasks/skill-suggestions", async (c) => {
    const user = c.get("user");
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "send the work to suggest skills for" }, 400);
    const agent = typeof body.agent === "string" ? body.agent : "";
    if (!runner.agents().some((a) => a.id === agent)) return c.json({ error: "unknown agent" }, 400);
    const items = body.items === undefined ? null : Array.isArray(body.items) ? body.items : undefined;
    if (items === undefined || (items && (!items.length || items.length > MAX_BATCH || items.some((item) => !item || typeof item !== "object" || Array.isArray(item))))) {
      return c.json({ error: `items is a list of 1 to ${MAX_BATCH} pieces of work` }, 400);
    }
    const verdict = suggestionsAllowed(`${ctx.tenant}\0${user.id}`, items?.length ?? 1);
    if (!verdict.ok) return tooMany(c, verdict, `more than ${SUGGESTIONS_PER_MINUTE} skill suggestions in a minute; wait and try again`);
    if (!items) {
      const one = await suggestSkills(ctx, runner, user, agent, body);
      return "error" in one ? c.json({ error: one.error }, one.status) : c.json(one);
    }
    const results: ({ index: number } & ({ suggestions: SkillSuggestion[]; skills: { name: string; description: string }[] } | { error: string }))[] = [];
    await eachAtMost([...(items as Record<string, unknown>[]).entries()], SUGGESTIONS_AT_ONCE, async ([index, item]) => {
      const one = await suggestSkills(ctx, runner, user, agent, item);
      results.push({ index, ...("error" in one ? { error: one.error } : one) });
    });
    return c.json({ results: results.sort((a, b) => a.index - b.index) });
  });

  // Several issues at once, from a sprint board: each item is a start of its own, refused or
  // taken on its own, in order, so the budget a start reads counts the ones before it. They wait
  // in the organization's one queue like any other task.
  app.post("/api/tasks/batch", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { agent?: unknown; items?: unknown } | null;
    const items = Array.isArray(body?.items) ? body.items : null;
    if (!items || !items.length || items.length > MAX_BATCH || items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      return c.json({ error: `items is a list of 1 to ${MAX_BATCH} tasks to start` }, 400);
    }
    const user = c.get("user");
    const started: TaskRecord[] = [];
    const refused: { index: number; error: string; code?: string }[] = [];
    for (const [index, item] of (items as Record<string, unknown>[]).entries()) {
      const one = await startAnywhere(ctx, runner, user, { ...item, agent: body!.agent });
      if ("error" in one) refused.push({ index, error: one.error, ...(one.code ? { code: one.code } : {}) });
      else started.push(one.task);
    }
    return c.json({ started: await shown(started, [], user), refused });
  });

  // Where a word is in a task's log, across every page of it: the lines' numbers and their masked text, for a find row that jumps to them.
  app.get("/api/tasks/:id/find", async (c) => {
    const id = c.req.param("id");
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const words = (c.req.query("q") ?? "").trim();
    if (words.length < FIND_MIN || words.length > FIND_MAX) return c.json({ error: `find with ${FIND_MIN} to ${FIND_MAX} characters`, code: "bad-find" }, 400);
    const found = await ctx.store.findInTaskLog(ctx.tenant, id, words, FIND_LINES + 1);
    return c.json({ matches: found.slice(0, FIND_LINES).map((m) => ({ seq: m.seq, text: m.text.slice(0, FIND_TEXT) })), more: found.length > FIND_LINES });
  });

  app.get("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    // A finished task's log is its record, read in pages: `next` is where the next one starts.
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const all = await ctx.store.taskLog(ctx.tenant, id, after);
    const log = all.slice(0, LOG_PAGE);
    // Whether the agent's output was cut is the whole log's, whichever page is read: the cut line comes after the first pages.
    const whole = after === 0 ? all : await ctx.store.taskLog(ctx.tenant, id, 0);
    return c.json({ task: await withAsked((await shown([task], await requestsOf(task), c.get("user")))[0]!), log, outputCut: whole.some((l) => OUTPUT_CUT.test(l.text)), next: all.length > LOG_PAGE ? log.at(-1)!.seq : null });
  });

  // The same log as a stream: lines as they are written and the task when it changes, from
  // the store every orchestrators writes to, so a page follows a run whichever orchestrator runs it.
  // A page that cannot open one, or loses it, asks the route above as before.
  app.get("/api/tasks/:id/events", async (c) => {
    const id = c.req.param("id");
    const first = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!first || !readsTask(c.get("user"), first)) return c.json({ error: "unknown task" }, 404);
    const person = c.get("user").id;
    if (streams >= MAX_STREAMS || (streamsOf.get(person) ?? 0) >= STREAMS_PER_PERSON) return c.json({ error: "too many pages are following tasks; this page asks for the log instead" }, 503);
    const resumed = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0);
    let after = Number.isSafeInteger(resumed) && resumed > 0 ? resumed : 0;
    streams++;
    streamsOf.set(person, (streamsOf.get(person) ?? 0) + 1);
    return streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      try {
        await stream.writeSSE({ event: "connected", data: JSON.stringify({ after }), retry: STREAM_RETRY_MS });
        let shownAs = "";
        let quiet = 0;
        let checkedAt = Date.now();
        while (open) {
          if (Date.now() - checkedAt >= AUTH_RECHECK_MS) {
            if (!(await stillAuthorized(c, ctx.store, ctx.tenant, secureOrchestrator(ctx.publicUrl)))) break;
            checkedAt = Date.now();
          }
          const task = await ctx.store.getTask(ctx.tenant, id);
          // Read again each turn: a share taken back ends the page's stream at once, not when the task ends.
          if (!task || !readsTask(c.get("user"), task)) break;
          const lines = (await ctx.store.taskLog(ctx.tenant, id, after)).slice(0, STREAM_BATCH);
          if (lines.length) {
            after = lines[lines.length - 1]!.seq;
            await stream.writeSSE({ event: "log", id: String(after), data: JSON.stringify({ log: lines, outputCut: lines.some((l) => OUTPUT_CUT.test(l.text)) }) });
          }
          const view = JSON.stringify(await withAsked((await shown([task], await requestsOf(task), c.get("user")))[0]!));
          if (view !== shownAs) {
            shownAs = view;
            await stream.writeSSE({ event: "task", data: view });
          }
          // A finished task's log is complete once a read returns fewer lines than a batch.
          // An interrupted task writes nothing more until a Continue, whose run a page follows anew.
          // A run on a runner ends before its request opens; its stage says so until then.
          if ((FINISHED.includes(task.status) || task.status === "interrupted") && task.stage !== "request" && lines.length < STREAM_BATCH) break;
          quiet = lines.length ? 0 : quiet + STREAM_TICK_MS;
          if (quiet >= HEARTBEAT_MS) {
            quiet = 0;
            await stream.write(": heartbeat\n\n");
          }
          // A write here wakes the stream at once; one on another orchestrator is read at the next tick.
          if (lines.length < STREAM_BATCH) await nextTaskWrite(ctx.tenant, id, STREAM_TICK_MS);
        }
      } finally {
        streams--;
        const left = (streamsOf.get(person) ?? 1) - 1;
        if (left) streamsOf.set(person, left);
        else streamsOf.delete(person);
      }
    });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    if (!canEditTeam(c.get("user"), task.team)) return c.json({ error: "only an admin or this team's owner can cancel a task" }, 403);
    if (task.status !== "queued" && task.status !== "running" && task.status !== "interrupted") return c.json({ error: `the task is already ${task.status}` }, 409);
    const cancelled = (await runner.cancel(id))!;
    return c.json({ task: (await shown([cancelled], await requestsOf(cancelled), c.get("user")))[0] });
  });

  // The starter puts an interrupted task back in line: on a machine it goes on in the agent's own session there, and
  // a one-person orchestrator runs it again. The same commandId again gets the same answer and changes nothing.
  route(app, "POST /api/tasks/:id/continue", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { commandId?: unknown; approvePlan?: unknown; plan?: unknown; secondSignIn?: unknown } | null;
    if (typeof body?.commandId !== "string" || !COMMAND_ID.test(body.commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    // At its usage limit, a task on the person's own orchestrator goes on with their second sign-in only when they set one and click it.
    if (body.secondSignIn === true) {
      if (!(await ownCliHere(ctx))) return c.json({ error: "your Claude Code is reached only by an orchestrator on your own machine that you alone use", code: "not-own-machine" }, 409);
      if (!(await taskLimits(ctx.store, ctx.tenant)).secondSignIn) return c.json({ error: "no second sign-in is set; name it under Settings, Task limits", code: "no-second-sign-in" }, 409);
      if (task.status !== "interrupted" || !task.limitResetAt) return c.json({ error: "only a task stopped at its usage limit goes on with the second sign-in", code: "not-at-limit" }, 409);
      const holder = (await ctx.store.taskLease(ctx.tenant, id))?.claimedBy;
      if (holder && holder !== (await localMachineId(ctx.store, ctx.tenant))) return c.json({ error: "a task on another machine goes on with that machine's sign-in", code: "on-another-machine" }, 409);
      await ctx.store.updateTask(ctx.tenant, id, { secondSignIn: true });
    }
    const commandId = body.commandId;
    // The plan its run put to its starter and nobody answered before it stopped: approved here, it goes with the run that goes on.
    // The plan the page shows, as its person approves it, comes first: a run from before plans were kept left it in the log alone.
    if (body.plan !== undefined && (typeof body.plan !== "string" || !body.plan.trim() || body.plan.length > PLAN_TEXT_MAX)) return c.json({ error: `plan is the plan's text, at most ${PLAN_TEXT_MAX} characters` }, 400);
    const shownPlan = typeof body.plan === "string" ? { requestId: `shown-${commandId}`, text: maskedFollowUp(body.plan.trim(), null).text } : null;
    const plan = body.approvePlan === true ? (shownPlan ?? (await unansweredPlan(ctx, task))) : null;
    if (body.approvePlan === true && !plan) return c.json({ error: "the task holds no plan waiting for an answer", code: "no-plan" }, 409);
    const answer = async () => c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, id))!], await requestsOf(task), user))[0] });
    const answered = async () => {
      const receipt = await ctx.store.getReceipt(ctx.tenant, user.id, commandId);
      return receipt ? receipt.kind === CONTINUE_COMMAND && receipt.taskId === id : null;
    };
    const before = await answered();
    if (before) return answer();
    if (before === false) return c.json({ error: "that commandId already did something else", code: "command-reused" }, 409);
    const notInterrupted = (status: string) => c.json({ error: `the task is ${status}; only an interrupted task goes on`, code: "not-interrupted" }, 409);
    // A task that failed or was stopped with its plan unanswered goes back in line from that plan, on its starter's machine.
    if (plan && (task.status === "failed" || task.status === "cancelled")) {
      if (task.runner !== "local") return c.json({ error: "a task this orchestrator runs on its own goes on from a new start", code: "runs-on-orchestrator" }, 409);
      const refused = await goOnRefusal(ctx, user, task);
      if (refused) return c.json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}) }, refused.status);
      const kept = await ctx.store.addFollowUp({ tenant: ctx.tenant, id: newId("fup"), taskId: id, source: "person", key: `plan:${plan.requestId}`, text: approvedPlanText(user.name, plan.text), quotes: null, createdAt: new Date().toISOString(), createdBy: user.email });
      if (!kept.created) return answer();
      await ctx.store.updateTask(ctx.tenant, id, { planFirst: false });
      await ctx.store.appendTaskLog(ctx.tenant, id, [`${user.name} approved the plan the task put to them before it stopped:`, "## Plan", ...plan.text.split("\n")]);
      await goOn(ctx, task, `${user.name} asked the task to go on from the plan.`);
      await recordEvent(ctx, user, "task.continued", { repoId: task.repoId, subject: `task:${id}`, detail: "went on from the plan it put to its starter" });
      return answer();
    }
    if (task.status !== "interrupted") return notInterrupted(task.status);
    const holder = (await ctx.store.taskLease(ctx.tenant, id))?.claimedBy;
    const machine = holder ? (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === holder) : undefined;
    if (machine?.revokedAt) return c.json({ error: `${machine.name}, the machine it ran on, is disconnected, so it does not go on there; start it again`, code: "machine-gone" }, 409);
    if (!(await ctx.store.continueLocalTask(ctx.tenant, id, { actorId: user.id, commandId, kind: CONTINUE_COMMAND, result: "" }, new Date().toISOString()))) {
      // Two sends of one Continue at once: the one that lost finds the other's receipt.
      if (await answered()) return answer();
      return notInterrupted((await ctx.store.getTask(ctx.tenant, id))?.status ?? "gone");
    }
    await ctx.store.deleteSetting(ctx.tenant, autoContinuedKey(id));
    if (plan) {
      // The plan is approved, so the run that goes on works from it rather than planning again.
      await ctx.store.updateTask(ctx.tenant, id, { planFirst: false });
      await ctx.store.addFollowUp({ tenant: ctx.tenant, id: newId("fup"), taskId: id, source: "person", key: `plan:${plan.requestId}`, text: approvedPlanText(user.name, plan.text), quotes: null, createdAt: new Date().toISOString(), createdBy: user.email });
      await ctx.store.appendTaskLog(ctx.tenant, id, [`${user.name} approved the plan the task put to them before it stopped:`, "## Plan", ...plan.text.split("\n")]);
    }
    await ctx.store.appendTaskLog(ctx.tenant, id, [`${user.name} asked the task to go on where it stopped.`]);
    await recordEvent(ctx, user, "task.continued", { repoId: task.repoId, subject: `task:${id}`, detail: "continued an interrupted task" });
    ctx.runnerService?.wake();
    return answer();
  });

  // The second sign-in's folder is told to whoever sets it alone; anyone else reads only whether one is set.
  route(app, "GET /api/settings/task-limits", async (c) => {
    const { secondSignIn, ...limits } = await taskLimits(ctx.store, ctx.tenant);
    return c.json({ ...limits, ...(secondSignIn ? (manages(c.get("user")) ? { secondSignIn } : { secondSignInSet: true }) : {}) });
  });

  /**
   * The second sign-in a person names: a Claude Code profile folder of their own, in full, that is a folder and is not the
   * one their own Claude Code uses already. Only a person's own orchestrator takes one, and only from them signed in.
   * Null clears it; the folder is never read here, only handed to Claude Code as its profile.
   */
  async function secondSignInRefusal(ctx: OrchestratorContext, user: Principal, value: unknown): Promise<string | null | undefined | { error: string }> {
    if (value === undefined || value === null) return value;
    // The folder is the person's own Claude Code profile: only an orchestrator on their own machine that they alone use is told it.
    if (ctx.mode !== "local" || user.key || !(await ownCliHere(ctx))) return { error: "a second sign-in is set on a person's own orchestrator on their own machine, signed in" };
    if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\0\r\n]/.test(value)) return { error: "secondSignIn is the full path of a Claude Code profile folder" };
    const own = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    if (resolve(value) === own) return { error: "that is the profile your Claude Code uses already; name a second one" };
    if (!(await stat(value).then((s) => s.isDirectory(), () => false))) return { error: "no folder is at that path; sign in with that profile first, then name it" };
    return resolve(value);
  }

  route(app, "PUT /api/settings/task-limits", async (c) => {
    const user = c.get("user");
    if (!manages(user)) return c.json({ error: "only an owner or an admin sets a task's limits" }, 403);
    const body = (await c.req.json().catch(() => null)) as { maxUsd?: unknown; maxMinutes?: unknown; secondSignIn?: unknown } | null;
    const usd = body?.maxUsd;
    const minutes = body?.maxMinutes;
    const second = await secondSignInRefusal(ctx, user, body?.secondSignIn);
    if (typeof second === "object" && second) return c.json({ error: second.error }, 400);
    if (usd !== null && !(typeof usd === "number" && Number.isFinite(usd) && usd > 0 && usd <= TASK_LIMIT_USD_MAX)) return c.json({ error: `maxUsd is null or a number of dollars above 0 and at most ${TASK_LIMIT_USD_MAX}` }, 400);
    if (minutes !== null && !(typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 && minutes <= TASK_LIMIT_MINUTES_MAX)) return c.json({ error: `maxMinutes is null or a whole number of minutes above 0 and at most ${TASK_LIMIT_MINUTES_MAX}` }, 400);
    const kept = await taskLimits(ctx.store, ctx.tenant);
    const limits = { maxUsd: usd === null ? null : Math.round(usd * 100) / 100, maxMinutes: minutes, ...(body?.secondSignIn === undefined ? (kept.secondSignIn ? { secondSignIn: kept.secondSignIn } : {}) : second ? { secondSignIn: second } : {}) };
    await ctx.store.setSetting(ctx.tenant, TASK_LIMITS_SETTING, JSON.stringify(limits));
    await recordEvent(ctx, user, "settings.task-limits", { subject: "settings:task-limits", detail: `set a task's limits to ${limits.maxUsd === null ? "no cost limit" : `$${limits.maxUsd.toFixed(2)}`} and ${limits.maxMinutes === null ? "no time limit" : `${limits.maxMinutes} minutes`}` });
    return c.json(limits);
  });

  route(app, "GET /api/tasks/:id/requests", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    await ctx.store.expireTaskRequests(new Date().toISOString());
    return c.json({ requests: await shownRequests(ctx, await ctx.store.taskRequests(ctx.tenant, id)) });
  });

  // What the agent asked is answered by the person it runs as, from their own signed-in browser:
  // the answer allows what that person's task does next, so no key and no teammate gives it.
  route(app, "POST /api/tasks/:id/requests/:request", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task)) return c.json({ error: "unknown task" }, 404);
    // Anyone else is told no such request exists: its id says nothing to a reader who cannot answer it.
    if (task.createdBy !== user.email && task.createdBy !== user.id) return c.json({ error: "unknown request" }, 404);
    const asked = (await ctx.store.taskRequests(ctx.tenant, id)).find((r) => r.id === c.req.param("request"));
    if (!asked) return c.json({ error: "unknown request" }, 404);
    const body = (await c.req.json().catch(() => null)) as { answer?: unknown } | null;
    const answer = body?.answer;
    const problem = answer && typeof answer === "object" && !Array.isArray(answer) ? answerProblem(asked, answer as TaskAnswer) : { code: "answer-shape", message: "send the answer" };
    if (problem) return c.json({ error: problem.message, code: problem.code }, 400);
    // A secret is given only with its value, on its card, which seals the value in the vault before it answers.
    if (asked.kind === "secret" && (answer as { provided?: boolean }).provided) return c.json({ error: "a secret is given on its card, with its value", code: "secret-on-card" }, 400);
    const answered = await ctx.store.answerTaskRequest(ctx.tenant, asked.id, answer as TaskAnswer, user.email, "web", new Date().toISOString());
    if (!answered) return c.json({ error: "this request is no longer waiting for an answer" }, 409);
    // The runner waiting in a long poll hears the answer now, not at its next look at the store.
    ctx.runnerService?.wake();
    const given = "decision" in answered.answer! ? answered.answer.decision : "answers" in answered.answer! ? "an answer" : "a decline";
    await recordEvent(ctx, user, "task.request.answered", { repoId: task.repoId, subject: `task:${task.id}`, detail: `answered the agent's ${asked.kind} request with ${given}` });
    return c.json({ request: (await shownRequests(ctx, [answered]))[0] });
  });

  /** The folder a task worked on in place and its two snapshots, or null for a task that changed none. */
  const changedFolder = async (task: TaskRecord) => {
    const snaps = await ctx.store.taskChangeSnapshots(ctx.tenant, task.id);
    const repo = snaps ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
    return snaps && repo ? { ...snaps, repo, place: shadowPlaceOf(ctx, repo), onMachine: Boolean(machineFolderOf(repo.url)) } : null;
  };
  // A folder on a person's machine keeps its record there: its files are read and undone on that machine.
  const onMachine = (c: Context<OrchestratorEnv>) => c.json({ error: "this task's change is in a folder of its person's machine; its files are read there, not here", code: "changes-on-machine" }, 409);

  // A task's turns, each named by the person's own words, for the Changes section's Select; none where no turn was kept.
  route(app, "GET /api/tasks/:id/turns", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const turns = (await ctx.store.taskTurns(ctx.tenant, task.id)).filter((t) => t.end !== null);
    const started = await Promise.all(turns.map((t) => ctx.store.getSetting(ctx.tenant, `turn-new-task:${task.id}:${t.n}`)));
    return c.json({ turns: turns.map((t, i) => ({ n: t.n, said: t.said, at: t.at, files: t.files, undone: t.undoneAt !== null, ...(started[i] ? { newTaskId: started[i] } : {}) })) });
  });

  // What one turn changed, in the shape a request's changes are shown in.
  route(app, "GET /api/tasks/:id/turns/:n/changes", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const turn = (await ctx.store.taskTurns(ctx.tenant, task.id)).find((t) => t.n === Number(c.req.param("n")));
    const repo = turn?.end ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
    if (!turn?.end || !repo) return c.json({ error: "unknown turn" }, 404);
    if (turn.place === "machine") return onMachine(c);
    const changes = await shadowChanges(placeOfTurn(ctx, turn, repo), turn.start, turn.end);
    return typeof changes === "string" ? c.json({ error: changes }, 409) : c.json({ changes });
  });

  // The starter undoes a turn and every one after it: the files go back to how that turn found them, the conversation stays.
  // A folder without git is undone in place, held as an undo is; a request gets one commit on its branch, never a forced one.
  route(app, "POST /api/tasks/:id/turns/:n/undo", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const found = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!found || !seesTask(user, found) || (found.createdBy !== user.email && found.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { commandId?: unknown; reason?: unknown } | null;
    if (typeof body?.commandId !== "string" || !COMMAND_ID.test(body.commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > UNDO_REASON_MAX || /[\r\n]/.test(body.reason))) return c.json({ error: `reason is one line of at most ${UNDO_REASON_MAX} characters` }, 400);
    const reason = typeof body.reason === "string" && body.reason.trim() ? new Redactor([]).line(printable(body.reason.trim())) : null;
    return oneAtATime(settleKey(found.id), async () => {
      const task = (await ctx.store.getTask(ctx.tenant, found.id))!;
      if (task.status === "queued" || task.status === "running") return c.json({ error: "the task is still working; undo a turn once it ends", code: "task-running" }, 409);
      const turns = (await ctx.store.taskTurns(ctx.tenant, task.id)).filter((t) => t.end !== null);
      const turn = turns.find((t) => t.n === Number(c.req.param("n")));
      const last = turns.at(-1);
      const repo = await ctx.store.getRepo(ctx.tenant, task.repoId);
      if (!turn || !last || !repo) return c.json({ error: "unknown turn" }, 404);
      if (turn.undoneAt) return c.json({ error: "this turn was already undone", code: "already-undone" }, 409);
      const after = turns.filter((t) => t.n > turn.n && !t.undoneAt).length;
      const said = `“${turn.said}”`;
      const done = async (back: number, where: string) => {
        await ctx.store.undoTaskTurns(ctx.tenant, task.id, turn.n, new Date().toISOString());
        await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} undid the change from ${said} on${after ? `, and the ${after} turn(s) after it` : ""}: ${back} file(s) back ${where}.${reason ? ` Why: ${reason}` : ""}`]);
        await recordEvent(ctx, user, "task.turns.undone", { repoId: task.repoId, subject: `task:${task.id}`, detail: `undid from turn ${turn.n}, ${back} file(s)${reason ? `: ${reason}` : ""}` });
        return c.json({ turns: (await ctx.store.taskTurns(ctx.tenant, task.id)).filter((t) => t.end !== null).map((t) => ({ n: t.n, said: t.said, at: t.at, files: t.files, undone: t.undoneAt !== null })) });
      };
      if (turn.place === "machine") {
        const folder = await changedFolder(task);
        if (!folder?.onMachine) return c.json({ error: "this task's turns are not kept on a machine", code: "not-undoable" }, 409);
        if (task.changes?.undone) return c.json({ error: "this task's changes were already undone", code: "already-undone" }, 409);
        if (task.changes?.kept) return c.json({ error: "this task's changes were kept, so they are not undone", code: "already-kept" }, 409);
        const at = machineFolderOf(repo.url)!;
        const machine = (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === at.machineId);
        // A runner from before turns would ignore which turn and undo the whole change.
        if (!machine?.features?.includes("turn-undo")) return c.json({ error: `${machine?.name ?? "Its machine"} runs a runner that undoes a whole change only; update it to undo from a turn`, code: "machine-too-old" }, 409);
        const undone = await undoOnMachine(ctx, repo, folder, { start: turn.start, end: last.end! });
        if ("refused" in undone) return c.json({ error: undone.refused, code: undone.code }, undone.status);
        if (undone.left && undone.after && undone.files) await ctx.store.setTaskChanges(ctx.tenant, task.id, { files: undone.files, undone: null, before: folder.before, after: undone.after });
        else await ctx.store.markTaskChangesUndone(ctx.tenant, task.id, { at: new Date().toISOString(), by: user.email, kept: undone.kept, ...(reason ? { reason } : {}) });
        return await done(undone.undone.length, `in ${repo.name} on ${machine.name}${undone.kept.length ? `, except ${undone.kept.join(", ")}, changed again since` : ""}`);
      }
      if (turn.place === "project") {
        const folder = await changedFolder(task);
        if (!folder || folder.onMachine) return c.json({ error: "this task's turns are not kept here", code: "not-undoable" }, 409);
        if (task.changes?.undone) return c.json({ error: "this task's changes were already undone", code: "already-undone" }, 409);
        if (task.changes?.kept) return c.json({ error: "this task's changes were kept, so they are not undone", code: "already-kept" }, 409);
        const holder = `undo:${task.id}`;
        if (!(await ctx.store.takeProjectLock(ctx.tenant, repo.id, holder, new Date().toISOString()))) return c.json({ error: `a task is working in ${repo.name} now; undo this one when it ends`, code: "folder-busy" }, 409);
        try {
          const undone = await shadowUndo(folder.place, turn.start, folder.after);
          if ("refused" in undone) return c.json({ error: undone.refused, code: "undo-refused" }, 409);
          // The task's change is what is left of it: from where it started to the folder as the undo leaves it.
          const now = await shadowSnapshot(folder.place, `after undoing ${task.id} from turn ${turn.n}`);
          if ("refused" in now) return c.json({ error: now.refused, code: "undo-refused" }, 409);
          const left = await shadowChanges(folder.place, folder.before, now.sha);
          if (typeof left === "string") return c.json({ error: left, code: "undo-refused" }, 409);
          if (left.files.length || left.untracked.length) await ctx.store.setTaskChanges(ctx.tenant, task.id, { files: left.files, undone: null, before: folder.before, after: now.sha });
          else await ctx.store.markTaskChangesUndone(ctx.tenant, task.id, { at: new Date().toISOString(), by: user.email, kept: undone.kept, ...(reason ? { reason } : {}) });
          return await done(undone.undone.length, `in ${repo.name}${undone.kept.length ? `, except ${undone.kept.join(", ")}, changed again since` : ""}`);
        } finally {
          await ctx.store.releaseProjectLock(ctx.tenant, repo.id, holder);
        }
      }
      const request = task.requestNumber !== null ? await ctx.store.getRequest(ctx.tenant, repo.id, task.requestNumber) : null;
      if (request?.status !== "open") return c.json({ error: "this task's request is not open, so its turns are not undone on it", code: "request-not-open" }, 409);
      const files = await filesAsAt(placeOfTurn(ctx, turn, repo), turn.start, last.end!);
      if ("refused" in files) return c.json({ error: files.refused, code: "undo-refused" }, 409);
      if (!files.length) return await done(0, `on request #${request.number}`);
      const synced = await syncRepo(ctx, repo.id);
      if ("error" in synced) return c.json({ error: `the repository could not be read to undo the turn (${maskUrl(synced.error)})` }, 502);
      const head = await branchHead(mirrorDir(ctx, repo.id), request.branch);
      if (!head) return c.json({ error: `${request.branch} is no longer on the repository`, code: "moved" }, 409);
      let moved: { headSha: string };
      try {
        moved = await updateRequestBranch(ctx, repo, request.branch, { files, title: `Undo the change from ${said} on`, commitBody: `Undone by the TeamHandbook Orchestrator for task ${task.id}, at its starter's ask.`, author: { name: user.name, email: user.email }, expectedHead: head });
      } catch (err) {
        return c.json({ error: (err as Error).message, code: "moved" }, 409);
      }
      await recheckRequest(ctx, repo, request, moved.headSha);
      return await done(files.length, `on request #${request.number}`);
    });
  });

  // A new task from one turn of this one: the same ask, worked from the files as that turn left them; this task stays.
  route(app, "POST /api/tasks/:id/turns/:n/new-task", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { commandId?: unknown; text?: unknown } | null;
    if (typeof body?.commandId !== "string" || !COMMAND_ID.test(body.commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    if (body.text !== undefined && (typeof body.text !== "string" || body.text.length > MESSAGE_MAX)) return c.json({ error: `text is at most ${MESSAGE_MAX} characters` }, 400);
    const key = `new-from-turn:${task.id}:${body.commandId}`;
    const made = await ctx.store.getSetting(ctx.tenant, key);
    if (made) return c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, made))!], [], user))[0] }, 200);
    const turn = (await ctx.store.taskTurns(ctx.tenant, task.id)).find((t) => t.n === Number(c.req.param("n")));
    if (!turn?.end) return c.json({ error: "unknown turn" }, 404);
    if (turn.place !== "task") return c.json({ error: "a folder has one state at a time, so a new task does not start from its turn; undo from that turn instead", code: "not-from-turn" }, 409);
    const text = typeof body.text === "string" && body.text.trim() ? maskedFollowUp(body.text.trim(), null).text : "";
    const description = [task.description, ...(text ? ["", text] : [])].join("\n").trim();
    const started = await startTask(ctx, runner, user, { repoId: task.repoId, title: task.title, description, agent: task.agent, mode: task.mode, ...(task.issueUrl ? { issueUrl: task.issueUrl } : {}), ...(task.baseBranch ? { baseBranch: task.baseBranch } : {}) }, undefined, { taskId: task.id, n: turn.n });
    if ("error" in started) return c.json({ error: started.error, ...(started.code ? { code: started.code } : {}) }, started.status);
    await ctx.store.setSetting(ctx.tenant, key, started.task.id);
    await ctx.store.setSetting(ctx.tenant, `turn-new-task:${task.id}:${turn.n}`, started.task.id);
    await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} started task ${started.task.id} from the change as “${turn.said}” left it.`]);
    await ctx.store.appendTaskLog(ctx.tenant, started.task.id, [{ text: `Started from “${turn.said}” in ${task.title}`, kind: "started-from", data: { type: "started-from", taskId: task.id, n: turn.n } }]);
    return c.json({ task: (await shown([started.task], [], user))[0] }, 201);
  });

  // What a task in a folder without git changed there, in the shape a request's changes are shown in.
  route(app, "GET /api/tasks/:id/changes", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const folder = await changedFolder(task);
    if (!folder) return c.json({ error: "this task changed no folder" }, 404);
    if (folder.onMachine) return onMachine(c);
    const changes = await shadowChanges(folder.place, folder.before, folder.after);
    return typeof changes === "string" ? c.json({ error: changes }, 409) : c.json({ changes });
  });

  // One changed file's patch, masked, when the screen opens it.
  route(app, "GET /api/tasks/:id/changes/:path{.+}", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const folder = await changedFolder(task);
    if (folder?.onMachine) return onMachine(c);
    const file = folder ? await shadowFile(folder.place, folder.before, folder.after, c.req.param("path") ?? "") : null;
    if (file === null) return c.json({ error: "this task did not change that file" }, 404);
    return typeof file === "string" ? c.json({ error: file }, 409) : c.json({ file });
  });

  // One file's patch within one turn, masked as a change's file is, when the Select has a turn picked.
  route(app, "GET /api/tasks/:id/turns/:n/changes/:path{.+}", async (c) => {
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !readsTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    const turn = (await ctx.store.taskTurns(ctx.tenant, task.id)).find((t) => t.n === Number(c.req.param("n")));
    const repo = turn?.end ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
    if (!turn?.end || !repo) return c.json({ error: "unknown turn" }, 404);
    if (turn.place === "machine") return onMachine(c);
    const file = await shadowFile(placeOfTurn(ctx, turn, repo), turn.start, turn.end, c.req.param("path") ?? "");
    if (file === null) return c.json({ error: "this turn did not change that file" }, 404);
    return typeof file === "string" ? c.json({ error: file }, 409) : c.json({ file });
  });

  /** Why a second settling of a task's changes is refused, by what the first one did. */
  // Keep, Undo and a turn's undo of one task run one after another, each reading how the task stands once the one
  // before is done. Pressed at once in two windows, an undo used to take the files back while the keep was written:
  // the page said kept and the folder had lost the change.
  const settleKey = (id: string) => join(ctx.dataDir, "task-settles", ctx.tenant, id);
  const settledAs = async (id: string) =>
    (await ctx.store.getTask(ctx.tenant, id))?.changes?.kept ? { error: "this task's changes were kept, so they are not undone", code: "already-kept" } : { error: "this task's changes were already undone", code: "already-undone" };

  // The starter keeps a finished task's changes in the folder, once: the task is settled, and its
  // changes are no longer undone from here; the person still edits the folder as they like.
  // One file taken out of a task's open request, from a signed-in browser: by its starter or one who edits its team, never a
  // key or a reader it was shared with. The orchestrator commits the file back as the task's base held it, and the new
  // head is held to the team's rules again before the request merges.
  route(app, "POST /api/tasks/:id/request/drop", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id && !canEditTeam(user, task.team))) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { path?: unknown } | null;
    const path = typeof body?.path === "string" ? body.path : "";
    if (!path || path.length > DROP_PATH_MAX) return c.json({ error: `path is the file's path in the repository, at most ${DROP_PATH_MAX} characters` }, 400);
    if (task.status === "queued" || task.status === "running") return c.json({ error: "the task is still working on its request; take a file out once it ends", code: "task-running" }, 409);
    const repo = await ctx.store.getRepo(ctx.tenant, task.repoId);
    const request = repo && task.requestNumber !== null ? await ctx.store.getRequest(ctx.tenant, repo.id, task.requestNumber) : null;
    if (!repo || !request || request.status !== "open" || !task.baseSha) return c.json({ error: "this task has no open request to take a file out of", code: "request-not-open" }, 409);
    const synced = await syncRepo(ctx, repo.id);
    if ("error" in synced) return c.json({ error: `the repository could not be read to take the file out (${maskUrl(synced.error)})` }, 502);
    const mirror = mirrorDir(ctx, repo.id);
    const head = (await gitAsyncMaybe(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], mirror))?.trim();
    if (!head) return c.json({ error: `${request.branch} is no longer on the repository`, code: "moved" }, 409);
    const dropped = await dropFromRequest(ctx, repo, { branch: request.branch, path, baseSha: task.baseSha, expectedHead: head });
    if ("refused" in dropped) return c.json({ error: dropped.refused, code: dropped.code }, dropped.code === "refused" ? 400 : 409);
    await recheckRequest(ctx, repo, request, dropped.head);
    const masked = await taskMask(ctx, task);
    await ctx.store.appendTaskLog(ctx.tenant, task.id, [masked(`${user.name} took ${path} out of request #${request.number}: the file is back as the task's base held it, at ${dropped.head.slice(0, 7)}.`)]);
    await recordEvent(ctx, user, "task.request.file-dropped", { repoId: repo.id, subject: `request:${request.number}`, detail: masked(`took ${path} out of request #${request.number} from the task's page`) });
    return c.json({ head: dropped.head });
  });

  route(app, "POST /api/tasks/:id/keep", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const found = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!found || !seesTask(user, found) || (found.createdBy !== user.email && found.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { commandId?: unknown } | null;
    if (typeof body?.commandId !== "string" || !COMMAND_ID.test(body.commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    return oneAtATime(settleKey(found.id), async () => {
      const task = (await ctx.store.getTask(ctx.tenant, found.id))!;
      if (task.status === "queued" || task.status === "running") return c.json({ error: "the task is still working in the folder; keep its changes once it ends", code: "task-running" }, 409);
      if (!(await ctx.store.taskChangeSnapshots(ctx.tenant, task.id))) return c.json({ error: "this task changed no folder, so there is nothing to keep", code: "not-undoable" }, 409);
      if (task.changes?.undone) return c.json({ error: "this task's changes were already undone", code: "already-undone" }, 409);
      if (task.changes?.kept) return c.json({ error: "this task's changes were already kept", code: "already-kept" }, 409);
      if (!(await ctx.store.markTaskChangesKept(ctx.tenant, task.id, { at: new Date().toISOString(), by: user.email }))) return c.json(await settledAs(task.id), 409);
      await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} kept the task's changes.`]);
      await recordEvent(ctx, user, "task.changes.kept", { repoId: task.repoId, subject: `task:${task.id}`, detail: `kept ${task.changes?.files.length ?? 0} changed file(s)` });
      return c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, task.id))!], [], c.get("user")))[0] });
    });
  });

  // The starter takes a finished task's changes back out of the folder, once. A file changed again
  // since the task is kept as it is; the folder is held while it is undone, so no task runs in it meanwhile.
  route(app, "POST /api/tasks/:id/undo", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const found = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!found || !seesTask(user, found) || (found.createdBy !== user.email && found.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { commandId?: unknown; paths?: unknown; reason?: unknown } | null;
    if (typeof body?.commandId !== "string" || !COMMAND_ID.test(body.commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > UNDO_REASON_MAX || /[\r\n]/.test(body.reason))) return c.json({ error: `reason is one line of at most ${UNDO_REASON_MAX} characters` }, 400);
    const reason = typeof body.reason === "string" && body.reason.trim() ? new Redactor([]).line(printable(body.reason.trim())) : null;
    return oneAtATime(settleKey(found.id), async () => {
      const task = (await ctx.store.getTask(ctx.tenant, found.id))!;
      const files = task.changes?.files ?? [];
      const picked = body.paths === undefined ? null : Array.isArray(body.paths) && body.paths.length && body.paths.every((p) => typeof p === "string" && files.some((f) => f.path === p && f.state !== "undone")) ? (body.paths as string[]) : undefined;
      if (picked === undefined) return c.json({ error: "paths names files this task changed that are not undone yet", code: "unknown-path" }, 400);
      if (task.status === "queued" || task.status === "running") return c.json({ error: "the task is still working in the folder; undo it once it ends", code: "task-running" }, 409);
      const folder = await changedFolder(task);
      if (!folder) return c.json({ error: "this task changed no folder, so there is nothing to undo", code: "not-undoable" }, 409);
      if (task.changes?.undone) return c.json({ error: "this task's changes were already undone", code: "already-undone" }, 409);
      if (task.changes?.kept) return c.json({ error: "this task's changes were kept, so they are not undone", code: "already-kept" }, 409);
      const holder = `undo:${task.id}`;
      if (!(await ctx.store.takeProjectLock(ctx.tenant, folder.repo.id, holder, new Date().toISOString()))) return c.json({ error: `a task is working in ${folder.repo.name} now; undo this one when it ends`, code: "folder-busy" }, 409);
      try {
        if (picked && folder.onMachine) return c.json({ error: "a folder on a machine is undone whole for now; undo all of the task's changes or keep them", code: "machine-undo-whole" }, 409);
        // A renamed file goes back with the name it had, so undoing it takes both paths of the rename.
        const only = picked ? new Set(picked.flatMap((p) => [p, ...(files.find((f) => f.path === p)?.previousPath ?? [])])) : undefined;
        const undone = folder.onMachine ? await undoOnMachine(ctx, folder.repo, folder) : await shadowUndo(folder.place, folder.before, folder.after, only);
        if ("refused" in undone) {
          const { code = "undo-refused", status = 409 } = undone as { code?: string; status?: 409 | 502 | 504 };
          return c.json({ error: undone.refused, code }, status);
        }
        const record = { at: new Date().toISOString(), by: user.email, kept: undone.kept, ...(reason ? { reason } : {}) };
        const marked = picked ? await ctx.store.markTaskFilesUndone(ctx.tenant, task.id, picked.filter((p) => !undone.kept.includes(p)), record) : await ctx.store.markTaskChangesUndone(ctx.tenant, task.id, record);
        if (!marked) return c.json(await settledAs(task.id), 409);
        const what = picked ? picked.join(", ") : "the task's changes";
        await ctx.store.appendTaskLog(ctx.tenant, task.id, [`${user.name} undid ${what} in ${folder.repo.name}${undone.kept.length ? `, except ${undone.kept.join(", ")}, changed again since` : ""}.${reason ? ` Why: ${reason}` : ""}`]);
        await recordEvent(ctx, user, "task.changes.undone", { repoId: task.repoId, subject: `task:${task.id}`, detail: `undid ${undone.undone.length} file(s) in ${folder.repo.name}${reason ? `: ${reason}` : ""}` });
        const now = (await ctx.store.getTask(ctx.tenant, task.id))!;
        return c.json({ task: (await shown([now], [], c.get("user")))[0], undone: undone.undone, kept: undone.kept });
      } finally {
        await ctx.store.releaseProjectLock(ctx.tenant, folder.repo.id, holder);
      }
    });
  });

  // The starter stops what the agent is doing now; the task and its session stay, and their next words go on from there.
  route(app, "POST /api/tasks/:id/stop-step", async (c) => {
    const task = await startersTask(c);
    if (!task) return c.json({ error: "unknown task" }, 404);
    if (task.status !== "running") return c.json({ error: "the task is not working now, so there is no step to stop", code: "not-running" }, 409);
    if (task.stage === "stopped") return c.json({ task: (await shown([task], await requestsOf(task), c.get("user")))[0] });
    if (!(await runner.stopStep(task.id))) return c.json({ error: "this task's agent is not in a session it can be stopped in and told more; stop the task instead", code: "no-session" }, 409);
    return c.json({ task: (await shown([(await ctx.store.getTask(ctx.tenant, task.id))!], await requestsOf(task), c.get("user")))[0] });
  });

  // The starter's follow-up to a task's agent, from their own signed-in browser: it steers what the
  // agent does next, so no key, no teammate and no tool sends it. One commandId is one message.
  route(app, "POST /api/tasks/:id/messages", async (c) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    if (!task || !seesTask(user, task) || (task.createdBy !== user.email && task.createdBy !== user.id)) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; quotes?: unknown; commandId?: unknown; attachments?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MESSAGE_MAX) return c.json({ error: `a follow-up is 1 to ${MESSAGE_MAX} characters`, code: "message-too-long" }, 400);
    const commandId = typeof body?.commandId === "string" ? body.commandId : "";
    if (!COMMAND_ID.test(commandId)) return c.json({ error: "commandId is 8 to 64 letters, digits, dashes or underscores, the same on a retry" }, 400);
    const quotes = readQuotes(body?.quotes);
    if (quotes && "error" in quotes) return c.json({ error: quotes.error, code: "quote-outside-request" }, 400);
    const files = await followUpAttachments(ctx, task.id, body?.attachments);
    if (!files) return c.json({ error: "attachments names files uploaded to this task, each once", code: "attachment-unknown" }, 400);
    const request = task.requestNumber !== null ? await ctx.store.getRequest(ctx.tenant, task.repoId, task.requestNumber) : null;
    const offered = offeredFollowUp(runner, task, request, inWorkspace(task) && (await workspaceGoesOn(ctx, task)));
    const masked = maskedFollowUp(text, quotes);
    if (!offered) {
      // The same message sent again, as a retry is, was taken the first time: it is answered as taken, whatever the task takes now.
      const before = (await ctx.store.taskFollowUps(ctx.tenant, task.id)).find((f) => f.key === `person:${commandId}`);
      if (before && before.text === masked.text) return c.json({ followUp: { id: before.id, status: before.status, createdAt: before.createdAt } }, 200);
      return c.json({ error: NO_FOLLOW_UP, code: "follow-up-not-offered" }, 409);
    }
    if (offered === "continue") {
      const refused = await goOnRefusal(ctx, user, task);
      if (refused) return c.json({ error: refused.error, ...(refused.code ? { code: refused.code } : {}) }, refused.status);
    }
    let kept;
    try {
      kept = await ctx.store.addFollowUp({ tenant: ctx.tenant, id: newId("fup"), taskId: task.id, source: "person", key: `person:${commandId}`, text: masked.text, quotes: masked.quotes, createdAt: new Date().toISOString(), createdBy: user.email, ...(files.length ? { attachments: files } : {}) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!kept.created && (kept.followUp.text !== masked.text || JSON.stringify(kept.followUp.quotes) !== JSON.stringify(masked.quotes) || JSON.stringify(kept.followUp.attachments ?? []) !== JSON.stringify(files))) {
      return c.json({ error: "that commandId already sent another follow-up", code: "command-reused" }, 409);
    }
    if (kept.created) await recordEvent(ctx, user, "task.followup", { repoId: task.repoId, subject: `task:${task.id}`, detail: `sent a follow-up of ${masked.text.length} characters${masked.quotes ? ` with ${masked.quotes.length} quote(s)` : ""}` });
    // Words written to a task that ended asking are the answer to what it asked: the next run is told the question and
    // the answer once, so the message is marked as having reached the agent and is not sent a second time beside them.
    if (kept.created && endedAsking(task)) {
      await ctx.store.updateTask(ctx.tenant, task.id, { question: { ...task.question!, answer: masked.text } });
      await ctx.store.markFollowUpsDelivered(ctx.tenant, [kept.followUp.id], new Date().toISOString());
      await goOn(ctx, task, `${user.name} answered the agent's question: ${masked.text}`);
      return c.json({ followUp: { id: kept.followUp.id, status: "delivered", createdAt: kept.followUp.createdAt } }, 202);
    }
    // Only the message that takes the task out of review puts it back in line; a retry, or more words while it waits, queue nothing.
    if (kept.created && offered === "continue" && task.status !== "queued") {
      const from = request?.status === "merged" ? `; the task goes on from the change kept in request #${request.number}, on a branch of its own` : task.requestNumber !== null ? ` on request #${task.requestNumber}; the task goes on from its branch` : inPlaceReview(task) ? "; the task goes on in the folder from the files as it left them" : task.status === "nothing-changed" ? "; the task goes on from where it worked, with the agent's answer" : "; the task goes on in each repository from what it left";
      if (await goesOnAfterKeep(ctx, task, request)) await ctx.store.updateTask(ctx.tenant, task.id, { keptBefore: true });
      await goOn(ctx, task, `${user.name} asked for more${from}.`);
    }
    return c.json({ followUp: { id: kept.followUp.id, status: kept.followUp.status, createdAt: kept.followUp.createdAt } }, kept.created ? 202 : 200);
  });

  /** The task its starter sends words to, or the answer that refuses them: nobody else changes what the agent is told. */
  const startersTask = async (c: Context<OrchestratorEnv>) => {
    const user = c.get("user");
    const id = c.req.param("id") ?? "";
    const task = isTaskId(id) ? await ctx.store.getTask(ctx.tenant, id) : null;
    return task && seesTask(user, task) && (task.createdBy === user.email || task.createdBy === user.id) ? task : null;
  };
  const MESSAGE_GONE = { error: "that message already reached the agent or was taken back", code: "message-not-waiting" };

  route(app, "PATCH /api/tasks/:id/messages/:messageId", async (c) => {
    const task = await startersTask(c);
    if (!task) return c.json({ error: "unknown task" }, 404);
    const body = (await c.req.json().catch(() => null)) as { text?: unknown; quotes?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MESSAGE_MAX) return c.json({ error: `a follow-up is 1 to ${MESSAGE_MAX} characters`, code: "message-too-long" }, 400);
    const quotes = readQuotes(body?.quotes);
    if (quotes && "error" in quotes) return c.json({ error: quotes.error, code: "quote-outside-request" }, 400);
    const masked = maskedFollowUp(text, quotes);
    // A body without quotes changes the words alone; one with them, null included, sets them too.
    const withQuotes = body !== null && "quotes" in body;
    let changed;
    try {
      changed = await ctx.store.editFollowUp(ctx.tenant, task.id, c.req.param("messageId") ?? "", masked.text, withQuotes ? masked.quotes : undefined);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    if (!changed) return c.json(MESSAGE_GONE, 409);
    await recordEvent(ctx, c.get("user"), "task.followup", { repoId: task.repoId, subject: `task:${task.id}`, detail: `changed a waiting follow-up to ${masked.text.length} characters` });
    const now = (await ctx.store.pendingFollowUps(ctx.tenant, task.id)).find((f) => f.id === c.req.param("messageId"));
    return c.json({ message: { id: c.req.param("messageId"), text: masked.text, quotes: now?.quotes ?? masked.quotes } });
  });

  route(app, "DELETE /api/tasks/:id/messages/:messageId", async (c) => {
    const task = await startersTask(c);
    if (!task) return c.json({ error: "unknown task" }, 404);
    if (!(await ctx.store.dropFollowUp(ctx.tenant, task.id, c.req.param("messageId") ?? ""))) return c.json(MESSAGE_GONE, 409);
    await recordEvent(ctx, c.get("user"), "task.followup", { repoId: task.repoId, subject: `task:${task.id}`, detail: "took back a waiting follow-up" });
    return c.json({ removed: true });
  });

  return app;
}

/** The longest line a person says why they undid a change in. */
const UNDO_REASON_MAX = 300;

/** The longest path a request's file is taken out by. */
const DROP_PATH_MAX = 1024;

/**
 * A task in review goes on only from a request still open: one merged or closed takes no more. A task on a folder of
 * repositories goes on when `workspaceOpen` says it can (workspaceGoesOn).
 */
/**
 * Whether a task ended asking its starter something they have not answered, where their answer sends it on: a run that
 * stopped to ask is no failure to them, and what they write in the task's own box is the answer.
 */
export const endedAsking = (task: TaskRecord): boolean => Boolean(task.question && !task.question.answer) && task.status !== "queued" && task.status !== "running" && task.runner === "local";

export function offeredFollowUp(runner: TaskRunner, task: TaskRecord, request: RequestRecord | null | undefined, workspaceOpen = false): FollowUpOffer {
  if (endedAsking(task)) return "continue";
  const offered = runner.followUp(task);
  if (offered !== "continue") return offered;
  // A request kept goes on as one in review does: the next round starts from the repository that holds the kept change.
  return (task.requestNumber !== null ? request?.status === "open" || request?.status === "merged" : inPlaceReview(task) || task.status === "nothing-changed" || workspaceOpen) ? "continue" : null;
}

/**
 * Whether a task on a folder of repositories goes on from what it left: a change still kept on its machine or a request
 * still open, and a runner that starts each copy there: this orchestrator's own, or a machine's that says it does. A
 * machine's runner from before that would start them from their HEAD, so it is offered none.
 */
export async function workspaceGoesOn(ctx: OrchestratorContext, task: TaskRecord): Promise<boolean> {
  if (task.runner !== "local" || !inWorkspace(task)) return false;
  const holder = (await ctx.store.taskLease(ctx.tenant, task.id))?.claimedBy;
  // This orchestrator's own runner goes on as its run here does; a person's machine only when its runner says so.
  const own = holder !== undefined && holder !== null && holder === (await localMachineId(ctx.store, ctx.tenant));
  const machine = holder && !own ? (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === holder) : undefined;
  if (!own && !machine?.features?.includes("workspace-continues")) return false;
  for (const target of task.targets ?? []) {
    if (target.path === undefined) continue;
    if (target.status === "local" && target.head) return true;
    // A request still open goes on from its head; one kept goes on from the repository's HEAD, which holds it.
    const status = target.status === "request" && target.requestNumber !== null ? (await ctx.store.getRequest(ctx.tenant, target.repoId, target.requestNumber))?.status : undefined;
    if (status === "open" || status === "merged") return true;
  }
  return false;
}

/** Whether a task goes on from a change its person kept, in its request, its folder or one of its repositories. */
async function goesOnAfterKeep(ctx: OrchestratorContext, task: TaskRecord, request: RequestRecord | null): Promise<boolean> {
  if (request?.status === "merged" || task.changes?.kept) return true;
  for (const target of inWorkspace(task) ? task.targets! : []) {
    if (target.status === "request" && target.requestNumber !== null && (await ctx.store.getRequest(ctx.tenant, target.repoId, target.requestNumber))?.status === "merged") return true;
  }
  return false;
}

export const NO_FOLLOW_UP = "this task takes no follow-up now: its agent is not working in a session it can be told more in";

/** Why `user` cannot take a task in review on from its request now: going on is a new run, held to the same rights and policies a start is. */
export async function goOnRefusal(ctx: OrchestratorContext, user: Principal, task: TaskRecord): Promise<{ error: string; code?: string; status: 400 | 403 | 404 | 409 } | null> {
  const repo = await ctx.store.getRepo(ctx.tenant, task.repoId);
  if (!repo || !canStartOnTeam(user, repo.team)) return { error: START_REFUSED, status: 403 };
  const onMachine = await machineRefusal(ctx, user, repo);
  if (onMachine) return { error: onMachine, code: "on-another-machine", status: 403 };
  const refused = (await startRefusals(ctx, user, undefined, task.mode ?? undefined))(repo);
  return refused ? { error: refused.message, code: refused.code, status: refused.status } : null;
}

/** Puts a task in review back in line to go on from its branch, the log saying who asked. */
export async function goOn(ctx: OrchestratorContext, task: TaskRecord, line: string): Promise<void> {
  await ctx.store.updateTask(ctx.tenant, task.id, { status: "queued", error: null, finishedAt: null });
  await ctx.store.appendTaskLog(ctx.tenant, task.id, [line]);
  // A task on its starter's machine waits for that machine's runner; one this orchestrator runs goes back in its own line.
  if (task.runner === "local") ctx.runnerService?.wake();
  else await ctx.tasks?.goOn?.(task.id);
}

/** What a follow-up holds at most: a person's words, and the request's passages they point at. */
export const MESSAGE_MAX = 8000;
const QUOTES_MAX = 20;
const QUOTE_MAX = 4000;
export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;
const CONTINUE_COMMAND = "task.continue";
/**
 * A start from Tasks or from a board, the same way: one that names no project on this machine is sent to one of the
 * person's folders by what it asks for, or to the folder they name, and its first line says where and why.
 */
async function startAnywhere(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, body: Record<string, unknown> | null): Promise<{ task: TaskRecord } | { error: string; status: 400 | 403 | 404 | 409; code?: string }> {
  const sent = body && body.repoId === undefined && ctx.mode === "local" && ctx.workFolders ? await routedStart(ctx, runner, user, body) : null;
  if (sent && "error" in sent) return sent;
  const started = await startTask(ctx, runner, user, sent ? sent.body : body);
  if ("error" in started || !sent) return started;
  await ctx.store.updateTask(ctx.tenant, started.task.id, { routing: sent.routing });
  await ctx.store.appendTaskLog(ctx.tenant, started.task.id, [sent.checked ? `${routingLine(sent.routing)} ${sent.checked}` : routingLine(sent.routing), loadedLine(sent.routing.path, sent.routing.loaded!)]);
  return { task: (await ctx.store.getTask(ctx.tenant, started.task.id))! };
}

/** A folder a person types as they would in a shell: `~/code` is their home's code folder. */
const fromHome = (path: unknown): unknown => (typeof path === "string" && /^~(\/|$)/.test(path.trim()) ? join(homedir(), path.trim().slice(1)) : path);

/**
 * Where a start that names no project goes: the folder its starter names, or one read-only question to the agent over the
 * task's words and the person's folders, each quoted as data. An answer that names none of them sends it to the folder
 * the person ran the most Claude Code sessions in; with none known, they are asked which folder, in one line.
 */
async function routedStart(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, body: Record<string, unknown>): Promise<{ body: Record<string, unknown>; routing: Routing; checked: string | null } | { error: string; status: 400 | 409; code?: string }> {
  const where = await whereTo(ctx, runner, user, body);
  if ("error" in where) return where;
  const { routing, title } = where;
  if (!routing) return { error: "Which folder does this task work in? Pick one or type its path.", status: 409, code: "pick-folder" };
  const opened = await openProject(ctx, user, routing.path).catch((err: Error) => err);
  if (opened instanceof Error) return { error: opened.message, status: 409, code: opened instanceof AccountError ? opened.code : "folder-refused" };
  return { body: { ...body, title, repoId: opened.project.id }, routing: { ...routing, path: opened.project.url, loaded: await folderLoaded(opened.project.url) }, checked: await routedChecks(ctx, user, opened.project.id, opened.project.url) };
}

/**
 * The folder a start that names no project goes to and the title it starts with, or null for the folder when the person
 * is to pick one; read before a start, too, so a form shows where a task goes before it is started.
 */
async function whereTo(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, body: Record<string, unknown>): Promise<{ routing: Routing | null; title: string } | { error: string; status: 400 | 409; code?: string }> {
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const issueUrl = typeof body.issueUrl === "string" ? body.issueUrl.trim() : "";
  // With an issue, the words beside its link are a note on it: the task is named after the issue, not after the note.
  const given = typeof body.title === "string" && body.title.trim() ? body.title.trim() : issueUrl ? "" : description.split("\n")[0]!.trim().slice(0, ROUTED_TITLE_MAX);
  if (!given && !issueUrl) return { error: "say what needs doing", status: 400 };
  const issue = issueUrl ? await readableIssue(ctx, user, issueUrl, body.withoutIssueText === true) : null;
  if (issue && "error" in issue) return issue;
  const title = given || issue?.title || "";
  const routing = typeof body.path === "string" && body.path.trim() ? { path: String(fromHome(body.path)), reason: "", fallback: false } : await askedRouting(ctx, runner, user, body, [title, description, issueUrl].filter(Boolean).join("\n"));
  return { routing, title };
}

/**
 * The issue a routed start works on, with its title when the orchestrator reads it. One no way reads, no tracker
 * connected and no MCP server of the person's or the team's that reads its kind, is refused before an agent starts: an
 * agent on a link alone spends the task asking what the issue says. The person can still start on the link alone.
 */
async function readableIssue(ctx: OrchestratorContext, user: Principal, given: string, linkAlone: boolean): Promise<{ title: string | null } | { error: string; status: 400 | 409; code?: string }> {
  const tracker = await readTracker(ctx);
  const parsed = (() => {
    try {
      return parseIssueLink(issueAddress(given, tracker), tracker);
    } catch (err) {
      if (err instanceof ChangeRefused) return { error: err.message };
      throw err;
    }
  })();
  if ("error" in parsed) return { error: parsed.error, status: 400 };
  const reach = await issueReach(ctx, user, parsed);
  if (reach.via === "link" && !linkAlone) return { error: reachText(reach, parsed.kind), status: 409, code: "issue-unread" };
  return { title: (await issuePreview(ctx, user, given)).title };
}

/** The folder the agent picks for a task's words among the person's, or the one they use most; null when there is neither. */
async function askedRouting(ctx: OrchestratorContext, runner: TaskRunner, user: Principal, body: Record<string, unknown>, words: string): Promise<Routing | null> {
  const candidates = await ctx.workFolders!(user);
  if (!candidates.length) return null;
  const agent = typeof body.agent === "string" && runner.agents().some((a) => a.id === body.agent) ? body.agent : runner.agents()[0]?.id;
  const asked = agent ? await runner.ask(agent, "Pick the folder a task works in", routingPrompt(words, candidates)).catch(() => null) : null;
  return routed(asked?.summary ?? null, candidates) ?? mostUsed(candidates);
}

/**
 * The checks a routed task runs with, said on its first line. Start approves what the folder's files name when nothing
 * is approved yet, the setup with them, as the line then says; an approval whose files changed since is not renewed
 * here, as a teammate or an agent changed them, and the task runs without them until the person approves again.
 */
async function routedChecks(ctx: OrchestratorContext, user: Principal, projectId: string, folder: string): Promise<string | null> {
  const detected = await detectVerification(await repoReader(folder));
  const approved = await approvedVerification(ctx.store, ctx.tenant, projectId);
  if (approved) {
    const changed = changedSince(approved, detected);
    return changed.length ? `${changed.join(", ")} changed since the checks were approved; approve them on the project's page.` : checkedLine(approved);
  }
  const checks = detected.checks.filter((c) => !c.long);
  const picked = checks.length ? checks : detected.checks.slice(0, 1);
  if (!picked.length) return null;
  const pick = (step: DetectedStep) => ({ source: step.source, command: step.command, digest: step.digest });
  const done = await approveVerification(ctx.store, ctx.tenant, projectId, detected, { checks: picked.map(pick), setup: detected.setup ? pick(detected.setup) : null }, user.email);
  return "refused" in done ? null : checkedLine(done);
}

/** Every approved step by its command, what it runs and whether it reaches the network: nothing Start approved stays out of sight. */
function checkedLine(approved: ApprovedVerification): string {
  const said = (step: DetectedStep) => `${step.command} (runs ${step.runs}${step.network ? ", reaches the network" : ""})`;
  return `Checked with ${approved.checks.map(said).join(", ")}${approved.setup ? `, set up first with ${said(approved.setup)}` : ""}.`;
}

/** The plan the task's run put to its starter last, still unanswered: kept on its request whatever ended the run. */
async function unansweredPlan(ctx: OrchestratorContext, task: TaskRecord): Promise<{ requestId: string; text: string } | null> {
  // A request from before plans had their own kind is the agent's ExitPlanMode call with no plan in it.
  const asked = (await ctx.store.taskRequests(ctx.tenant, task.id)).filter((r) => (r.kind === "plan" || r.payload.tool === PLAN_TOOL) && r.status !== "answered");
  const last = asked.at(-1);
  if (!last) return null;
  if (typeof last.payload.plan === "string" && last.payload.plan.trim()) return { requestId: last.id, text: last.payload.plan };
  const text = await planFile(ctx, task);
  return text ? { requestId: last.id, text } : null;
}

/**
 * The plan file the agent wrote for this task, newest first, where it is still on disk: the task's own copy while it is
 * kept, or the folder the task worked in place. Masked as a person's words are, and cut to what a plan holds.
 */
async function planFile(ctx: OrchestratorContext, task: TaskRecord): Promise<string | null> {
  const repo = await ctx.store.getRepo(ctx.tenant, task.repoId);
  const dirs = [taskPaths(ctx.dataDir, ctx.tenant, task.id).work, ...(repo && isAbsolute(repo.url) ? [repo.url] : [])].map((dir) => join(dir, CLAUDE_PLANS_DIR));
  const since = Date.parse(task.startedAt ?? task.createdAt);
  const found: { path: string; at: number }[] = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".md")) continue;
      const at = (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0;
      if (at >= since) found.push({ path: join(dir, name), at });
    }
  }
  const newest = found.sort((a, b) => b.at - a.at)[0];
  const text = newest ? (await readFile(newest.path, "utf8").catch(() => "")).trim() : "";
  return text ? maskedFollowUp(text.slice(0, PLAN_TEXT_MAX), null).text : null;
}

const PLAN_TOOL = "ExitPlanMode";

/** The next run's word that the plan was approved: the plan is the agent's own words, quoted as data, carried out in the task's own mode. */
const approvedPlanText = (by: string, plan: string): string => `Your last run put this plan to ${by}, who approved it after the run stopped. Carry it out.\n\n${fence(plan)}`;

/** The most a person's answer to a stopped run carries, as a follow-up does. */
const ANSWER_MAX = 8000;

/** A routed task's title when it gives none: the first line of what it asks for, cut here. */
const ROUTED_TITLE_MAX = 120;

/** The highest limits Settings takes for one task: past them a mistyped value is no limit at all. */
const TASK_LIMIT_USD_MAX = 1000;
const TASK_LIMIT_MINUTES_MAX = 24 * 60;

/** A follow-up's text and quotes as the store keeps them: masked line by line, never cut through a secret. */
export function maskedFollowUp(text: string, quotes: FollowUpQuote[] | null): { text: string; quotes: FollowUpQuote[] | null } {
  const redactor = new Redactor([]);
  const mask = (value: string) => value.split("\n").map((line) => redactor.line(printable(line))).join("\n");
  return { text: mask(text), quotes: quotes?.map((q) => ({ path: q.path, lines: q.lines, text: mask(q.text) })) ?? null };
}

/** The quotes of a follow-up, or why they are refused: a path inside the repository, a line range and its text. */
export function readQuotes(raw: unknown): FollowUpQuote[] | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > QUOTES_MAX) return { error: `quotes is a list of at most ${QUOTES_MAX} passages` };
  const quotes: FollowUpQuote[] = [];
  for (const q of raw as Record<string, unknown>[]) {
    const path = typeof q?.path === "string" ? q.path : "";
    const lines = typeof q?.lines === "string" ? q.lines : "";
    const text = typeof q?.text === "string" ? q.text : "";
    if (!path || path.startsWith("/") || path.split("/").includes("..") || !/^\d+(-\d+)?$/.test(lines) || !text || text.length > QUOTE_MAX) return { error: `each quote is a path in the repository, its lines as 12 or 12-18, and at most ${QUOTE_MAX} characters of text` };
    quotes.push({ path, lines, text });
  }
  return quotes;
}

/** A request as a page shows it: the tenant is the orchestrator's own. */
function shownRequest({ tenant: _tenant, ...request }: TaskRequestRecord): Omit<TaskRequestRecord, "tenant"> {
  return request;
}

/** A task's cards as its page shows them: the person who answered one by their name, never by the address the record keeps. */
async function shownRequests(ctx: OrchestratorContext, requests: readonly TaskRequestRecord[]): Promise<Omit<TaskRequestRecord, "tenant">[]> {
  const nameOf = nameReader(ctx);
  return Promise.all(requests.map(async (request) => ({ ...shownRequest(request), ...(request.answeredBy ? { answeredBy: await nameOf(request.answeredBy) } : {}) })));
}
