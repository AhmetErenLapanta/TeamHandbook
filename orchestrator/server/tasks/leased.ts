import type { OrchestratorContext } from "../app.js";
import { memberUrl, mirrorDir, syncRepo } from "../app.js";
import { principalOf } from "../accounts.js";
import { recordEvent } from "../events.js";
import { removesAgentCredits, withoutAgentCredits } from "../forge/agent-credits.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { requestForPushedBranch } from "../forge/pushed.js";
import type { CliRun } from "../forge/own-cli.js";
import type { OpenedRequest, RequestRecord } from "../forge/types.js";
import { gitAsyncMaybe, stoppedFromOutside } from "../git.js";
import type { Principal } from "../auth.js";
import type { RepoRecord, Store } from "../store.js";
import type { LocalTargetReason, TaskRecord, TaskTarget } from "./types.js";
import { inWorkspace, UNKNOWN_COST } from "./types.js";
import { originOf } from "../projects.js";
import { teamAssignment } from "../propose.js";
import { detectSecret } from "../plugin.js";
import { headRefusal, pushedBranchRefusal, recheckRequest } from "./pushed-check.js";
import { taskMask } from "./task-text.js";
import type { TaskOutcome } from "../../runner/link.js";
import { evidenceMarkdown, readEvidence } from "./verify.js";
import type { VerifyPlan } from "./verify.js";

const STOPPED = "the orchestrator stopped before it could; the branch is where the machine pushed it.";

const HANDED_PREFIX = "verify.handed.";

/** The checks a machine was handed for a task, as it was handed them, so its report is held to that plan and no other. */
export async function keepHandedChecks(store: Pick<Store, "setSetting" | "deleteSetting">, tenant: string, taskId: string, handed: { plan: VerifyPlan; maxRepairs: number } | null): Promise<void> {
  if (handed) await store.setSetting(tenant, `${HANDED_PREFIX}${taskId}`, JSON.stringify(handed));
  else await store.deleteSetting(tenant, `${HANDED_PREFIX}${taskId}`);
}

