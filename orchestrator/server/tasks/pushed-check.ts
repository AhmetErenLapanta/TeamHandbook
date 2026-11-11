import type { OrchestratorContext } from "../app.js";
import { mirrorDir, syncRepo } from "../app.js";
import { join } from "node:path";
import type { FileChange, RequestRecord } from "../forge/types.js";
import { gitAsync, gitAsyncMaybe, oneAtATime } from "../git.js";
import { localRepoPath } from "../forge/local.js";
import { providerFor } from "../propose.js";
import { compareVersions, detectSecret, PLUGIN_MANIFEST } from "../plugin.js";
import type { RepoRecord } from "../store.js";
import { secretsForTask, UnreadTaskSecret } from "../task-secrets.js";
import { versionRaise } from "../versions.js";
import { rawChanges } from "./changes.js";
import { everyTask } from "./guards.js";
import { Redactor } from "./redact.js";
import { checkTaskResult, templateProblem } from "./rules.js";
import { editRefusal, taskPolicy } from "./task-policy.js";
import type { TaskRecord } from "./types.js";

/** Commits one pushed branch may carry: a run makes one, and a long history is no task's. */
export const MAX_PUSHED_COMMITS = 20;

/** The check's name on a commit, where a forge shows it beside the request: a team that requires it there has the forge refuse a merge the orchestrator held. */
export const PUSH_CHECK_CONTEXT = "teamhandbook/pushed-check";

/**
 * Where a policy rule's paths are resolved for a pushed branch: no checkout exists on the
 * orchestrator, and the rules name paths in the repository, so any fixed root reads them alike.
 */
const POLICY_ROOT = "/repository";

/**
 * A branch a machine pushed, held on the orchestrator to every rule a change it made itself is
 * held to, before any request is opened: the machine is the person's and is not trusted to have
 * kept them. The branch must be the one this task was given, read from the orchestrator's own
 * mirror after a sync, so nothing the machine configured is run; its head is then held to the
 * rules `headRefusal` reads.
 */
export async function pushedBranchRefusal(ctx: OrchestratorContext, task: TaskRecord, repo: RepoRecord, branch: string): Promise<Checked | { refused: string }> {
  const named = (await ctx.store.taskLease(ctx.tenant, task.id))?.branch ?? null;
  if (!named || named !== branch) return { refused: `the machine pushed ${branch}, and this task was given ${named ?? "no branch"}` };
  const synced = await syncRepo(ctx, repo.id);
  if ("error" in synced) return { refused: `the repository could not be read again to check the branch (${synced.error})` };
  const mirror = mirrorDir(ctx, repo.id);
  const head = (await gitAsyncMaybe(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], mirror))?.trim();
  if (!head) return { refused: `${branch} is not on the repository` };
  return headRefusal(ctx, task, repo, branch, head);
}

/** What a checked head carries: its changed files, and what a reviewer looks at before merging. */
export interface Checked {
  head: string;
  files: FileChange[];
  warnings: string[];
}

/**
 * One head of a task's branch, read from the mirror, held to the team's rules: the branch must
 * start from the task's base; the commits on it that its target does not have, at most
 * MAX_PUSHED_COMMITS, are each read for a secret, message included; a merge counts only for what
 * it adds itself and only when it merges the target in, so a branch brought up to date with its
 * target is judged on the task's own work; and the change as a whole, against where the branch
 * left its target, meets the team's policy, the task's template and the skills' rules.
 */
