import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentEvent, AgentFailure, AgentSession } from "../server/tasks/adapters/contract.js";
import { openSession } from "../server/tasks/adapters/session.js";
import { writeApprovedProjectMcp, writeTeamSkills } from "../server/tasks/agents.js";
import type { AgentAdapter, AgentSetup } from "../server/tasks/agents.js";
import { collectChanges } from "../server/tasks/changes.js";
import type { TaskPaths } from "../server/tasks/isolation.js";
import { runProcess, taskEnv } from "../server/tasks/isolation.js";
import { checkPlaces, findCheckSandbox, sandboxed } from "../server/tasks/check-sandbox.js";
import type { CheckSandbox } from "../server/tasks/check-sandbox.js";
import { folderReader, notRun, OutputTail, verifyAfter, verifyBefore } from "../server/tasks/verify.js";
import type { VerifyIo } from "../server/tasks/verify.js";
import type { StepRun } from "../shared/verification.js";
import { FOLDER_TEXT_MAX, TESTS_OUTPUT } from "../shared/runner-wire.js";
import { folderHooksRefusal, managedSettingsPlaces, personalEnv, personalHooksRefusal, projectMcpServers, releasePersonalGuard, writePersonalGuard } from "../server/tasks/profile.js";
import { Redactor } from "../server/tasks/redact.js";
import { isGitFolder } from "../server/projects.js";
import { shadowChanges, shadowSnapshot } from "../server/shadow-git.js";
import { refusedInPlace } from "../server/tasks/task-policy.js";
import { attachmentsSection, followUpText, OUTPUT_HEAD_LINES, OUTPUT_TAIL_LINES, printable, talksIn } from "../server/tasks/runner.js";
import { processTransport } from "../server/tasks/transport.js";
import type { CheckoutWork, FolderWork, PushAnswer, PushAsk, RemoteWork, RunnerTask, TaskOutcome, WorkspaceWork } from "./link.js";
import { WORKING_COPIES_MAX, workingCopies } from "./workspace.js";
import { keepOpencodeModel, personalOpencodeModel } from "./opencode-model.js";
import { personalRules } from "./opencode-rules.js";
import { runOpencodeAsYou } from "./opencode-session.js";
import { folderPlace } from "./folders.js";
import { installedTeamPlugin, installedTeamSkills } from "./team-plugin.js";
import { machineMcpServers } from "./machine-mcp.js";
import { environmentSecrets, keepOwnToolsHere, maskEvent, ownMcpTool, ownRequest } from "./mask.js";
import { orgDir } from "./profile.js";
import { STOPPED } from "./task.js";
import type { ExecutorHooks, TaskExecutor } from "./task.js";

/**
 * Every git call of the machine's runner: only https and ssh transports, so an address can never
 * have git read a local path or run a command; no hook and no file monitor; never a prompt for a
 * password nobody is there to type. The git directory is the task's own, outside the folder the
 * agent works in, so nothing the agent writes there (a remote, a command, an include) is read.
 */
const SAFE_GIT = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false"];

/**
 * The process's own limit stays out of the way: the task's time is kept by the session, which
 * stops counting while a question waits for its person. The largest delay a timer takes; past it
 * Node fires at once.
 */
const NO_PROCESS_LIMIT_MS = 2 ** 31 - 1;

/** How long the team's tests may run on the machine. */
export const TEST_TIMEOUT_MS = 10 * 60_000;

export interface MachineExecutorOptions {
  dataDir: string;
  org: string;
  /** This machine's id in the organization: a folder task names the machine its folder is on. */
  machineId: string;
  /** The folders a task works in in place now, which an undo leaves alone until the task ends; shared with the runner's undo. */
  working?: Set<string>;
  adapters: readonly AgentAdapter[];
  hostEnv: Record<string, string | undefined>;
  /** More git settings and environment; tests point a forge's address at a local repository with them, the command line never sets them. */
  gitConfig?: readonly string[];
  gitEnv?: Record<string, string>;
  checkSandbox?: () => Promise<CheckSandbox>;
}

class Ended extends Error {
  constructor(readonly status: "failed" | "interrupted", message: string, readonly kept: Pick<TaskOutcome, "nativeSessionId" | "limitResetAt"> = { nativeSessionId: null }) {
    super(message);
  }
}

const CONVERSATION_PROCESS_MS = 2 ** 31 - 1;

const ended = (status: TaskOutcome["status"], error: string | null): TaskOutcome => ({ status, error, nativeSessionId: null, branch: null, position: null, request: null });

/** The person's environment for git: their own config and credentials, nothing that would point git at another config, directory or transport. */
function gitEnvOf(hostEnv: Record<string, string | undefined>, extra: Record<string, string>): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(hostEnv).filter(([key, value]) => value !== undefined && !/^GIT_(CONFIG|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE|NAMESPACE|ALLOW_PROTOCOL|PROTOCOL_FROM_USER|SSH)/.test(key)));
  return { ...kept, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:ssh", ...extra };
}

function gitCaller(env: NodeJS.ProcessEnv, gitConfig: readonly string[]) {
  return (cwd: string, args: readonly string[], options: { signal?: AbortSignal; extraEnv?: Record<string, string>; before?: readonly string[] } = {}) =>
    new Promise<string>((resolve, reject) => {
      execFile("git", [...SAFE_GIT, ...gitConfig, ...(options.before ?? []), ...args], { cwd, env: { ...env, ...options.extraEnv }, maxBuffer: 16 * 1024 * 1024, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
        if (error) {
          const said = String(stderr || error.message).trim().split("\n").map((line) => line.trim());
          const reason = said.find((line) => line.startsWith("! [")) ?? said.find((line) => /^(fatal|error):/.test(line)) ?? said.pop() ?? "";
          reject(new Error(`git ${args[0] === "-C" ? args[2] : args[0]} failed: ${new Redactor().line(reason.replace(/\s+/g, " "))}`));
        } else resolve(String(stdout));
      });
    });
}