/** The checks the task's last hand-out named, or null when it named none: a machine's report of any other check is not kept. */
export async function handedChecks(store: Pick<Store, "getSetting">, tenant: string, taskId: string): Promise<{ plan: VerifyPlan; maxRepairs: number } | null> {
  const raw = await store.getSetting(tenant, `${HANDED_PREFIX}${taskId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { plan: VerifyPlan; maxRepairs: number };
  } catch {
    return null;
  }
}

/**
 * What follows a leased task's end on the orchestrator: a branch a runner pushed becomes the
 * repository's request, under the same team rules a request the orchestrator opens itself
 * follows (its reviewers, the agent's credit lines). Where nothing on this machine can open it,
 * the task's log names the forge's own page that does. A failed or interrupted task opens nothing.
 */
export async function openPushedRequest(ctx: OrchestratorContext, taskId: string, outcome: TaskOutcome, run?: CliRun): Promise<void> {
  const task = await ctx.store.getTask(ctx.tenant, taskId);
  // The words a run that went on from the task's request was handed stay pending until it ends, so a lease taken
  // again hands them out again; once it ends, however it ended, none is handed out a second time.
  if (task && (task.requestNumber !== null || inWorkspace(task))) {
    const handed = await ctx.store.pendingFollowUps(ctx.tenant, task.id);
    if (handed.length) await ctx.store.markFollowUpsDelivered(ctx.tenant, handed.map((f) => f.id), new Date().toISOString());
  }
  if (task && outcome.status === "needs-review" && outcome.repos?.length) return workspaceRequests(ctx, task, outcome.repos, run);
  if (outcome.status !== "needs-review" || !outcome.branch) return;
  const repo = task ? await ctx.store.getRepo(ctx.tenant, task.repoId) : null;
  // A run that went on from the task's open request pushed onto that request's branch: its new head is checked, no second request opens.
  const open = task && repo && task.requestNumber !== null ? await ctx.store.getRequest(ctx.tenant, repo.id, task.requestNumber) : null;
  if (task && repo && open?.status === "open") return continuedRequest(ctx, task, repo, open);
  if (!outcome.request) return;
  const account = task ? (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === task.createdBy) : undefined;
  if (!task || !repo || !account || !task.baseSha) {
    if (task) await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The request for ${outcome.branch} was not opened: the task, its repository or its starter is no longer on record here.`]);
    return;
  }
  const user = await principalOf(ctx.store, account);
  // The machine is the person's: what it pushed is held to the team's rules here before anyone is asked to review it.
  const checked = await pushedBranchRefusal(ctx, task, repo, outcome.branch).catch((err: unknown) => {
    if (stoppedFromOutside(err)) return null;
    throw err;
  });
  if (!checked) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The request for ${outcome.branch} was not opened: ${STOPPED}`]));
  const said = [outcome.request.title, outcome.request.body].join("\n");
  const refused = "refused" in checked ? checked.refused : detectSecret(said) ? `its description looks like it holds a secret (${detectSecret(said)})` : null;
  if (refused) {
    await ctx.store.updateTask(ctx.tenant, task.id, { status: "failed", error: `The request was not opened: ${refused}.` });
    await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The request for ${outcome.branch} was not opened: ${refused}. The branch is already where the machine pushed it; delete it there.`]);
    return;
  }
  const masked = await taskMask(ctx, task);
  const title = masked(outcome.request.title);
  // The checks the machine ran, as kept here masked, follow the machine's own description, saying where they ran.
  const evidence = await readEvidence(ctx.store, ctx.tenant, task.id, repo.id);
  const ranOn = evidence && evidence.verdict !== "not-run" ? [`These checks ran on ${user.name}'s machine, not on the orchestrator: the orchestrator worked out each verdict from the exit codes the machine reported.`] : [];
  // A run on this orchestrator writes its checks into the body itself; a machine's body carries none of its own.
  const own = evidence && !outcome.request.body.includes("\n## Verification\n") ? [[...evidenceMarkdown(evidence), ...ranOn].join("\n")] : [];
  const told = masked([outcome.request.body, ...own, ...("warnings" in checked ? checked.warnings.map((w) => `Look at this before merging: ${w}`) : [])].join("\n\n"));
  const body = (await removesAgentCredits(ctx, repo.id)) ? withoutAgentCredits(told) : told;
  const answer = await requestForPushedBranch(ctx, repo, { title, body, branch: outcome.branch, baseSha: task.baseSha, assignment: await teamAssignment(ctx, repo, user) }, run).catch((err: Error) => ({ refused: stoppedFromOutside(err) ? STOPPED : err.message }));
  if ("refused" in answer) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The request for ${outcome.branch} was not opened: ${answer.refused}`]));
  if ("createUrl" in answer) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, [`The request for ${outcome.branch} was not opened here: ${answer.reason}. Open it on the forge: ${answer.createUrl}`]));
  const kept = await keepTaskRequest(ctx, task, repo, user, answer.opened, title, "pushed by a runner on this machine");
  // The head held to the team's rules above: a later push to the branch is checked again before it merges.
  if ("head" in checked) await ctx.store.recordRequestCheck(ctx.tenant, repo.id, kept.number, { head: checked.head, passed: true });
}

export async function continuedRequest(ctx: OrchestratorContext, task: TaskRecord, repo: RepoRecord, request: RequestRecord): Promise<void> {
  const read = await syncRepo(ctx, repo.id).catch((err: unknown) => {
    if (stoppedFromOutside(err)) return null;
    throw err;
  });
  if (!read) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, [`Request #${request.number} was not checked again: ${STOPPED}`]));
  const mirror = mirrorDir(ctx, repo.id);
  const head = (await gitAsyncMaybe(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], mirror))?.trim();
  if (!head) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, [`Request #${request.number} was not checked again: ${request.branch} is not on the repository.`]));
  // A local request's description is a note on its branch's head: it goes with the branch to the head the run left.
  const local = localRepoPath(repo.url);
  const before = request.checkedHead ?? request.heldHead ?? null;
  if (local && before && before !== head) await gitAsyncMaybe(["-c", "core.hooksPath=/dev/null", "notes", "--ref", localDescriptionRef(request.branch), "copy", "--force", before, head], local);
  await recheckRequest(ctx, repo, request, head);
}