export async function headRefusal(ctx: OrchestratorContext, task: TaskRecord, repo: RepoRecord, branch: string, head: string): Promise<Checked | { refused: string }> {
  if (!task.baseSha) return { refused: "the task has no base commit on record to hold the branch to" };
  const mirror = mirrorDir(ctx, repo.id);
  const read = (args: string[]) => gitAsync(["--git-dir", mirror, ...args], mirror);
  const maybe = (args: string[]) => gitAsyncMaybe(["--git-dir", mirror, ...args], mirror);
  if ((await maybe(["merge-base", "--is-ancestor", task.baseSha, head])) === null) {
    return { refused: `${branch} does not start from the task's base commit ${task.baseSha.slice(0, 7)}` };
  }
  // The request's target is the repository's default branch, which every orchestrator request is opened on.
  const target = (await maybe(["symbolic-ref", "--short", "HEAD"]))?.trim();
  const targetHead = target ? (await maybe(["rev-parse", "--verify", "--quiet", `refs/heads/${target}^{commit}`]))?.trim() : null;
  if (!target || !targetHead) return { refused: "the repository's default branch cannot be read" };
  const commits = (await read(["rev-list", "--reverse", head, "--not", targetHead])).split("\n").filter(Boolean);
  if (commits.length > MAX_PUSHED_COMMITS) return { refused: `${branch} carries ${commits.length} commits its target does not have, over the ${MAX_PUSHED_COMMITS} one task's branch may` };

  let secrets: { name: string; value: string }[];
  try {
    secrets = await secretsForTask(ctx, repo.id, repo.team);
  } catch (err) {
    if (err instanceof UnreadTaskSecret) return { refused: err.message };
    throw err;
  }
  const redactor = new Redactor(secrets.map((secret) => secret.value));
  const carries = (text: string) => redactor.carriesCredential(text);
  for (const commit of commits) {
    // The message is kept by the forge with the commit, so it is read as the files are.
    const message = await read(["log", "-1", "--format=%B", commit]);
    const secret = detectSecret(message);
    if (secret || carries(message)) return { refused: `commit ${commit.slice(0, 7)}: its message ${secret ? `looks like it holds a secret (${secret})` : "holds a task secret"}` };
    const [, first, other, ...more] = (await read(["rev-list", "--parents", "-n", "1", commit])).trim().split(" ");
    if (more.length) return { refused: `commit ${commit.slice(0, 7)} merges more than two branches` };
    let raw: string;
    if (other) {
      if ((await maybe(["merge-base", "--is-ancestor", other, targetHead])) === null) return { refused: `commit ${commit.slice(0, 7)} merges in a branch other than ${target}` };
      // What the merge adds itself: the paths it leaves unlike both its parents, a conflict's
      // resolution or a change squeezed into it; what it takes from either side as it was is not its own.
      raw = mergeOwn(await read(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", first!, commit]), new Set((await read(["diff", "--name-only", "-z", "--no-renames", other, commit])).split("\0").filter(Boolean)));
    } else {
      raw = await read(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", first!, commit]);
    }
    const step = await rawChanges(raw, read, carries);
    if ("refused" in step) return { refused: `commit ${commit.slice(0, 7)}: ${step.refused}` };
  }
  // The change as a whole is read whatever the commits were: one added and taken out again is caught only one by one, but what stays is read here.
  const base = (await read(["merge-base", targetHead, head])).trim();
  const whole = await rawChanges(await read(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head]), read, carries);
  if ("refused" in whole) return whole;
  if (!whole.files.length) return { refused: `${branch} changes nothing against ${target}` };

  // The policies a run on the orchestrator holds the agent to, read where that run reads them.
  const code = ctx.tasks?.codeTarget(repo) ?? null;
  const source = code ? (code.skillsFrom ? await ctx.store.getRepo(ctx.tenant, code.skillsFrom) : null) : { ...repo, head: task.baseSha };
  if (code?.skillsFrom && !source?.head) return { refused: `the skills repository ${code.skillsFrom} has not been read, so the team's policy cannot be checked` };
  const rules = source ? await taskPolicy(mirrorDir(ctx, source.id), source.head!) : [];
  if ("refused" in rules) return { refused: rules.refused };
  const held = editRefusal(rules, whole.files.map((f) => f.path), POLICY_ROOT);
  if (held) return { refused: held };
  const outside = templateProblem(task.template, whole.files);
  if (outside) return { refused: outside };
  const checked = await checkTaskResult(whole.files, mirror, base);
  if ("refused" in checked) return { refused: checked.refused };
  return { head, files: whole.files, warnings: [...checked.warnings, ...(code ? [] : await versionWarning(mirror, base, whole.files))] };
}

/** The entries of a `diff --raw -z` whose path is also in `also`. */
function mergeOwn(raw: string, also: ReadonlySet<string>): string {
  const fields = raw.split("\0");
  const kept: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) if (also.has(fields[i + 1]!)) kept.push(fields[i]!, fields[i + 1]!);
  return kept.length ? `${kept.join("\0")}\0` : "";
}

/**
 * The orchestrator raises a skills repository's plugin version in the requests it opens itself;
 * a pushed branch is the machine's, so what it left is said instead: teammates fetch the plugin
 * again only once the version moves past the one already claimed.
 */
async function versionWarning(mirror: string, baseSha: string, files: FileChange[]): Promise<string[]> {
  const raise = await versionRaise(mirror, baseSha);
  if (!raise) return [];
  const manifest = files.find((f) => f.path === PLUGIN_MANIFEST);
  let written: unknown;
  try {
    written = manifest?.content ? (JSON.parse(manifest.content) as { version?: unknown }).version : undefined;
  } catch {
    written = undefined;
  }
  if (typeof written === "string" && (compareVersions(written, raise.version) ?? -1) >= 0) return [];
  return [`${PLUGIN_MANIFEST} leaves the version at ${typeof written === "string" ? written : "the base's"}; teammates fetch the plugin again only past ${raise.version}, so set it to that before merging or this change reaches nobody.`];
}

/**
 * A request a task opened, read again at a head it was not checked at: whoever pushed it, the
 * task's follow-up, its machine or a person, the head is held to `headRefusal`'s rules against the
 * same task. A head that fails holds the request, which does not merge until a later push passes;
 * the reason is said on the task's page and, on a hosted forge, as a commit status on that head. A
 * head the orchestrator cannot read, or reads otherwise than the forge reported, holds it too, and
 * so does a target the forge now merges it into other than the branch it was opened on. One check
 * of a request at a time; a request no task opened is left as it is.
 */
export async function recheckRequest(ctx: OrchestratorContext, repo: RepoRecord, request: RequestRecord, head: string, target?: string): Promise<"passed" | "held" | "unchanged"> {
  // A request is opened on the repository's default branch; one the forge now merges elsewhere is held, its head moved or not.
  const mirror = mirrorDir(ctx, repo.id);
  const opened = (await gitAsyncMaybe(["--git-dir", mirror, "symbolic-ref", "--short", "HEAD"], mirror))?.trim();
  const retargeted = Boolean(target && opened && target !== opened);
  if (head === request.heldHead || (!retargeted && head === request.checkedHead)) return "unchanged";
  return oneAtATime(join(ctx.dataDir, "request-checks", ctx.tenant, repo.id, String(request.number)), async () => {
    const [task] = await everyTask(ctx.store, ctx.tenant, { repoId: repo.id, requestNumber: request.number });
    if (!task) return "unchanged";
    const short = head.slice(0, 7);
    const said = async (state: "success" | "failure", description: string) => {
      const provider = await providerFor(ctx, repo).catch(() => null);
      // A status the forge, or the person's own CLI for it, did not take is said on the task: a check nobody sees written would read as passed.
      await provider?.setCommitStatus?.(head, { state, context: PUSH_CHECK_CONTEXT, description: description.slice(0, 140) }).catch(async (err: Error) => {
        console.error(`request #${request.number}: the check's status was not written: ${err.message}`);
        await ctx.store.appendTaskLog(ctx.tenant, task.id, [new Redactor().line(`The ${PUSH_CHECK_CONTEXT} check was not written on ${short}: ${err.message.split("\n")[0]}`)]);
      });
    };
    const hold = async (reason: string) => {
      await ctx.store.recordRequestCheck(ctx.tenant, repo.id, request.number, { head, passed: false, reason });
      await ctx.store.appendTaskLog(ctx.tenant, task.id, [`Request #${request.number} changed after it was checked: ${short} is held, ${reason}. It does not merge until a push that meets the team's rules.`]);
      await said("failure", `Held: ${reason}`);
      return "held" as const;
    };
    if (retargeted) return hold(`its target was changed on the forge to ${target}, and it was opened on ${opened}`);
    const synced = await syncRepo(ctx, repo.id);
    if ("error" in synced) return hold(`the repository could not be read to check it (${synced.error})`);
    const at = (await gitAsyncMaybe(["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], mirror))?.trim();
    if (at !== head) return hold(`the forge shows it on ${request.branch}, and the orchestrator's copy reads ${at ? at.slice(0, 7) : "no such branch"}`);
    // A request one of several repositories of the task opened is held to that repository's own base.
    const base = task.targets?.find((t) => t.repoId === repo.id && t.requestNumber === request.number)?.baseSha ?? task.baseSha;
    const checked = await headRefusal(ctx, { ...task, baseSha: base }, repo, request.branch, head);
    if ("refused" in checked) return hold(checked.refused);
    await ctx.store.recordRequestCheck(ctx.tenant, repo.id, request.number, { head, passed: true });
    await ctx.store.appendTaskLog(ctx.tenant, task.id, [`Request #${request.number} was pushed to after it opened; ${short} meets the team's rules${request.heldHead ? ", so it no longer waits" : ""}.`]);
    await said("success", "Meets the team's rules");
    return "passed";
  });
}

/**
 * Before the orchestrator's own forge merges a request a task opened, the branch's head is checked
 * now unless it is the one last checked: a request that holds none (opened before heads were checked,
 * or whose record was not written), and one a follow-up round pushed to while its own check, which
 * runs once the task is back in review, has not yet been recorded. The merge then takes only a head
 * that passed, or refuses the request it held, so one press merges it.
 */
export async function checkBeforeMerge(ctx: OrchestratorContext, repo: RepoRecord, number: number): Promise<void> {
  const local = localRepoPath(repo.url);
  const request = local ? await ctx.store.getRequest(ctx.tenant, repo.id, number) : null;
  if (!local || !request || request.status !== "open") return;
  const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `refs/heads/${request.branch}^{commit}`], local))?.trim();
  if (head) await recheckRequest(ctx, repo, request, head);
}