/**
 * Runs a task leased from a team's orchestrator on the person's own machine: their git, their
 * Claude Code sign-in held to the team's guard, their push. It reads only what the lease
 * describes, refuses a change that looks like it carries a secret before anything leaves the
 * machine, never opens the request (the orchestrator checks the pushed branch first), and keeps
 * the checkout only for a task that can Continue.
 */
export function machineExecutor({ dataDir, org, machineId, working = new Set(), adapters, hostEnv, gitConfig = [], gitEnv = {}, checkSandbox }: MachineExecutorOptions): TaskExecutor {
  const env = gitEnvOf(hostEnv, gitEnv);
  let foundSandbox: Promise<CheckSandbox> | null = null;
  const checkBox = () => (foundSandbox ??= (checkSandbox ?? (() => findCheckSandbox(process.platform, hostEnv.PATH)))());
  const call = gitCaller(env, gitConfig);
  const git = (paths: TaskPaths, args: readonly string[], { noDirs, ...options }: { signal?: AbortSignal; extraEnv?: Record<string, string>; noDirs?: boolean } = {}) =>
    call(paths.root, args, { ...options, before: noDirs ? [] : ["--git-dir", paths.git, "--work-tree", paths.work] });

  return {
    async run(task: RunnerTask, hooks: ExecutorHooks): Promise<TaskOutcome> {
      const work = task.work;
      if (!work) return ended("failed", "The orchestrator handed this machine no description of the task.");
      const adapter = adapters.find((a) => a.id === task.agent);
      if (!adapter) return ended("failed", `This machine runs no ${task.agent} for tasks yet.`);
      const root = join(orgDir(dataDir, org), "tasks", task.id);
      if ("folder" in work) return inFolder(task, work, adapter, root, hooks);
      if ("workspace" in work) return inWorkspace(task, work, adapter, root, hooks);
      if (work.branch === work.repo.baseBranch) return ended("failed", "The task's branch is the repository's own base branch; nothing is pushed there.");
      const paths: TaskPaths = { root, work: join(root, "work"), home: join(root, "home"), tmp: join(root, "tmp"), git: join(root, "git") };
      const resume = task.nativeSession !== null && existsSync(paths.work) && existsSync(paths.git);
      if (task.nativeSession !== null && !resume) return ended("failed", "The checkout this task's session worked in is gone from this machine, so it cannot go on; start it again.");
      let outcome: TaskOutcome;
      try {
        outcome = await runIn(task, work, adapter, paths, resume, hooks);
      } catch (error) {
        outcome = error instanceof Ended ? { ...ended(error.status, error.message), ...error.kept } : ended("failed", error instanceof Error ? error.message : String(error));
      }
      if (outcome.status !== "interrupted") {
        await releasePersonalGuard(root);
        await rm(root, { recursive: true, force: true });
      }
      return outcome;
    },
  };

  async function runIn(task: RunnerTask, work: CheckoutWork, adapter: AgentAdapter, paths: TaskPaths, resume: boolean, hooks: ExecutorHooks): Promise<TaskOutcome> {
    if (!resume) {
      await releasePersonalGuard(paths.root);
      await rm(paths.root, { recursive: true, force: true });
      await Promise.all([paths.work, paths.home, paths.tmp].map((dir) => mkdir(dir, { recursive: true })));
      await git(paths, ["init", "--quiet", "--bare", paths.git], { noDirs: true });
      if (work.continues) {
        await git(paths, ["fetch", "--quiet", "--no-tags", work.repo.url, work.continues.branch], { signal: hooks.signal });
        if ((await git(paths, ["rev-parse", "FETCH_HEAD"])).trim() !== work.continues.head) throw new Ended("failed", "The request's branch moved since the orchestrator read it; nothing was changed.");
        await git(paths, ["read-tree", "--reset", "-u", work.continues.head]);
        hooks.log(`Continued ${work.continues.branch} at ${work.continues.head.slice(0, 7)} into a folder of this machine's.`);
      } else {
        await git(paths, ["fetch", "--quiet", "--no-tags", work.repo.url, work.repo.baseBranch], { signal: hooks.signal });
        const have = await git(paths, ["cat-file", "-e", `${work.repo.baseSha}^{commit}`]).then(() => true, () => false);
        if (!have) await git(paths, ["fetch", "--quiet", "--no-tags", work.repo.url, work.repo.baseSha], { signal: hooks.signal });
        await git(paths, ["read-tree", "--reset", "-u", work.repo.baseSha]);
        hooks.record({ baseSha: work.repo.baseSha });
        hooks.log(`Checked out ${work.repo.baseBranch} at ${work.repo.baseSha.slice(0, 7)} into a folder of this machine's.`);
      }
    }
    const [name, email] = await Promise.all(["user.name", "user.email"].map((key) => git(paths, ["config", key]).then((v) => v.trim(), () => "")));
    if (!name || !email) throw new Ended("failed", 'Your git has no name or email to commit with; run git config --global user.name "Your Name" and git config --global user.email you@example.com, then start the task again.');
    const result = await agentRun(task, work, adapter, paths, resume, hooks);

    // Checked here before anything leaves the machine: a secret on the forge is out, whatever
    // the orchestrator decides after. The orchestrator checks the pushed branch again.
    const start = work.continues?.head ?? work.repo.baseSha;
    const changes = await collectChanges(paths, start, (text) => new Redactor().carriesCredential(text));
    if ("refused" in changes) throw new Ended("failed", changes.refused);
    if (!changes.files.length) throw new Ended(result.stopped ? "interrupted" : "failed", result.stopped ?? "The agent changed nothing, so there is nothing to push.");
    const tree = (await git(paths, ["write-tree"])).trim();
    const who = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
    const commit = (await git(paths, ["commit-tree", tree, "-p", start, "-m", task.title], { extraEnv: who })).trim();
    hooks.record({ stage: "request" });
    if (!(await hooks.leaseHeld())) throw new Ended("interrupted", "This machine no longer holds the task, so its change was not pushed.");
    await git(paths, ["push", "--quiet", work.repo.url, `${commit}:refs/heads/${work.branch}`], result.stopped ? {} : { signal: hooks.signal });
    hooks.record({ branch: work.branch });
    hooks.log(`Pushed ${work.branch} with your own git; the orchestrator checks it before the request opens.`);
    if (result.stopped) hooks.log(keptAfterStop(result.stopped));
    const body = result.summary.split("\n").map((line) => new Redactor().line(line)).join("\n");
    return { status: "needs-review", error: result.stopped ?? null, nativeSessionId: result.nativeSessionId, branch: work.branch, position: null, request: { title: task.title, body } };
  }

  /**
   * A task in a folder without git on this machine: the agent edits the folder itself, and the
   * machine's own shadow of it records the folder before and after, so the person keeps or undoes
   * the difference. The folder is read against this machine's own rule, whatever the lease says:
   * a folder on another machine, outside the home, in Library, in the runner's data, turned into a
   * link or into a git repository since it was opened is not worked in. What leaves the machine is
   * the paths changed and their counts, never their content. What the agent changed is recorded
   * however the run ends, so a failed or stopped one can be undone too.
   */
  async function inFolder(task: RunnerTask, work: FolderWork, adapter: AgentAdapter, root: string, hooks: ExecutorHooks): Promise<TaskOutcome> {
    if (work.folder.machineId !== machineId) return ended("failed", "This task's folder is on another of your machines, so this one does not run it.");
    if (task.nativeSession !== null) return ended("failed", "A task in a folder does not go on from an earlier run; start it again.");
    const place = await folderPlace(work.folder.path, work.folder.projectId, { home: hostEnv.HOME || homedir(), dataDir, shadows: join(orgDir(dataDir, org), "shadow") });
    if ("refused" in place) return ended("failed", `The task did not run: ${place.refused}.`);
    if (await isGitFolder(place.folder)) return ended("failed", "The task did not run: the folder is a git repository now; open it again so its tasks run on a branch.");
    if (working.has(place.folder)) return ended("failed", "The task did not run: another task is working in this folder now; start it again when that one ends.");
    working.add(place.folder);
    const paths: TaskPaths = { root, work: place.folder, home: join(root, "home"), tmp: join(root, "tmp"), git: join(root, "git") };
    let before: string | null = null;
    let kept: NonNullable<TaskOutcome["changes"]> | null = null;
    const keep = async () => {
      if (!before || kept) return kept;
      const after = await shadowSnapshot(place, `after ${task.id}`);
      if ("refused" in after) {
        hooks.log(`The folder could not be recorded after the agent ran: ${after.refused}.`);
        return null;
      }
      const changes = await shadowChanges(place, before, after.sha);
      if (typeof changes === "string") {
        hooks.log(`The folder's changes could not be read: ${changes}.`);
        return null;
      }
      kept = { before, after: after.sha, files: changes.files };
      const named = [...changes.files.map((f) => f.path), ...changes.untracked.map((f) => f.path)];
      if (named.length) hooks.log(`The agent changed ${named.length} file(s) in the folder: ${named.join(", ")}`);
      return kept;
    };
    let outcome: TaskOutcome;
    try {
      await releasePersonalGuard(root);
      await rm(root, { recursive: true, force: true });
      await Promise.all([paths.home, paths.tmp].map((dir) => mkdir(dir, { recursive: true })));
      const first = await shadowSnapshot(place, `before ${task.id}`);
      if ("refused" in first) throw new Ended("failed", `The task did not run: ${first.refused}.`);
      before = first.sha;
      hooks.log(`Working in ${basename(place.folder)} in place: the agent edits the folder's files, and what it changes is kept for you to review and undo.`);
      const result = await agentRun(task, work, adapter, paths, false, hooks);
      const changes = await keep();
      if (!changes) throw new Ended("failed", "The folder could not be read back after the agent ran; what it changed stays in the folder.");
      if (!changes.files.length) throw new Ended(result.stopped ? "interrupted" : "failed", result.stopped ?? "The agent changed nothing in the folder.");
      if (result.stopped) hooks.log(keptAfterStop(result.stopped));
      const refused = await refusedInPlace(work.rules, changes.files.map((f) => f.path), place, changes.before, changes.after);
      outcome = refused
        ? { ...ended("failed", refused.failed), changes: { ...changes, undone: refused.undone } }
        : { status: "needs-review", error: result.stopped ?? null, nativeSessionId: result.nativeSessionId, branch: null, position: null, request: null, changes };
    } catch (error) {
      const changes = await keep().catch(() => null);
      outcome = { ...(error instanceof Ended ? { ...ended(error.status, error.message), ...error.kept } : ended("failed", error instanceof Error ? error.message : String(error))), changes };
    }
    await releasePersonalGuard(root);
    await rm(root, { recursive: true, force: true });
    working.delete(place.folder);
    return outcome;
  }

  async function inWorkspace(task: RunnerTask, work: WorkspaceWork, adapter: AgentAdapter, root: string, hooks: ExecutorHooks): Promise<TaskOutcome> {
    if (work.workspace.machineId !== machineId) return ended("failed", "This task's folder is on another of your machines, so this one does not run it.");
    const place = await folderPlace(work.workspace.path, work.workspace.projectId, { home: hostEnv.HOME || homedir(), dataDir, shadows: join(orgDir(dataDir, org), "shadow") });
    if ("refused" in place) return ended("failed", `The task did not run: ${place.refused}.`);
    const paths: TaskPaths = { root, work: join(root, "work"), home: join(root, "home"), tmp: join(root, "tmp"), git: join(root, "git") };
    const manifest = join(root, "repos.json");
    const resume = task.nativeSession !== null && existsSync(manifest);
    if (task.nativeSession !== null && !resume) return ended("failed", "The copies this task's session worked on are gone from this machine, so it cannot go on; start it again.");
    let outcome: TaskOutcome;
    try {
      const repos = resume ? (JSON.parse(await readFile(manifest, "utf8")) as WorkspaceRepo[]) : await copyRepos(place.folder, paths, manifest, hooks, work);
      const result = await agentRun(task, work, adapter, paths, resume, hooks);
      outcome = await deliverRepos(task, work, place.folder, paths, repos, result, hooks);
    } catch (error) {
      outcome = error instanceof Ended ? { ...ended(error.status, error.message), ...error.kept } : ended("failed", error instanceof Error ? error.message : String(error));
    }
    if (outcome.status !== "interrupted") {
      await releasePersonalGuard(root);
      await rm(root, { recursive: true, force: true });
    }
    return outcome;
  }

  async function copyRepos(folder: string, paths: TaskPaths, manifest: string, hooks: ExecutorHooks, work: WorkspaceWork): Promise<WorkspaceRepo[]> {
    await releasePersonalGuard(paths.root);
    await rm(paths.root, { recursive: true, force: true });
    await Promise.all([paths.work, paths.home, paths.tmp, paths.git].map((dir) => mkdir(dir, { recursive: true })));
    const found = await workingCopies(folder);
    if ("tooMany" in found) throw new Ended("failed", `The task did not run: the folder holds more than ${WORKING_COPIES_MAX} repositories; pick the one, or the folder of the few, the task is about.`);
    if (!found.length) throw new Ended("failed", "The task did not run: the folder holds no git repository; open it as a folder project to work in it in place.");
    const goingOn = work.continues?.repos ?? [];
    const gone = goingOn.find((entry) => !found.includes(entry.path));
    if (gone) throw new Ended("failed", `${gone.path || basename(folder)} is no longer a repository in the folder, so the task cannot go on from it; nothing was changed.`);
    const repos: WorkspaceRepo[] = [];
    for (const path of found) {
      const own = join(folder, path);
      const from = goingOn.find((entry) => entry.path === path);
      if (from) {
        const at = (await git(paths, ["-C", own, "rev-parse", "--verify", "--quiet", `refs/heads/${work.branch}^{commit}`], { noDirs: true }).catch(() => "")).trim();
        if (at !== from.head) throw new Ended("failed", `${work.branch} of ${path || basename(folder)} moved since the request was read; nothing was changed.`);
      }
      const head = from ? from.head : (await git(paths, ["-C", own, "rev-parse", "--verify", "HEAD^{commit}"], { noDirs: true }).catch(() => "")).trim();
      if (!head) {
        hooks.log(`${path || "The folder"} has no commit yet, so the task leaves it out.`);
        continue;
      }
      const objects = (await git(paths, ["-C", own, "rev-parse", "--path-format=absolute", "--git-common-dir"], { noDirs: true })).trim();
      const repo: WorkspaceRepo = { path, head, git: join(paths.git, path ? path.replace(/[^A-Za-z0-9._-]/g, "_") : "_folder"), ...(from ? { baseSha: from.baseSha } : {}) };
      const at = repoPaths(paths, repo);
      await mkdir(at.work, { recursive: true });
      await git(at, ["init", "--quiet", "--bare", at.git], { noDirs: true });
      await writeFile(join(at.git, "objects", "info", "alternates"), `${join(objects, "objects")}\n`);
      await git(at, ["read-tree", "--reset", "-u", head]);
      repos.push(repo);
    }
    if (!repos.length) throw new Ended("failed", "The task did not run: no repository in the folder has a commit to start from.");
    await writeFile(manifest, JSON.stringify(repos));
    if (goingOn.length) hooks.log(`Went on from ${work.branch} in ${goingOn.length} of the ${repos.length} repositories of ${basename(folder)}, where the request left it; the others start at their last commits.`);
    else hooks.log(`Copied ${repos.length} repositories of ${basename(folder)} for the agent at their last commits; what you have not committed there is not in the task, and your own copies stay as they are.`);
    return repos;
  }

  async function deliverRepos(task: RunnerTask, work: WorkspaceWork, folder: string, paths: TaskPaths, repos: readonly WorkspaceRepo[], result: { summary: string; nativeSessionId: string | null; stopped?: string }, hooks: ExecutorHooks): Promise<TaskOutcome> {
    const changed: WorkspaceRepo[] = [];
    for (const repo of repos) {
      const changes = await collectChanges(repoPaths(paths, repo), repo.head, (text) => new Redactor().carriesCredential(text));
      if ("refused" in changes) throw new Ended("failed", `${repo.path || basename(folder)}: ${changes.refused}`);
      if (changes.files.length) changed.push(repo);
    }
    if (!changed.length) throw new Ended(result.stopped ? "interrupted" : "failed", result.stopped ?? "The agent changed nothing, so there is nothing to push.");
    const body = result.summary.split("\n").map((line) => new Redactor().line(line)).join("\n");
    hooks.record({ stage: "request" });
    const delivered: NonNullable<TaskOutcome["repos"]> = [];
    for (const repo of changed) {
      const own = join(folder, repo.path);
      const at = repoPaths(paths, repo);
      const [name, email] = await Promise.all(["user.name", "user.email"].map((key) => git(paths, ["-C", own, "config", key], { noDirs: true }).then((v) => v.trim(), () => "")));
      if (!name || !email) throw new Ended("failed", 'Your git has no name or email to commit with; run git config --global user.name "Your Name" and git config --global user.email you@example.com, then start the task again.');
      const tree = (await git(at, ["write-tree"])).trim();
      const commit = (await git(at, ["commit-tree", tree, "-p", repo.head, "-m", task.title], { extraEnv: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } })).trim();
      if (!(await hooks.leaseHeld())) throw new Ended("interrupted", "This machine no longer holds the task, so its change was not pushed.");
      const label = repo.path || basename(folder);
      const refused = await git(paths, ["-C", own, "fetch", "--quiet", "--no-tags", at.git, `${commit}:refs/heads/${work.branch}`], { noDirs: true, ...(result.stopped ? {} : { signal: hooks.signal }), extraEnv: { GIT_ALLOW_PROTOCOL: "file" } }).then(
        () => null,
        (error: Error) => {
          if (!result.stopped) stopped(hooks);
          return error.message;
        },
      );
      if (refused) {
        hooks.log(`${label}: the change was not written to ${work.branch} in your repository (${refused}); it is left out of this task.`);
        continue;
      }
      const origin = withoutCredential((await git(paths, ["-C", own, "config", "--get", "remote.origin.url"], { noDirs: true }).catch(() => "")).trim());
      const target = origin ? (await git(paths, ["-C", own, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { noDirs: true }).catch(() => "")).trim().replace(/^origin\//, "") || null : null;
      if (origin && !target) hooks.log(`${label} does not say which branch its origin's default is, so its request has no target; git remote set-head origin -a in it names one.`);
      hooks.log(origin ? `The branch ${work.branch} of ${label} is in your repository; this machine pushes nothing to its origin, so the push is yours.` : `${label} has no remote; its branch ${work.branch} is in your repository.`);
      delivered.push({ path: repo.path, branch: work.branch, head: commit, baseSha: repo.baseSha ?? repo.head, origin, target, request: { title: task.title, body }, pushed: false });
    }
    if (!delivered.length) throw new Ended("failed", "No repository's change could be written to its task branch, so there is nothing to review; the log says why for each.");
    if (result.stopped) hooks.log(keptAfterStop(result.stopped));
    return { status: "needs-review", error: result.stopped ?? null, nativeSessionId: result.nativeSessionId, branch: null, position: null, request: null, repos: delivered };
  }

  /**
   * The agent's run in `paths.work`, as its person, held to the team's guard, and the team's checks
   * around it: before the agent and after it, with a repair round of the same agent while a check it
   * broke still fails. Throws Ended for any end but a finished one; checks that fail do not end it,
   * as the orchestrator keeps what they showed and the request says so.
   */
  async function agentRun(task: RunnerTask, work: RemoteWork, adapter: AgentAdapter, paths: TaskPaths, resume: boolean, hooks: ExecutorHooks): Promise<{ summary: string; nativeSessionId: string | null; stopped?: string }> {
    const ready = await prepare(work, paths, hooks);
    const checks = work.limits.verification;
    const box = checks || (checks === undefined && work.limits.testCommand) ? await checkBox() : null;
    const sandbox = box && !("refused" in box) ? box : null;
    const refused = box && "refused" in box ? box.refused : null;
    if (refused) hooks.log(`No check runs on this task: ${refused}.`);
    const io: VerifyIo = { read: folderReader(paths.work), run: (command) => runCheck(command, paths, hooks, ready.masked, sandbox!), log: async (...lines) => lines.forEach((line) => hooks.log(line)) };
    const prior = checks ? (refused ? { setup: null, before: null, notRun: refused } : resume ? { setup: null, before: null, notRun: null } : await verifyBefore(checks.plan, io, !("folder" in work))) : null;
    stopped(hooks);
    const first = await turn(task, work, adapter, paths, ready, hooks, ready.prompt, resume ? "resume" : "first").catch((error: unknown) => {
      if (stoppedByPerson(hooks)) return null;
      throw error;
    });
    if (!first) {
      if (checks) hooks.record({ verification: notRun("the task was stopped before its checks ran", checks.plan, prior ?? undefined) });
      return { summary: "", nativeSessionId: null, stopped: STOPPED };
    }
    let summary = first.summary;
    const stoppedAfter = () => {
      if (checks) hooks.record({ verification: notRun("the task was stopped before its checks ran", checks.plan, prior ?? undefined) });
      return { summary, nativeSessionId: first.nativeSessionId, stopped: STOPPED };
    };

    try {
      if (checks === undefined) await legacyTests(work, paths, hooks, ready.masked, sandbox);
      else if (checks === null) hooks.record({ tests: "skipped" });
      else {
        hooks.record({ stage: "tests" });
        const repair = async (prompt: string): Promise<string | null> => {
          try {
            const again = await turn(task, work, adapter, paths, ready, hooks, prompt, "repair");
            summary = `${summary.trim()}\n\nAfter a repair round: ${again.summary.trim()}`;
            return null;
          } catch (error) {
            if (hooks.signal.aborted) throw error;
            return error instanceof Error ? error.message : String(error);
          }
        };
        const verification = prior!.notRun ? notRun(prior!.notRun, checks.plan, prior!) : await verifyAfter(checks.plan, prior!, io, repair, checks.maxRepairs);
        stopped(hooks);
        hooks.record({ verification });
      }
    } catch (error) {
      if (stoppedByPerson(hooks)) return stoppedAfter();
      throw error;
    }
    return { summary, nativeSessionId: first.nativeSessionId };
  }

  async function prepare(work: RemoteWork, paths: TaskPaths, hooks: ExecutorHooks): Promise<Prepared> {
    // The person's own profile, held to the team's guard: their MCP tools that write stay away from
    // the agent, the repository's own .mcp.json servers start only as the person approved them, and
    // the paths the team's policies keep from Edit and Read are denied there, as no plugin hook runs.
    const project = await projectMcpServers(paths.work);
    if ("refused" in project) throw new Ended("failed", project.refused);
    // A folder's own settings load only where its person trusted them, which the orchestrator says in the lease.
    const folderSettings = "folder" in work && work.setup.folderSettings === true;
    const hooksOff = (await personalHooksRefusal(managedSettingsPlaces(hostEnv))) ?? (folderSettings ? await folderHooksRefusal(paths.work) : null);
    if (hooksOff) throw new Ended("failed", `The task did not run: ${hooksOff}.`);
    await writePersonalGuard(paths, project, work.rules);

    // The project's servers, their values from the person's own environment: none of the organization's reaches the machine.
    const shared = machineMcpServers(work.setup.mcpServers ?? {}, hostEnv);
    for (const note of shared.notes) hooks.log(note);
    const setup: AgentSetup = { skills: await teamSkillsHere(work, hooks), mcpServers: {}, mcpTools: work.setup.mcpTools, deniedTools: work.setup.deniedTools, personal: { ownSetup: work.setup.ownSetup === true, folderSettings }, approvedProjectMcp: shared.servers };
    await writeTeamSkills(paths, setup);
    const attached = await fetchAttachments(work, paths, hooks);
    if (attached.length) setup.readDirs = [join(paths.root, "attachments")];
    await writeApprovedProjectMcp(paths, setup);
    const prompt = attached.length ? [work.prompt, ...attachmentsSection(join(paths.root, "attachments"), attached)].join("\n") : work.prompt;
    return { setup, masked: [...shared.values, ...environmentSecrets(hostEnv)], prompt };
  }

  async function teamSkillsHere(work: RemoteWork, hooks: ExecutorHooks): Promise<AgentSetup["skills"]> {
    if (work.setup.ownSetup === true || !work.setup.plugin) return [];
    const found = installedTeamPlugin(hostEnv, work.setup.plugin);
    if ("missing" in found) {
      hooks.log(`The team's skills are not in this run: ${found.missing}.`);
      return [];
    }
    return installedTeamSkills(found.dir);
  }

  async function fetchAttachments(work: RemoteWork, paths: TaskPaths, hooks: ExecutorHooks): Promise<NonNullable<RemoteWork["attachments"]>> {
    if (!work.attachments?.length || !hooks.attachment) return [];
    const dir = join(paths.root, "attachments");
    await mkdir(dir, { recursive: true });
    const fetched: NonNullable<RemoteWork["attachments"]> = [];
    for (const file of work.attachments) {
      const bytes = await hooks.attachment(file.id).catch(() => null);
      if (!bytes) {
        hooks.log(`${file.name} was not fetched from the orchestrator, so the agent does not see it.`);
        continue;
      }
      await writeFile(join(dir, file.name), bytes);
      fetched.push(file);
    }
    if (fetched.length) hooks.log(`Fetched ${fetched.length} attached file(s) for the agent to read.`);
    return fetched;
  }

  async function turn(task: RunnerTask, work: RemoteWork, adapter: AgentAdapter, paths: TaskPaths, ready: Prepared, hooks: ExecutorHooks, prompt: string, kind: "first" | "resume" | "repair"): Promise<{ summary: string; nativeSessionId: string | null }> {
    if (adapter.servedAsYou) return servedTurn(work, adapter, paths, ready, hooks, prompt);
    const plans = work.planFirst === true && kind === "first" && adapter.twoWay?.capabilities.plan === true;
    const twoWay = talksIn(adapter, work.mode, true) || plans ? adapter.twoWay! : null;
    // A session is kept for Continue only by an agent that resumes one; its id is on record before it starts, so a crash keeps it too.
    const keeps = twoWay?.capabilities.resume === true && kind !== "repair";
    const sessionId = kind === "resume" ? task.nativeSession! : keeps ? randomUUID() : null;
    if (kind === "first" && sessionId) hooks.record({ nativeSession: sessionId });
    const launched = twoWay ? twoWay.launch(paths, ready.setup, { mode: work.mode, personal: true, questions: true, ...(plans ? { plan: true } : {}), ...(work.choices ? { choices: work.choices } : {}), ...(kind === "resume" ? { resume: sessionId! } : sessionId ? { sessionId } : {}) }) : null;
    for (const note of launched?.notes ?? []) hooks.log(note);
    const call = launched ? launched.call : adapter.invocation(paths, { title: task.title, prompt, ...(work.choices ? { choices: work.choices } : {}) }, ready.setup, true);
    const stdin = launched ? undefined : (call as { stdin?: string }).stdin;
    const stop = new AbortController();
    hooks.signal.addEventListener("abort", () => stop.abort(hooks.signal.reason), { once: true });
    const transport = processTransport(
      { program: call.program, args: call.args, env: { ...personalEnv(hostEnv, paths), ...call.env }, cwd: paths.work, ...(stdin ? { stdin } : {}) },
      { timeoutMs: NO_PROCESS_LIMIT_MS, signal: stop.signal, onLine: () => {}, onSpawn: (pgid) => hooks.onProcess(pgid, paths.root) },
    );
    hooks.log(`Starting ${adapter.label} with your own sign-in.`);
    const session = openSession(launched ? launched.codec : adapter.decoder(paths.work), transport, { steer: false });
    // A one-shot agent reads its whole prompt from stdin, to its end, before it starts.
    if (launched) session.sendTurn(prompt);
    else session.close();
    const result = await converse(session, hooks, work.limits.timeoutMs, stop, ownMcpTool(work.setup.mcpTools), ready.masked, launched !== null);
    stopped(hooks);
    if (result.timedOut) throw new Ended("failed", `The agent ran past the task's ${Math.round(work.limits.timeoutMs / 60_000)} minutes and was stopped.`);
    if (result.terminal?.status !== "completed") throw untilReset(work, result.terminal?.failure, result.terminal?.nativeSessionId ?? sessionId) ?? new Ended("failed", result.terminal?.failure?.message ?? "The agent stopped before it finished.");
    return { summary: result.terminal.summary, nativeSessionId: result.terminal.nativeSessionId ?? sessionId };
  }

  async function servedTurn(work: RemoteWork, adapter: AgentAdapter, paths: TaskPaths, ready: Prepared, hooks: ExecutorHooks, prompt: string): Promise<{ summary: string; nativeSessionId: string | null }> {
    await adapter.configure(paths, ready.setup);
    if (ready.setup.personal?.ownSetup !== true) {
      const model = await personalOpencodeModel(hostEnv);
      await keepOpencodeModel(join(paths.home, ".config", "opencode", "opencode.json"), model);
      if (model.model) hooks.log(`Your ${adapter.label} model ${model.model} is kept; the rest of your ${adapter.label} setup stays out of this task.`);
    }
    const served = adapter.servedAsYou!;
    const stop = new AbortController();
    hooks.signal.addEventListener("abort", () => stop.abort(hooks.signal.reason), { once: true });
    hooks.log(`Starting ${adapter.label} as you, on a server of its own for this task.`);
    let result: Awaited<ReturnType<typeof converse>> | null = null;
    const ran = await runOpencodeAsYou({
      program: served.program,
      cwd: paths.work,
      env: { ...personalEnv(hostEnv, paths), ...served.env(paths, ready.setup) },
      rules: personalRules(work.mode, ready.setup.deniedTools ?? [], work.rules, ready.setup.readDirs ?? []),
      timeoutMs: CONVERSATION_PROCESS_MS,
      signal: stop.signal,
      onProcess: (pgid) => hooks.onProcess(pgid, paths.root),
      talk: async (transport, codec) => {
        const session = openSession(codec, transport, { steer: false });
        session.sendTurn(prompt);
        result = await converse(session, hooks, work.limits.timeoutMs, stop, ownMcpTool(work.setup.mcpTools), ready.masked, true);
        return [];
      },
    }).catch((error: Error) => {
      throw new Ended("failed", `${adapter.label} did not start: ${new Redactor().line(error.message)}`);
    });
    stopped(hooks);
    const finished = result as Awaited<ReturnType<typeof converse>> | null;
    if (ran.timedOut || finished?.timedOut) throw new Ended("failed", `The agent ran past the task's ${Math.round(work.limits.timeoutMs / 60_000)} minutes and was stopped.`);
    if (finished?.terminal?.status !== "completed") throw new Ended("failed", finished?.terminal?.failure?.message ?? "The agent stopped before it finished.");
    return { summary: finished.terminal.summary, nativeSessionId: null };
  }

  async function legacyTests(work: RemoteWork, paths: TaskPaths, hooks: ExecutorHooks, masked: readonly string[], sandbox: SandboxTool | null): Promise<void> {
    if (!work.limits.testCommand || !sandbox) return hooks.record({ tests: "skipped" });
    hooks.record({ stage: "tests" });
    hooks.log("Running the team's tests.");
    const tested = await runCheck(work.limits.testCommand, paths, hooks, masked, sandbox);
    stopped(hooks);
    const passed = tested.code === 0 && !tested.timedOut;
    hooks.record({ tests: passed ? "passed" : "failed" });
    if (!passed) throw new Ended("failed", tested.timedOut ? "The team's tests ran past their time on this machine." : "The team's tests failed on the agent's change.");
  }

  // As on the orchestrator, HOME is the task's own, so a tool reading its sign-in from HOME finds none of the person's; it still runs as them.
  async function runCheck(command: string, paths: TaskPaths, hooks: ExecutorHooks, masked: readonly string[], sandbox: SandboxTool): Promise<StepRun> {
    const shown = new Redactor([...masked]).line(command);
    hooks.onEvent({ type: "tool_call", id: TESTS_OUTPUT, tool: "Bash", target: null, status: "started", command: shown });
    const tail = new OutputTail();
    const output = testOutput(hooks, masked, tail);
    const started = Date.now();
    const inv = { program: "/bin/sh", args: ["-c", command], env: taskEnv(hostEnv, paths), cwd: paths.work };
    const ran = await runProcess(await sandboxed(sandbox, checkPlaces(paths, { home: hostEnv.HOME, path: hostEnv.PATH }, dataDir), inv), { timeoutMs: TEST_TIMEOUT_MS, signal: hooks.signal, onLine: output.line });
    output.end();
    hooks.onEvent({ type: "tool_call", id: TESTS_OUTPUT, tool: "Bash", target: null, status: ran.code === 0 && !ran.timedOut ? "done" : "failed", command: shown });
    return { code: ran.code, timedOut: ran.timedOut, ms: Date.now() - started, ...tail.result() };
  }
}

type SandboxTool = Exclude<CheckSandbox, { refused: string }>;

interface WorkspaceRepo {
  path: string;
  head: string;
  git: string;
  baseSha?: string;
}

export function machinePush({ dataDir, org, hostEnv, gitConfig = [], gitEnv = {} }: Pick<MachineExecutorOptions, "dataDir" | "org" | "hostEnv" | "gitConfig" | "gitEnv">): (ask: PushAsk) => Promise<PushAnswer> {
  const git = gitCaller(gitEnvOf(hostEnv, gitEnv), gitConfig);
  return async (ask) => {
    const place = await folderPlace(ask.path, ask.projectId, { home: hostEnv.HOME || homedir(), dataDir, shadows: join(orgDir(dataDir, org), "shadow") });
    if ("refused" in place) return place;
    const label = ask.repo || basename(place.folder);
    const copies = await workingCopies(place.folder);
    if ("tooMany" in copies || !copies.includes(ask.repo)) return { refused: `${label} is not a repository of the folder` };
    const own = join(place.folder, ask.repo);
    const ref = `refs/heads/${ask.branch}`;
    if (ask.branch.startsWith("-") || !(await git(own, ["check-ref-format", ref]).then(() => true, () => false))) return { refused: `${ask.branch} is not a branch name` };
    const at = (await git(own, ["rev-parse", "--verify", "--quiet", ref]).catch(() => "")).trim();
    if (at !== ask.head) return { refused: `${ask.branch} of ${label} moved since the task ended, so it was not pushed; push it yourself once it is ready` };
    if (!(await git(own, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim()) return { refused: `${label} has no remote to push to` };
    const target = (await git(own, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim().replace(/^origin\//, "");
    if (target === ask.branch) return { refused: `${ask.branch} is the default branch of ${label}'s origin, where a task's branch is never pushed` };
    return git(own, ["push", "--quiet", "origin", `${ref}:${ref}`], { extraEnv: { GIT_ALLOW_PROTOCOL: "https:ssh:file" } }).then(
      () => ({ pushed: true as const }),
      (error: Error) => ({ refused: error.message.slice(0, FOLDER_TEXT_MAX) }),
    );
  };
}

function withoutCredential(remote: string): string | null {
  if (!remote) return null;
  if (!/^https?:\/\//i.test(remote)) return remote;
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

const repoPaths = (paths: TaskPaths, repo: WorkspaceRepo): TaskPaths => ({ ...paths, work: repo.path ? join(paths.work, repo.path) : paths.work, git: repo.git });

interface Prepared {
  setup: AgentSetup;
  masked: string[];
  prompt: string;
}

function untilReset(work: RemoteWork, failure: AgentFailure | undefined, nativeSessionId: string | null): Ended | null {
  if (failure?.class !== "usage_limit" || !failure.resetAt || !nativeSessionId || "folder" in work) return null;
  return new Ended("interrupted", failure.message, { nativeSessionId, limitResetAt: failure.resetAt });
}

function stoppedByPerson(hooks: ExecutorHooks): boolean {
  return hooks.signal.aborted && hooks.signal.reason instanceof Error && hooks.signal.reason.message === STOPPED;
}

const keptAfterStop = (reason: string) => `${reason} What the agent changed by then waits for review: keep it or undo it.`;

function stopped(hooks: ExecutorHooks): void {
  if (hooks.signal.aborted) throw new Ended("interrupted", hooks.signal.reason instanceof Error ? hooks.signal.reason.message : "Stopped.");
}

/** A terminal's colour and cursor codes, which the task's page shows as text, never draws. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** How much of the team's tests' output the task's log keeps, as on the orchestrator: the first lines as they come, then the last ones. */
export const TEST_OUTPUT_HEAD = OUTPUT_HEAD_LINES;
export const TEST_OUTPUT_TAIL = OUTPUT_TAIL_LINES;

/**
 * The team's tests' output as it runs, a whole line at a time to the task, masked here for what
 * looks like a credential and for the values of the person's environment that hold one, its
 * terminal codes taken out: the first lines as they come, and past them the last ones once the
 * tests end, with how many were left out.
 */
function testOutput(hooks: ExecutorHooks, values: readonly string[], kept: OutputTail): { line: (stream: "stdout" | "stderr", text: string) => void; end: () => void } {
  const masks = { stdout: new Redactor([...values]), stderr: new Redactor([...values]) };
  let seen = 0;
  let tail: string[] = [];
  return {
    line(stream, text) {
      if (!text.trim()) return;
      const safe = masks[stream].line(printable((stream === "stderr" ? `stderr: ${text}` : text).replace(ANSI, "")));
      kept.push(safe);
      if (++seen <= TEST_OUTPUT_HEAD) return hooks.onEvent({ type: "tool_output", id: TESTS_OUTPUT, lines: [safe] });
      tail.push(safe);
      if (tail.length >= 2 * TEST_OUTPUT_TAIL) tail = tail.slice(-TEST_OUTPUT_TAIL);
    },
    end() {
      tail = tail.slice(-TEST_OUTPUT_TAIL);
      const skipped = seen - TEST_OUTPUT_HEAD - tail.length;
      if (skipped > 0) hooks.onEvent({ type: "tool_output", id: TESTS_OUTPUT, lines: [`... ${skipped} line(s) of the tests' output left out ...`] });
      if (tail.length) hooks.onEvent({ type: "tool_output", id: TESTS_OUTPUT, lines: tail });
    },
  };
}

/**
 * The session from its first message to its end: every event to the orchestrator, each question
 * to the person and back. Its input closes once its turn is done and nothing it left running in
 * the background still goes. The task's time counts only while the agent works: a question
 * waiting for its person stops the clock (design #14), and the agent is stopped when it runs out.
 */
async function converse(session: AgentSession, hooks: ExecutorHooks, timeoutMs: number, stop: AbortController, own: (tool: string) => boolean, values: readonly string[], talks: boolean): Promise<{ terminal: Extract<AgentEvent, { type: "terminal" }> | null; timedOut: boolean }> {
  // The values the person's environment gave the project's servers are masked too, wherever the agent repeats them.
  const redactor = new Redactor(values);
  const mask = (text: string) => redactor.line(text);
  let left = timeoutMs;
  let since = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let waiting = 0;
  let turnDone = false;
  let background = 0;
  const run = () => {
    since = Date.now();
    timer = setTimeout(() => {
      timedOut = true;
      session.stop();
    }, left);
  };
  const pause = () => {
    if (waiting++ > 0 || !timer) return;
    clearTimeout(timer);
    timer = null;
    left -= Date.now() - since;
  };
  const resume = () => {
    if (--waiting === 0 && !timedOut) run();
  };
  const closeIfDone = () => {
    if (turnDone && background === 0) session.close();
  };
  run();
  stop.signal.addEventListener("abort", () => session.stop(), { once: true });
  let terminal: Extract<AgentEvent, { type: "terminal" }> | null = null;
  const answers: Promise<void>[] = [];
  try {
    for await (const event of session.events) {
      const kept = keepOwnToolsHere(event, own);
      const masked = kept && maskEvent(kept, mask);
      if (masked) hooks.onEvent(masked as AgentEvent);
      if (event.type === "request") {
        pause();
        answers.push(
          hooks.decide(own(event.request.tool) ? ownRequest(event.request) : event.request).then(
            ({ decision, note, answers: given, plan }) => {
              resume();
              if (given) session.reply(event.request.id, given);
              else if (plan !== undefined && decision !== "deny") session.approvePlan(event.request.id, plan);
              else session.respond(event.request.id, decision, note);
            },
            () => resume(),
          ),
        );
      }
      // What the agent spends counts on the task as it is spent, as a run on the orchestrator's does.
      if (event.type === "usage") hooks.record({ cost: event.cost });
      if (event.type === "background") {
        background = event.pending;
        closeIfDone();
      }
      if (event.type === "turn_finished") {
        // A follow-up the person sent while the agent worked is its next turn; a one-shot run takes none.
        const [next] = talks ? (hooks.followUps?.() ?? []) : [];
        if (next) {
          session.sendTurn(followUpText(next));
          hooks.delivered?.([next.id]);
          hooks.log("Sent a follow-up to the agent.");
          hooks.onEvent({ type: "steer", text: next.text, by: next.createdBy });
        } else {
          turnDone = true;
          closeIfDone();
        }
      }
      if (event.type === "terminal") terminal = event;
    }
  } finally {
    if (timer) clearTimeout(timer);
    await Promise.allSettled(answers);
  }
  return { terminal, timedOut };
}