type PushedRepo = NonNullable<TaskOutcome["repos"]>[number];

/**
 * The repository this organization connected that a remote a machine reported is, or null: a
 * repository held by path by its path, a hosted one by its address with no sign-in in it. Only a
 * known one is read, with the orchestrator's own copy and sign-in; nothing reaches a host the
 * machine names otherwise.
 */
async function knownRemote(ctx: OrchestratorContext, origin: string): Promise<RepoRecord | null> {
  const asked = originOf(origin)?.web.toLowerCase() ?? null;
  for (const repo of await ctx.store.listRepos(ctx.tenant)) {
    const path = localRepoPath(repo.url);
    if (path) {
      if (path === origin) return repo;
      continue;
    }
    const known = [repo.url, memberUrl(ctx, repo.id)].flatMap((url) => (url ? [originOf(url)?.web.toLowerCase()] : []));
    if (asked && known.includes(asked) && (await ctx.store.getForgeConfig(ctx.tenant, repo.id))) return repo;
  }
  return null;
}

/**
 * Each repository a run in a folder of several changed, its branch already pushed by the person's
 * machine, read here before anyone is asked to review it: the machine is the person's, so the
 * orchestrator reads the branch from its own copy of a repository it connected, takes the base
 * from that copy's default branch rather than the machine's word, and holds the change to the
 * same rules as any pushed branch. A repository that fails opens no request, and the log says
 * why; the others open theirs. A remote the orchestrator does not know is not read at all.
 */
async function workspaceRequests(ctx: OrchestratorContext, task: TaskRecord, pushed: PushedRepo[], run?: CliRun): Promise<void> {
  const account = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === task.createdBy);
  if (!account) return void (await ctx.store.appendTaskLog(ctx.tenant, task.id, ["No request was opened: the task's starter is no longer on record here."]));
  const user = await principalOf(ctx.store, account);
  const masked = await taskMask(ctx, task);
  const log = (line: string) => ctx.store.appendTaskLog(ctx.tenant, task.id, [masked(line)]);
  // A run that went on from what the task left keeps each repository it did not change as it was, and one whose request
  // is still open has that request checked again at its new head rather than a second one opened.
  const earlier = task.targets ?? [];
  const targets: TaskTarget[] = earlier.filter((t) => t.path === undefined || !pushed.some((entry) => entry.path === t.path));
  for (const entry of pushed) {
    // Only a branch the machine pushed moves the request; one it kept goes on as a change kept on the machine.
    const before = entry.origin && entry.pushed !== false ? earlier.find((t) => t.path === entry.path && t.status === "request" && t.requestNumber !== null) : undefined;
    const open = before ? await ctx.store.getRequest(ctx.tenant, before.repoId, before.requestNumber!) : null;
    const repo = open?.status === "open" && open.branch === entry.branch ? await ctx.store.getRepo(ctx.tenant, open.repoId) : null;
    if (before && open && repo) {
      await continuedRequest(ctx, task, repo, open);
      await log(`${entry.path || "the folder"}: went on in request #${open.number} on ${open.branch}.`);
      targets.push(before);
    } else targets.push(await reportedTarget(ctx, task, user, entry, masked, log, run));
  }
  if (targets.length) await ctx.store.setTaskTargets(ctx.tenant, task.id, targets);
  // A change kept on the person's machine is one to review there, so the task waits for review with it.
  if (!targets.some((t) => t.status === "request" || t.status === "local")) await ctx.store.updateTask(ctx.tenant, task.id, { status: "failed", error: "No request was opened for any repository the agent changed; the log says why for each." });
}

/**
 * What one repository a machine reported becomes: a change kept on the machine, a request opened from its pushed
 * branch after the orchestrator read and checked it from its own copy, or the reason none opened.
 */
