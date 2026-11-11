import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAgentAdapter } from "../server/tasks/agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import type { RunnerTask, TaskProgress, WorkspaceWork } from "./link.js";
import { machineExecutor, machinePush } from "./machine-executor.js";
import { STOPPED } from "./task.js";
import type { ExecutorHooks } from "./task.js";

const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");
const FORGE = "https://forge.example.invalid/payments-api.git";
const REMOTE = "https://max:stand-in-token@forge.example.invalid/payments-api.git";

describe("a task in its person's one work folder on their machine", { timeout: 60_000 }, () => {
  let root: string;
  let home: string;
  let code: string;
  let forge: string;
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "machine-workspace-")));
    home = join(root, "home");
    code = join(home, "code");
    forge = join(root, "forge.git");
    mkdirSync(join(home, "runner-data"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Max Example\n\temail = max@example.invalid\n");
    git(["init", "--quiet", "--bare", "--initial-branch=main", forge], root);
    for (const name of ["payments-api", "notes"]) {
      const repo = join(code, name);
      mkdirSync(repo, { recursive: true });
      git(["init", "--quiet", "--initial-branch=main"], repo);
      writeFileSync(join(repo, "README.md"), `${name}\n`);
      git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "add", "-A"], repo);
      git(["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "--quiet", "-m", "start"], repo);
    }
    git(["remote", "add", "origin", REMOTE], join(code, "payments-api"));
    git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], join(code, "payments-api"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const options = () => ({ dataDir: join(home, "runner-data"), org: "acme", hostEnv: { PATH: process.env.PATH, HOME: home }, gitConfig: ["-c", `url.${forge}.insteadOf=${REMOTE}`, "-c", "protocol.file.allow=always"] });

  async function run(prompt: string) {
    const log: string[] = [];
    const records: TaskProgress[] = [];
    const work: WorkspaceWork = { prompt, mode: "auto", choices: null, setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 60_000, testCommand: null, verification: null }, rules: [], workspace: { machineId: "mch_here", projectId: "prj_code", path: "~/code" }, branch: "task/tsk_ws_1" };
    const hooks: ExecutorHooks = { signal: new AbortController().signal, onEvent: () => {}, log: (text) => void log.push(text), record: (p) => void records.push(p), onProcess: () => {}, decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
    const task: RunnerTask = { id: "tsk_ws_1", title: "Add an on-call note", agent: "fake", nativeSession: null, work };
    const executor = machineExecutor({ ...options(), machineId: "mch_here", adapters: [fakeAgentAdapter(FAKE_AGENT)] });
    return { outcome: await executor.run(task, hooks), log, records };
  }

  it("given a folder of two repositories, when the agent changes one with a remote, then its branch is in the person's repository on its last commit, nothing reaches the forge, the person's checkout is left as it was, and the other repository gets nothing", async () => {
    // given
    const before = git(["rev-parse", "HEAD"], join(code, "payments-api"));

    // when
    const { outcome, log } = await run("Task: Add an on-call note\nstand-in: work in payments-api");

    // then
    expect(outcome).toMatchObject({ status: "needs-review", branch: null, request: null, repos: [{ path: "payments-api", branch: "task/tsk_ws_1", baseSha: before, origin: FORGE, target: "main", request: { title: "Add an on-call note" }, pushed: false }] });
    expect(git(["rev-parse", "task/tsk_ws_1"], join(code, "payments-api"))).toBe(outcome.repos![0]!.head);
    expect(git(["rev-parse", "task/tsk_ws_1^"], join(code, "payments-api"))).toBe(before);
    expect(git(["for-each-ref"], forge)).toBe("");
    expect(log).toContain("The branch task/tsk_ws_1 of payments-api is in your repository; this machine pushes nothing to its origin, so the push is yours.");
    expect(git(["rev-parse", "HEAD"], join(code, "payments-api"))).toBe(before);
    expect(git(["status", "--porcelain"], join(code, "payments-api"))).toBe("");
    expect(existsSync(join(code, "payments-api", "skills"))).toBe(false);
    expect(git(["branch", "--list", "task/*"], join(code, "notes"))).toBe("");
  });

  it("given a repository with no remote, when the agent changes it, then its branch is in the person's repository and the log says so", async () => {
    // when
    const { outcome, log } = await run("Task: Add an on-call note\nstand-in: work in notes");

    // then
    expect(outcome).toMatchObject({ status: "needs-review", repos: [{ path: "notes", branch: "task/tsk_ws_1", origin: null, target: null, request: { title: "Add an on-call note" }, pushed: false }] });
    expect(git(["rev-parse", "task/tsk_ws_1"], join(code, "notes"))).toBe(outcome.repos![0]!.head);
    expect(log).toContain("notes has no remote; its branch task/tsk_ws_1 is in your repository.");
  });

  it("given a task's branch left in the person's repository, when they press to push it, then the commit the task left reaches the origin, and a branch that moved since or a path out of the folder is refused", async () => {
    // given
    const { outcome } = await run("Task: Add an on-call note\nstand-in: work in payments-api");
    const head = outcome.repos![0]!.head;
    const push = machinePush(options());
    const ask = { nonce: "n1", projectId: "prj_code", path: "~/code", repo: "payments-api", branch: "task/tsk_ws_1" };

    // when
    const moved = await push({ ...ask, head: git(["rev-parse", "main"], join(code, "payments-api")) });
    const outside = await push({ ...ask, repo: "../code/payments-api", head });
    const pushed = await push({ ...ask, head });

    // then
    expect(moved).toEqual({ refused: expect.stringMatching(/^task\/tsk_ws_1 of payments-api moved since the task ended/) });
    expect(outside).toEqual({ refused: "../code/payments-api is not a repository of the folder" });
    expect(pushed).toEqual({ pushed: true });
    expect(git(["rev-parse", "task/tsk_ws_1"], forge)).toBe(head);
  });

  it("given an agent that changed a repository's copy and is still working, when its person stops the task, then the change reaches the person's repository on the task's branch for review, with why it stopped", async () => {
    // given
    const before = git(["rev-parse", "HEAD"], join(code, "payments-api"));
    const base = fakeAgentAdapter(FAKE_AGENT);
    const writing: AgentAdapter = {
      ...base,
      twoWay: {
        capabilities: base.twoWay!.capabilities,
        launch(paths, setup, options) {
          writeFileSync(join(paths.work, "payments-api", "ON-CALL.md"), "Page the on-call engineer.\n");
          return base.twoWay!.launch(paths, setup, options);
        },
      },
    };
    const controller = new AbortController();
    const log: string[] = [];
    const hooks: ExecutorHooks = { signal: controller.signal, onEvent: () => {}, log: (text) => void log.push(text), record: () => {}, onProcess: () => setTimeout(() => controller.abort(new Error(STOPPED)), 300), decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
    const work: WorkspaceWork = { prompt: "Task: Add an on-call note\nstand-in: wait 30 seconds", mode: "auto", choices: null, setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 60_000, testCommand: null, verification: null }, rules: [], workspace: { machineId: "mch_here", projectId: "prj_code", path: "~/code" }, branch: "task/tsk_ws_1" };

    // when
    const outcome = await machineExecutor({ ...options(), machineId: "mch_here", adapters: [writing] }).run({ id: "tsk_ws_1", title: "Add an on-call note", agent: "fake", nativeSession: null, work }, hooks);

    // then
    expect(outcome).toMatchObject({ status: "needs-review", error: STOPPED, repos: [{ path: "payments-api", branch: "task/tsk_ws_1", baseSha: before }] });
    expect(git(["show", "task/tsk_ws_1:ON-CALL.md"], join(code, "payments-api"))).toBe("Page the on-call engineer.");
    expect(log).toContain(`${STOPPED} What the agent changed by then waits for review: keep it or undo it.`);
  });

  it("given an agent that changes no repository, when the run ends, then the task fails and no repository gets a branch", async () => {
    // when
    const { outcome } = await run("Task: Add an on-call note");

    // then
    expect(outcome).toMatchObject({ status: "failed", error: "The agent changed nothing, so there is nothing to push." });
    for (const name of ["payments-api", "notes"]) expect(git(["branch", "--list", "task/*"], join(code, name))).toBe("");
  });
});
