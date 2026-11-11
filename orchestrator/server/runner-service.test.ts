import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localLink } from "../runner/local-link.js";
import type { TaskOutcome } from "../runner/link.js";
import { startRunnerLoop } from "../runner/loop.js";
import type { TaskExecutor } from "../runner/task.js";
import { LEASE_MS, NotHeld, checkedWork, createRunnerService } from "./runner-service.js";
import { memoryStore, task } from "./runner-service.fixture.js";

const ADA = "ada@example.invalid";
const GRACE = "grace@example.invalid";

const open = () => new AbortController().signal;

describe("the runner service a local orchestrator's runner calls", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("given a task of another person queued, when this person's runner polls, then it leases only this person's task, and its log says when it started here", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-grace", GRACE), task("tsk-ada", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });

    const polled = await service.poll(ADA, "machine-1", 0, true, open());

    expect(polled.lease?.task.id).toBe("tsk-ada");
    expect(mem.queued.map((t) => t.id)).toEqual(["tsk-grace"]);
    expect(mem.logs.get("tsk-ada")).toEqual(["Started on this machine."]);
  });

  it("given a runner already running a task, when it polls, then it leases nothing more", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });

    const polled = await service.poll(ADA, "machine-1", 0, false, open());

    expect(polled.lease).toBeNull();
    expect(mem.queued).toHaveLength(1);
  });

  it("given a waiting poll, when a task is queued and the service is woken, then the poll returns it at once", async () => {
    const mem = memoryStore();
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const waiting = service.poll(ADA, "machine-1", 25_000, true, open());
    await vi.advanceTimersByTimeAsync(100);

    mem.queued.push(task("tsk-1", ADA));
    service.wake();
    await vi.advanceTimersByTimeAsync(0);

    expect((await waiting).lease?.task.id).toBe("tsk-1");
  });

  it("given the agent asks its person a question on a leased task, when the person answers it on the card, then the question is kept as asked and the runner is handed the person's answers under the agent's own request id", async () => {
    // given
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    const questions = [{ key: "q1", title: "Which logger?", choice: "one" as const, options: [{ value: "pino", label: "pino" }, { value: "winston", label: "winston" }], other: true }];

    // when
    await service.request("tsk-1", lease!.leaseId, { id: "question_1", kind: "question", tool: "question", summary: "Which logger?", questions });
    Object.assign(mem.requests[0]!, { status: "answered", answer: { answers: { q1: { chosen: ["pino"], other: null } } }, answeredBy: ADA, answeredVia: "web" });
    const polled = await service.poll(ADA, "machine-1", 0, false, open());

    // then
    expect(mem.requests[0]!.payload).toEqual({ tool: "question", summary: "Which logger?", questions });
    expect(polled.commands).toEqual([{ type: "answer", taskId: "tsk-1", requestId: "question_1", decision: "allow-once", answers: { q1: { chosen: ["pino"], other: null } } }]);
  });

  it("given the agent's plan, when its starter approves it as they changed it, then the runner gets the changed plan with the answer", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    await service.request("tsk-1", lease!.leaseId, { id: "plan_1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read the parcel tiers", plan: "1. Read the parcel tiers\n2. Fix the limit" });
    Object.assign(mem.requests[0]!, { status: "answered", answer: { decision: "allow_once", plan: "1. Fix the limit only" }, answeredBy: ADA, answeredVia: "web" });

    const polled = await service.poll(ADA, "machine-1", 0, false, open());

    expect(mem.requests[0]!.payload).toMatchObject({ plan: "1. Read the parcel tiers\n2. Fix the limit" });
    expect(polled.commands).toEqual([{ type: "answer", taskId: "tsk-1", requestId: "plan_1", decision: "allow-once", plan: "1. Fix the limit only" }]);
  });

  it("given the agent's plan, when its starter declines it, then the runner gets the decline and then a stop, so the task ends with the plan's reason", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    await service.request("tsk-1", lease!.leaseId, { id: "plan_1", kind: "plan", tool: "ExitPlanMode", summary: "1. Read the parcel tiers", plan: "1. Read the parcel tiers" });
    Object.assign(mem.requests[0]!, { status: "answered", answer: { decision: "deny" }, answeredBy: ADA, answeredVia: "web" });

    const polled = await service.poll(ADA, "machine-1", 0, false, open());

    expect(polled.commands).toEqual([{ type: "answer", taskId: "tsk-1", requestId: "plan_1", decision: "deny" }, { type: "stop", taskId: "tsk-1" }]);
  });

  it("given a person's answer in the browser, when the runner polls, then it gets the answer once under the agent's own request id and the next poll waits", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    await service.request("tsk-1", lease!.leaseId, { id: "toolu_1", kind: "command", tool: "Bash", summary: "npm test" });
    await service.request("tsk-1", lease!.leaseId, { id: "toolu_1", kind: "command", tool: "Bash", summary: "npm test" });
    Object.assign(mem.requests[0]!, { status: "answered", answer: { decision: "deny", note: "not on this host" }, answeredBy: ADA, answeredVia: "web" });

    const polled = await service.poll(ADA, "machine-1", 0, false, open());

    expect(mem.requests).toHaveLength(1);
    expect(mem.requests[0]!.expiresAt).toBeNull();
    expect(polled.commands).toEqual([{ type: "answer", taskId: "tsk-1", requestId: "toolu_1", decision: "deny", note: "not on this host" }]);
    const again = service.poll(ADA, "machine-1", 5_000, false, open());
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await again).commands).toEqual([]);
  });

  it("given a lease that ran out, when the runner writes, then nothing is written and the call answers as for a task it never held", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());

    await vi.advanceTimersByTimeAsync(LEASE_MS + 1);

    await expect(service.events("tsk-1", lease!.leaseId, [{ n: 1, event: { type: "message", text: "late" } }])).rejects.toBeInstanceOf(NotHeld);
    await expect(service.request("tsk-1", lease!.leaseId, { id: "toolu_1", kind: "command", tool: "Bash", summary: "ls" })).rejects.toBeInstanceOf(NotHeld);
    expect(mem.events.get("tsk-1")).toBeUndefined();
    expect(mem.requests).toEqual([]);
  });

  it("given a Stop for a held task, when the runner polls, then it gets the stop command", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    await service.poll(ADA, "machine-1", 0, true, open());

    expect(await service.stop("tsk-1")).toBe(true);

    expect((await service.poll(ADA, "machine-1", 0, false, open())).commands).toEqual([{ type: "stop", taskId: "tsk-1" }]);
    expect((await service.poll(ADA, "machine-1", 0, false, open())).commands).toEqual([]);
  });

  it("given the embedded runner and a queued task, when it runs to its end, then its events, its outcome and what follows it reach the orchestrator through the local link", async () => {
    const mem = memoryStore();
    const followed: string[] = [];
    const service = createRunnerService({ tenant: "acme", store: mem.store, onFinished: async (id) => void followed.push(id) });
    const outcome: TaskOutcome = { status: "needs-review", error: null, nativeSessionId: "native-1", branch: "handbook/task-1", position: null, request: null };
    const executor: TaskExecutor = {
      async run(_task, hooks) {
        hooks.onEvent({ type: "message", text: "editing the skill" });
        hooks.onEvent({ type: "terminal", status: "completed", summary: "done", nativeSessionId: "native-1" });
        expect(await hooks.leaseHeld()).toBe(true);
        return outcome;
      },
    };
    const loop = startRunnerLoop(localLink(service, ADA, "machine-1"), executor, { mask: (t) => t });

    mem.queued.push(task("tsk-1", ADA));
    service.wake();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mem.events.get("tsk-1")?.map((e) => [e.n, e.kind, e.text])).toEqual([
      [1, "message", "editing the skill"],
      [2, "terminal", "agent ended: completed"],
    ]);
    expect(mem.ended["tsk-1"]).toEqual({ status: "needs-review", error: null, nativeSession: "native-1", branch: "handbook/task-1" });
    expect(followed).toEqual(["tsk-1"]);
    const stopping = loop.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopping;
  });

  it("given the agent took its question back, when the event arrives, then the request is closed and no longer waits for anyone", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    await service.request("tsk-1", lease!.leaseId, { id: "toolu_1", kind: "command", tool: "Bash", summary: "npm test" });

    await service.events("tsk-1", lease!.leaseId, [{ n: 1, event: { type: "request_withdrawn", requestId: "toolu_1" } }]);

    expect(mem.requests[0]).toMatchObject({ status: "withdrawn", responseCapability: "not_resumable" });
  });

  it("given a machine reporting its agent's starting context, when the event arrives, then the task records it and its log gets no line", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());

    await service.events("tsk-1", lease!.leaseId, [{ n: 1, event: { type: "context", tokens: 18_400 } }]);

    expect(mem.contexts.get("tsk-1")).toBe(18_400);
    expect(mem.events.get("tsk-1") ?? []).toEqual([]);
  });

  it("given a machine reporting its turn's estimated cost and then a step's real cost, when each arrives, then the cost cap hears both, the real one once it is kept, and the log gets no line", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const heard: [string, number][] = [];
    const service = createRunnerService({ tenant: "acme", store: mem.store, onSpend: async (taskId, usd) => heard.push([taskId, usd]) });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());

    await service.events("tsk-1", lease!.leaseId, [{ n: 1, event: { type: "spend", usd: 0.42 } }]);
    await service.progress("tsk-1", lease!.leaseId, { cost: { usd: 0.2, inputTokens: null, outputTokens: null } });

    expect(heard).toEqual([["tsk-1", 0.42], ["tsk-1", 0]]);
    expect(mem.events.get("tsk-1") ?? []).toEqual([]);
  });

  it("given an interrupted task with its agent's session on record, when Continue queues it again, then the new lease hands the runner that session", async () => {
    const mem = memoryStore();
    mem.natives.set("tsk-1", "native-1");
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });

    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());

    expect(lease?.task.nativeSession).toBe("native-1");
  });

  it("given the executor recorded the agent's session before it started, when the runner's start finds the task still leased after a crash, then the session stays on record for Continue", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());

    await service.progress("tsk-1", lease!.leaseId, { nativeSession: "4b1c0a7e-0000-4000-8000-000000000001" });
    await service.recover("machine-1", "restarted");

    expect(mem.natives.get("tsk-1")).toBe("4b1c0a7e-0000-4000-8000-000000000001");
  });

  it("given a machine reports what the task's checks showed, when the orchestrator takes it, then it keeps them through its own reading and writes the tests' outcome from that reading, never from the machine's word, and only under the task's lease", async () => {
    // given
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const read: { taskId: string; raw: unknown }[] = [];
    const service = createRunnerService({ tenant: "acme", store: mem.store, checks: { record: async (taskId, raw) => (read.push({ taskId, raw }), "failed"), handed: async () => true } });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    const report = { checks: [], setup: null, repairs: 0, verdict: "passed", reason: "every check passes" } as never;

    // when
    await service.progress("tsk-1", lease!.leaseId, { tests: "passed", verification: report });
    const stale = service.progress("tsk-1", "lease-of-another", { verification: report });

    // then
    expect(read).toEqual([{ taskId: "tsk-1", raw: report }]);
    expect(mem.patched).toEqual([{ taskId: "tsk-1", patch: { tests: "failed" } }]);
    await expect(stale).rejects.toBeInstanceOf(NotHeld);
    expect(read).toHaveLength(1);
  });

  it("given a task handed checks, when its machine reports a tests outcome with no report of them, then the outcome is not written, as only the orchestrator's reading of the runs sets it", async () => {
    // given
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA), task("tsk-2", ADA));
    let handedOne = "";
    const service = createRunnerService({ tenant: "acme", store: mem.store, checks: { record: async () => "passed", handed: async (taskId) => taskId === handedOne } });
    const first = await service.poll(ADA, "machine-1", 0, true, open());
    const second = await service.poll(ADA, "machine-2", 0, true, open());
    handedOne = first.lease!.task.id;

    // when
    await service.progress(first.lease!.task.id, first.lease!.leaseId, { stage: "tests", tests: "passed" });
    await service.progress(second.lease!.task.id, second.lease!.leaseId, { tests: "passed" });

    // then
    expect(mem.patched).toEqual([
      { taskId: first.lease!.task.id, patch: { stage: "tests" } },
      { taskId: second.lease!.task.id, patch: { tests: "passed" } },
    ]);
  });

  it("given a machine away from the orchestrator, when it leases a task, then its lease carries the task as the orchestrator described it, and a task it cannot describe ends failed instead of being handed out bare", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA), task("tsk-2", ADA));
    const work = { prompt: "Task: Task tsk-1", mode: "auto" as const, choices: null, repo: { url: "https://git.example.invalid/payments-skills.git", baseBranch: "main", baseSha: "abc1234" }, branch: "task/tsk-1", rules: [], setup: { plugin: { name: "payments", version: "1.4.0" }, mcpTools: [], deniedTools: ["WebFetch"] }, limits: { timeoutMs: 1_800_000, testCommand: null } };
    const service = createRunnerService({ tenant: "acme", store: mem.store, describeWork: async (id) => (id === "tsk-1" ? work : Promise.reject(new Error("its repository is no longer connected"))) });

    const first = await service.poll(ADA, "machine-1", 0, true, open(), { work: true });
    const second = await service.poll(ADA, "machine-2", 0, true, open(), { work: true });

    expect(first.lease?.task.work).toEqual({ ...work, setup: { ...work.setup, ownSetup: false, folderSettings: false } });
    expect(second.lease).toBeNull();
    expect(mem.ended["tsk-2"]).toMatchObject({ status: "failed", error: "The task could not be handed to this machine: its repository is no longer connected" });
  });

  it("given a description whose clone address carries a token or is not https or ssh, or whose tools carry more than their names, when it would leave for a machine, then the address is refused and only names travel", () => {
    const work = { prompt: "p", mode: "auto" as const, choices: null, repo: { url: "https://x-access-token:ghs_example@git.example.invalid/p.git", baseBranch: "main", baseSha: "abc1234" }, branch: "task/t", rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1, testCommand: null } };
    expect(() => checkedWork(work)).toThrow(/carries a credential/);
    for (const url of ["file:///home/stand-in/repo", "ext::sh -c touch% /tmp/owned", "http://git.example.invalid/p.git"]) expect(() => checkedWork({ ...work, repo: { ...work.repo, url } })).toThrow(/neither https nor ssh|not one a machine can clone/);
    expect(checkedWork({ ...work, repo: { ...work.repo, url: "ssh://git@git.example.invalid/p.git" } }).repo.url).toBe("ssh://git@git.example.invalid/p.git");

    const tools = checkedWork({ ...work, repo: { ...work.repo, url: "https://git.example.invalid/p.git" }, setup: { plugin: { name: "payments", version: "1.4.0", token: "x" } as never, mcpTools: [{ server: "docs", tool: "search", env: { KEY: "secret" } } as never], deniedTools: ["Bash"] } });
    expect(tools.setup).toEqual({ plugin: { name: "payments", version: "1.4.0" }, mcpTools: [{ server: "docs", tool: "search" }], deniedTools: ["Bash"], ownSetup: false, folderSettings: false });
  });

  it("given a task with attachments, when its description would leave for a machine, then plain names of known kinds go and a name that is a path, or a kind no check knows, refuses the lease", () => {
    // given
    const work = (attachments: unknown) => ({ prompt: "p", mode: "auto" as const, choices: null, repo: { url: "https://git.example.invalid/p.git", baseBranch: "main", baseSha: "a".repeat(40) }, branch: "task/t", rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1, testCommand: null }, attachments: attachments as never });
    const fine = [{ id: "att_1", name: "screenshot.png", kind: "image" }, { id: "att_2", name: "spec v2.pdf", kind: "pdf" }];

    // when
    const taken = checkedWork(work(fine));

    // then
    expect(taken.attachments).toEqual(fine);
    for (const bad of [[{ id: "att_1", name: "../.ssh/config", kind: "text" }], [{ id: "att_1", name: "..", kind: "text" }], [{ id: "att_1", name: "run.sh", kind: "script" }], [{ id: "../x", name: "a.txt", kind: "text" }]]) expect(() => checkedWork(work(bad))).toThrow(/attachments are not ones a machine fetches/);
  });

  it("given a task in its person's one work folder, when its description would leave for a machine, then a folder named other than from the machine's home is refused", () => {
    // given
    const work = (path: string) => ({ prompt: "p", mode: "auto" as const, choices: null, workspace: { machineId: "machine-1", projectId: "prj_code", path }, branch: "task/t", rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1, testCommand: null } });

    // when
    const taken = checkedWork(work("~/code"));

    // then
    expect(taken.workspace.path).toBe("~/code");
    for (const path of ["/home/stand-in/code", "~/../elsewhere", "~/code/./x"]) expect(() => checkedWork(work(path))).toThrow(/work folder is not named from the machine's home/);
  });

  it("given a task going on from its open request, when its description would leave for a machine, then one whose branch is not the run's or whose head is not a full commit id is refused", () => {
    // given
    const work = { prompt: "p", mode: "auto" as const, choices: null, repo: { url: "https://git.example.invalid/p.git", baseBranch: "main", baseSha: "a".repeat(40) }, branch: "task/t", rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1, testCommand: null } };
    const head = "b".repeat(40);

    // when
    const taken = checkedWork({ ...work, continues: { branch: "task/t", head } });

    // then
    expect(taken.continues).toEqual({ branch: "task/t", head });
    expect(() => checkedWork({ ...work, continues: { branch: "main", head } })).toThrow(/goes on from a request/);
    expect(() => checkedWork({ ...work, continues: { branch: "task/t", head: "HEAD~1" } })).toThrow(/goes on from a request/);
  });

  it("given a task in a folder on one of its person's machines, when another of that person's machines polls, then it is not handed there, and a folder named other than from the machine's home is refused", async () => {
    // given
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const folder = (path: string) => ({ prompt: "p", mode: "auto" as const, choices: null, folder: { machineId: "machine-1", projectId: "prj_notes", path }, rules: [], setup: { plugin: null, mcpTools: [], deniedTools: [] }, limits: { timeoutMs: 1, testCommand: null } });
    const service = createRunnerService({ tenant: "acme", store: mem.store, describeWork: async () => folder("~/notes") });

    // when
    const other = await service.poll(ADA, "machine-2", 0, true, open(), { work: true });

    // then
    expect(other.lease).toBeNull();
    expect(mem.ended["tsk-1"]).toMatchObject({ status: "failed", error: "The task could not be handed to this machine: its folder is on another of its person's machines" });
    expect(checkedWork(folder("~/notes")).folder.path).toBe("~/notes");
    for (const path of ["/home/stand-in/notes", "~/../stand-in", "~/notes/./x", "~notes", "~//notes"]) expect(() => checkedWork(folder(path))).toThrow(/not named from the machine's home/);
    expect(() => checkedWork({ ...folder("~/notes"), rules: [{ action: "tool.use", resource: "tool:Edit:*.env", effect: "allow", reason: "r" }] as never })).toThrow(/policies are not ones/);
  });

  it("given a description with the person's own-setup choice and project servers by template, when it would leave for a machine, then the choice goes with it, the templates go as written, and a server carrying a value of its own or of another shape is refused by name", () => {
    // given
    const work = { prompt: "p", mode: "auto" as const, choices: null, repo: { url: "https://git.example.invalid/p.git", baseBranch: "main", baseSha: "abc1234" }, branch: "task/t", rules: [], limits: { timeoutMs: 1, testCommand: null } };
    const servers = { docs: { type: "http" as const, url: "https://docs.example.invalid/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } }, ledger: { type: "stdio" as const, command: "ledger-mcp", args: ["--read-only"], env: { LEDGER_URL: "${LEDGER_URL}" } } };
    const setup = (mcpServers: unknown) => ({ plugin: null, mcpTools: [], deniedTools: [], ownSetup: true, mcpServers: mcpServers as typeof servers });

    // when
    const checked = checkedWork({ ...work, setup: setup(servers) });

    // then
    expect(checked.setup).toEqual({ plugin: null, mcpTools: [], deniedTools: [], ownSetup: true, folderSettings: false, mcpServers: servers });
    expect(() => checkedWork({ ...work, setup: setup({ docs: { ...servers.docs, headers: { Authorization: "Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" } } }) })).toThrow("its MCP server docs carries a value of its own, which no machine is handed");
    expect(() => checkedWork({ ...work, setup: setup({ ledger: { type: "stdio", command: "ledger-mcp", args: [1], env: {} } }) })).toThrow("its MCP server ledger is not one a machine is handed");
  });

  it("given Ada sends a follow-up while her task runs, when its runner polls and then says it reached the agent, then it is handed once, marked delivered, and a mark for another task's follow-up or from a lease that is not the task's changes nothing", async () => {
    // given
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const service = createRunnerService({ tenant: "acme", store: mem.store });
    const { lease } = await service.poll(ADA, "machine-1", 0, true, open());
    const followUp = (id: string, taskId: string) => ({ tenant: "acme", id, taskId, source: "person" as const, key: id, text: "use our logger", quotes: null, status: "pending" as const, createdAt: new Date().toISOString(), deliveredAt: null, createdBy: ADA });
    mem.followUps.push(followUp("fup-1", "tsk-1"), followUp("fup-2", "tsk-other"));

    // when
    const first = await service.poll(ADA, "machine-1", 0, false, open());
    const again = await service.poll(ADA, "machine-1", 0, false, open());
    await service.followUpsDelivered("tsk-1", lease!.leaseId, ["fup-1", "fup-2"]);
    const stale = service.followUpsDelivered("tsk-1", "lease-not-held", ["fup-1"]);

    // then
    expect(first.commands).toEqual([{ type: "follow_up", taskId: "tsk-1", followUp: { id: "fup-1", source: "person", text: "use our logger", quotes: null, createdBy: ADA } }]);
    expect(again.commands).toEqual([]);
    expect(mem.followUps.map((f) => [f.id, f.status])).toEqual([["fup-1", "delivered"], ["fup-2", "pending"]]);
    await expect(stale).rejects.toBeInstanceOf(NotHeld);
  });

  it("given two of the orchestrator's processes over one store, when a Stop is asked on one, then the runner polling the other hears it, once", async () => {
    const mem = memoryStore();
    mem.queued.push(task("tsk-1", ADA));
    const web = createRunnerService({ tenant: "acme", store: mem.store });
    const other = createRunnerService({ tenant: "acme", store: mem.store });
    await other.poll(ADA, "machine-1", 0, true, open());

    await web.stop("tsk-1");

    expect((await other.poll(ADA, "machine-1", 0, false, open())).commands).toEqual([{ type: "stop", taskId: "tsk-1" }]);
    expect((await other.poll(ADA, "machine-1", 0, false, open())).commands).toEqual([]);
    expect(await web.stop("tsk-unknown")).toBe(false);
  });
});