async function reportedTarget(ctx: OrchestratorContext, task: TaskRecord, user: Principal, entry: PushedRepo, masked: (text: string) => string, log: (line: string) => Promise<unknown>, run?: CliRun): Promise<TaskTarget> {
  // A folder that is one repository itself is reported at the empty path.
  const where = entry.path || "the folder";
  // A change with no request stays on its branch in the repository on the person's machine: the task's page says
  // where, under the folder's own record, as no repository of this organization holds it.
  const kept = (reason: LocalTargetReason): TaskTarget => {
    // The words its request will say, masked; ones that look like a secret are not kept, and the request asks for its own.
    const description = entry.request && !detectSecret([entry.request.title, entry.request.body].join("\n")) ? { title: masked(entry.request.title), body: masked(entry.request.body) } : null;
    const origin = entry.origin && !detectSecret(entry.origin) ? entry.origin : null;
    return { repoId: task.repoId, status: "local", reason, path: entry.path, head: entry.head, ...(origin ? { origin } : {}), ...(entry.target ? { targetBranch: entry.target } : {}), ...(description ? { description } : {}), baseSha: entry.baseSha, branch: entry.branch, tests: null, requestNumber: null, error: null, cost: UNKNOWN_COST };
  };
  // A repository with a remote the machine did not push to says why in the machine's own lines; its branch is in it.
  if (!entry.origin || entry.pushed === false || !entry.request) {
    await log(entry.origin ? `${where}: the branch ${entry.branch} stays in that repository, unpushed, so no request opens for it.` : `${where}: no remote to push to; the branch ${entry.branch} is in that repository.`);
    return kept(entry.origin ? "unpushed" : "no-remote");
  }
  const repo = await knownRemote(ctx, entry.origin);
  if (!repo) {
    await log(`${where}: its remote is no repository this organization connected, so the orchestrator did not read it and opened no request; connect it to have its changes reviewed here.`);
    return kept("not-connected");
  }
  const target = (fields: Partial<TaskTarget>): TaskTarget => ({ repoId: repo.id, status: "failed", reason: `changed by the agent in ${where}`, path: entry.path, baseSha: null, branch: entry.branch, tests: null, requestNumber: null, error: null, cost: UNKNOWN_COST, ...fields });
  const refuse = async (why: string): Promise<TaskTarget> => {
    await log(`${where}: the request was not opened: ${why}.`);
    return target({ error: `The request was not opened: ${why}.` });
  };
  const synced = await syncRepo(ctx, repo.id).catch((err: unknown) => {
    if (stoppedFromOutside(err)) return { error: STOPPED };
    throw err;
  });
  if ("error" in synced) {
    return refuse(`${repo.name} could not be read again to check the branch (${synced.error})`);
  }
  const mirror = mirrorDir(ctx, repo.id);
  const read = async (args: string[]) => (await gitAsyncMaybe(["--git-dir", mirror, ...args], mirror))?.trim() || null;
  const head = await read(["rev-parse", "--verify", "--quiet", `refs/heads/${entry.branch}^{commit}`]);
  if (head !== entry.head) {
    return refuse(head ? `${repo.name} has ${entry.branch} at ${head.slice(0, 7)}, and the machine reported ${entry.head.slice(0, 7)}` : `${entry.branch} is not on ${repo.name}`);
  }
  const defaultBranch = await read(["symbolic-ref", "--short", "HEAD"]);
  const targetHead = defaultBranch ? await read(["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}^{commit}`]) : null;
  const base = targetHead ? await read(["merge-base", targetHead, head]) : null;
  if (!base) {
    return refuse(`${entry.branch} shares no history with ${repo.name}'s default branch`);
  }
  const checked = await headRefusal(ctx, { ...task, baseSha: base }, repo, entry.branch, head);
  if ("refused" in checked) {
    return refuse(checked.refused);
  }
  const said = [entry.request?.title ?? task.title, entry.request?.body ?? ""].join("\n");
  if (detectSecret(said)) {
    return refuse(`its description looks like it holds a secret (${detectSecret(said)})`);
  }
  const title = masked(entry.request?.title ?? task.title);
  const told = masked([entry.request?.body ?? "", ...checked.warnings.map((w) => `Look at this before merging: ${w}`)].join("\n\n"));
  const body = (await removesAgentCredits(ctx, repo.id)) ? withoutAgentCredits(told) : told;
  const answer = await requestForPushedBranch(ctx, repo, { title, body, branch: entry.branch, baseSha: base, assignment: await teamAssignment(ctx, repo, user) }, run).catch((err: Error) => ({ refused: stoppedFromOutside(err) ? STOPPED : err.message }));
  if ("refused" in answer) {
    return refuse(answer.refused);
  }
  if ("createUrl" in answer) {
    await log(`${where}: the request was not opened here: ${answer.reason}. Open it on the forge: ${answer.createUrl}`);
    return target({ status: "request", baseSha: base });
  }
  const provider = localRepoPath(repo.url) ? "local" : (await ctx.store.getForgeConfig(repo.tenant, repo.id))!.kind;
  const record: RequestRecord = { ...answer.opened, tenant: repo.tenant, repoId: repo.id, title, status: "open", provider, createdAt: new Date().toISOString(), createdBy: user.email };
  await ctx.store.saveRequest(record);
  await ctx.store.recordRequestCheck(ctx.tenant, repo.id, record.number, { head, passed: true });
  await log(`${where}: opened request #${record.number} on ${repo.name}, ${record.branch}. It waits for a person to review and merge it.`);
  await recordEvent(ctx, user, "request.opened", { repoId: repo.id, subject: `request:${record.number}`, detail: `"${record.title}" on ${record.branch}, pushed by a runner from a folder of several repositories` });
  return target({ status: "request", baseSha: base, requestNumber: record.number });
}

/**
 * Opens the request for one change kept on its person's machine once its branch reached the remote, through the
 * checks a branch pushed at a task's end takes; only that target changes. The forge's button calls it after the
 * machine pushed the branch.
 */
export async function openTargetRequest(ctx: OrchestratorContext, taskId: string, position: number, run?: CliRun): Promise<TaskTarget | { refused: string }> {
  const task = await ctx.store.getTask(ctx.tenant, taskId);
  const kept = task?.targets?.[position];
  if (!task || !kept) return { refused: "the task has no such change" };
  if (kept.status !== "local" || kept.path === undefined || !kept.branch || !kept.head || !kept.origin) return { refused: "this change is not one kept on its machine with a remote to push to" };
  const account = (await ctx.store.listUsers(ctx.tenant)).find((u) => u.email === task.createdBy);
  if (!account) return { refused: "the task's starter is no longer on record here" };
  const masked = await taskMask(ctx, task);
  const log = (line: string) => ctx.store.appendTaskLog(ctx.tenant, task.id, [masked(line)]);
  const entry: PushedRepo = { path: kept.path, branch: kept.branch, head: kept.head, baseSha: kept.baseSha ?? "", origin: kept.origin, target: kept.targetBranch ?? null, request: kept.description ?? { title: task.title, body: "" } };
  const target = await reportedTarget(ctx, task, await principalOf(ctx.store, account), entry, masked, log, run);
  await ctx.store.updateTaskTarget(ctx.tenant, task.id, position, { repoId: target.repoId, status: target.status, reason: target.reason, baseSha: target.baseSha, requestNumber: target.requestNumber, error: target.error });
  return target;
}

/**
 * Keeps the request opened for a task's branch, however it was opened: the task names it, its log
 * and the event log say so, and the repository is read again. `how` ends the event's line.
 */
export async function keepTaskRequest(ctx: OrchestratorContext, task: TaskRecord, repo: RepoRecord, user: Principal, opened: OpenedRequest, title: string, how: string): Promise<RequestRecord> {
  const provider = localRepoPath(repo.url) ? "local" : (await ctx.store.getForgeConfig(repo.tenant, repo.id))!.kind;
  const record: RequestRecord = { ...opened, tenant: repo.tenant, repoId: repo.id, title, status: "open", provider, createdAt: new Date().toISOString(), createdBy: user.email };
  await ctx.store.saveRequest(record);
  await ctx.store.updateTask(ctx.tenant, task.id, { requestNumber: record.number });
  await ctx.store.appendTaskLog(ctx.tenant, task.id, [`Opened request #${record.number} on ${record.branch}. It waits for a person to review and merge it.`]);
  await recordEvent(ctx, user, "request.opened", { repoId: repo.id, subject: `request:${record.number}`, detail: `"${record.title}" on ${record.branch}, ${how}` });
  await syncRepo(ctx, repo.id);
  return record;
}
