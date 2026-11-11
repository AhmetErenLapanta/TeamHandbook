import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mirrorDir, syncRepo } from "../app.js";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { localDescriptionRef, localRepoPath } from "../forge/local.js";
import { git } from "../git.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import type { Store } from "../store.js";
import { claudeCodeAdapter, fakeAgentAdapter, opencodeAdapter } from "./agents.js";
import type { AgentAdapter } from "./agents.js";
import { taskPaths } from "./isolation.js";
import { createTaskRunner, failureText } from "./runner.js";
import { readEvidence } from "./verify.js";
import type { RunnerOptions, TaskRunner } from "./runner.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function seeded(): Promise<{ ctx: OrchestratorContext; root: string }> {
  const { ctx, root } = await seededContext("orchestrator-chaos-");
  await storePrincipals(ctx, ADMIN);
  dirs.push(root);
  return { ctx, root };
}

/** A stand-in agent script: the body runs in the checkout; the result line follows unless the body exits first. */
function script(root: string, name: string, body: string): string {
  const file = join(root, `${name}.mjs`);
  writeFileSync(file, `import * as fs from "node:fs";\n${body}\nconsole.log(JSON.stringify({ type: "result", summary: "Done." }));\n`);
  return file;
}

function runner(ctx: OrchestratorContext, agentScript: string, overrides: Partial<RunnerOptions> = {}): TaskRunner {
  return createTaskRunner(ctx, {
    agents: [fakeAgentAdapter(agentScript)],
    isolation: { mode: "process", network: "open" },
    testCommand: () => null,
    hostEnv: { PATH: process.env.PATH },
    ...overrides,
  });
}

/** Runs one task to its end and gathers what it left: its record, its log, the branches beside main and the task directories. */
async function run(ctx: OrchestratorContext, tasks: TaskRunner, description = "", during?: () => void) {
  const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
  const bare = localRepoPath(repo.url)!;
  const started = await tasks.start({ repo, title: "Break something", description, agent: "fake", user: ADMIN });
  during?.();
  await tasks.idle();
  const task = (await ctx.store.getTask(ctx.tenant, started.id))!;
  const log = (await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text);
  const left = ["tasks", "task-git"].map((d) => join(ctx.dataDir, d, ctx.tenant)).flatMap((d) => (existsSync(d) ? readdirSync(d) : []));
  const branches = existsSync(bare) ? git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], bare).trim().split("\n").filter((b) => b !== "main") : [];
  return { task, log, left, branches, bare };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("a disk the agent fills", () => {
  // The task's directories share the disk with the store; deleting them is what frees it.
  const fullWhile = (ctx: OrchestratorContext, id: () => string, refuse: (patch: Parameters<Store["updateTask"]>[2]) => boolean): Store => ({
    ...ctx.store,
    async appendTaskLog(tenant, taskId, lines) {
      if (existsSync(taskPaths(ctx.dataDir, tenant, taskId).root)) throw new Error("database or disk is full");
      return ctx.store.appendTaskLog(tenant, taskId, lines);
    },
    async updateTask(tenant, taskId, patch) {
      if (taskId === id() && refuse(patch) && existsSync(taskPaths(ctx.dataDir, tenant, taskId).root)) throw new Error("database or disk is full");
      return ctx.store.updateTask(tenant, taskId, patch);
    },
  });

  it("given a store that refuses every write while the task's directories fill its disk, when the agent runs, then the task still ends failed with the reason once the directories are gone", async () => {
    // given
    const { ctx } = await seeded();
    let id = "";
    const full = { ...ctx, store: fullWhile(ctx, () => id, (patch) => patch.status !== "running") };
    const tasks = runner(full, FAKE_AGENT);
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    const said: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void said.push(line));

    // when
    try {
      id = (await tasks.start({ repo, title: "Fill the disk", description: "", agent: "fake", user: ADMIN })).id;
      await tasks.idle();
    } finally {
      spy.mockRestore();
    }

    // then
    expect(said.filter((line) => line.includes("ended without its outcome recorded"))).toEqual([]);
    const task = (await ctx.store.getTask(ctx.tenant, id))!;
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/database or disk is full/);
    expect(task.finishedAt).not.toBeNull();
    expect((await ctx.store.unfinishedTasks(ctx.tenant)).map((t) => t.id)).not.toContain(id);
    expect(existsSync(taskPaths(ctx.dataDir, ctx.tenant, id).root)).toBe(false);
  });

  it("given a store that refuses the outcome of a task whose request opened, when the directories are gone, then the task is recorded waiting for review with its request, not failed", async () => {
    // given
    const { ctx } = await seeded();
    let id = "";
    const full = { ...ctx, store: { ...fullWhile(ctx, () => id, (patch) => patch.status === "needs-review"), appendTaskLog: ctx.store.appendTaskLog.bind(ctx.store) } };
    const tasks = runner(full, FAKE_AGENT);
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    id = (await tasks.start({ repo, title: "Open then fill", description: "", agent: "fake", user: ADMIN })).id;
    await tasks.idle();

    // then
    expect(await ctx.store.getTask(ctx.tenant, id)).toMatchObject({ status: "needs-review", requestNumber: 1, error: null });
  });
});

describe("an agent that breaks its own workspace", () => {
  it.each([
    ["deletes its working directory", (root: string) => script(root, "rm-work", "fs.rmSync(process.cwd(), { recursive: true, force: true });")],
    ["deletes the task's whole directory", (root: string) => script(root, "rm-root", 'fs.rmSync(new URL("..", "file://" + process.cwd() + "/").pathname, { recursive: true, force: true });')],
  ])("given an agent that %s and reports success, when it ends, then the task fails saying so, with no path of the orchestrator's, no branch and nothing left", async (_case, make) => {
    // given
    const { ctx, root } = await seeded();

    // when
    const { task, log, left, branches } = await run(ctx, runner(ctx, make(root)));

    // then
    expect(task).toMatchObject({ status: "failed", error: "The agent deleted its working directory, so nothing was left to read back; no request was opened." });
    expect(JSON.stringify(log)).not.toContain(ctx.dataDir);
    expect([left, branches]).toEqual([[], []]);
  });

  it("given the stand-in told to write a file over the limit and thousands of files, when the task ends, then it fails on the first limit without staging either", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const big = await run(ctx, runner(ctx, FAKE_AGENT), "stand-in: write a 20 MB file");
    const many = await run(ctx, runner(ctx, FAKE_AGENT), "stand-in: write 3000 files");

    // then
    expect(big.task).toMatchObject({ status: "failed", error: "The agent wrote big.txt at 20971520 bytes, over the 1048576-byte limit for one file." });
    expect(many.task).toMatchObject({ status: "failed", error: "The agent changed 3001 files, over the limit of 200 for one request." });
    expect([big.left, big.branches, many.left, many.branches]).toEqual([[], [], [], []]);
  });
});

describe("a team repository that changes under a running task", () => {
  it("given the team repository moved away while the agent works, when the request would open, then the task fails naming where it looked, and nothing is left", async () => {
    // given
    const { ctx, root } = await seeded();
    const slow = script(root, "slow", 'await new Promise((r) => setTimeout(r, 1500));\nfs.writeFileSync("note.md", "late\\n");');
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const bare = localRepoPath(repo.url)!;

    // when
    const { task, left } = await run(ctx, runner(ctx, slow), "", () => setTimeout(() => renameSync(bare, join(root, "moved.git")), 300));

    // then
    expect(task).toMatchObject({ status: "failed", error: `The team repository is no longer at ${bare}; no request was opened.` });
    expect(left).toEqual([]);
    expect(git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"], join(root, "moved.git")).trim()).toBe("main");
  });

  it("given the mirror gone before a task checks it out, when the task starts, then it fails with git's reason and no path of the orchestrator's", async () => {
    // given
    const { ctx } = await seeded();
    rmSync(mirrorDir(ctx, "payments-skills"), { recursive: true, force: true });

    // when
    const { task, log, left } = await run(ctx, runner(ctx, FAKE_AGENT));

    // then
    expect(task.status).toBe("failed");
    expect(task.error).toMatch(/^git fetch failed: /);
    expect(JSON.stringify([task.error, log])).not.toContain(ctx.dataDir);
    expect(left).toEqual([]);
  });

  it("given the team repository's main moving while the agent works, when the request opens, then it is built on the commit the agent was given", async () => {
    // given
    const { ctx, root } = await seeded();
    const slow = script(root, "slow", 'await new Promise((r) => setTimeout(r, 1500));\nfs.writeFileSync("note.md", "late\\n");');
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const bare = localRepoPath(repo.url)!;
    const move = async () => {
      const work = join(root, "moving");
      git(["clone", "--quiet", bare, work], root);
      writeFileSync(join(work, "moved.md"), "moved\n");
      git(["add", "-A"], work);
      git(["-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", "commit", "--quiet", "-m", "chore: move main"], work);
      git(["fetch", "--quiet", work, "main:main"], bare);
      await syncRepo(ctx, repo.id);
    };

    // when
    const { task } = await run(ctx, runner(ctx, slow), "", () => void setTimeout(() => void move(), 300));

    // then
    expect(task.status).toBe("needs-review");
    const [request] = await ctx.store.listRequests(ctx.tenant, repo.id);
    expect(git(["rev-parse", `${request!.branch}^`], bare).trim()).toBe(task.baseSha);
    expect(git(["rev-parse", "main"], bare).trim()).not.toBe(task.baseSha);
  });
});

describe("tests that misbehave", () => {
  it("given tests that leave a process behind and tests that read their input, when each run ends, then the process is gone and the input was empty", async () => {
    // given
    const { ctx, root } = await seeded();
    const pidFile = join(root, "leftover.pid");
    const leaver = `sh -c 'sleep 60 & echo $! > ${pidFile}'; exit 0`;

    // when
    const left = await run(ctx, runner(ctx, FAKE_AGENT, { testCommand: () => leaver }));
    const reader = await run(ctx, runner(ctx, FAKE_AGENT, { testCommand: () => "read line; echo \"read: [$line]\"; exit 0" }));

    // then
    expect(left.task.status).toBe("needs-review");
    const pid = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
    expect(reader.task.status).toBe("needs-review");
    expect(reader.log).toContain("read: []");
  });

  it("given tests that never end, when their limit passes before and after the agent, then the evidence says so, the request opens as failing before, and nothing is left", async () => {
    // given
    const { ctx } = await seeded();

    // when
    const { task, left } = await run(ctx, runner(ctx, FAKE_AGENT, { testCommand: () => "sleep 60", testTimeoutMs: 1000 }));

    // then
    expect(task).toMatchObject({ status: "needs-review", tests: "failed" });
    expect(await readEvidence(ctx.store, ctx.tenant, task.id, "payments-skills")).toMatchObject({ verdict: "failing-before", checks: [{ before: { timedOut: true }, after: [{ timedOut: true }] }] });
    expect(left).toEqual([]);
  });
});

describe("an agent whose output is not what its CLI promises", () => {
  it("given an agent that prints broken JSON, half a line and no result, and exits 0, when it ends, then the task fails saying no result came", async () => {
    // given
    const { ctx, root } = await seeded();
    const broken = join(root, "broken.mjs");
    writeFileSync(broken, 'console.log("{not json");\nconsole.log(\'{"type":"log"\');\nprocess.stdout.write("half a line");\n');

    // when
    const { task, log } = await run(ctx, runner(ctx, broken));

    // then
    expect(task).toMatchObject({ status: "failed", error: "The agent ended without reporting a result (exit code 0). Last line: half a line" });
    expect(log).toEqual(expect.arrayContaining(["{not json", '{"type":"log"', "half a line"]));
  });

  it("given an agent that prints binary bytes, when they reach the log and the error, then no control character is kept", async () => {
    // given
    const { ctx, root } = await seeded();
    const binary = join(root, "binary.mjs");
    writeFileSync(binary, "process.stdout.write(Buffer.from([0, 1, 2, 255, 10, 27, 91, 50, 74, 0, 10]));\nprocess.exit(1);\n");

    // when
    const { task, log } = await run(ctx, runner(ctx, binary));

    // then
    expect(task.status).toBe("failed");
    const kept = JSON.stringify([task.error, ...log]);
    expect(kept).not.toMatch(/\\u00(?:0[0-8]|1[0-9a-f])|\\u007f/);
    expect(task.error).toBe("The agent did not finish successfully (exit code 1). Last line: �[2J�");
  });
});

describe("the readiness check of an orchestrator that stopped mid-check", () => {
  it("given probe containers a stopped orchestrator left, of this tenant and of another, when the next orchestrator starts, then only this tenant's are removed", async () => {
    // given
    const { ctx, root } = await seeded();
    const bin = join(root, "bin");
    const calls = join(root, "docker.calls");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\necho "$*" >> ${calls}\nif [ "$1" = ps ]; then printf 'teamhandbook-probe-0a1b2c3d-demo\\nteamhandbook-probe-99887766-other\\nteamhandbook-task-demo-aaaaaaaaaaaa\\n'; fi\nif [ "$1" = image ]; then exit 1; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const tasks = runner(ctx, FAKE_AGENT, {
      isolation: { mode: "container", network: "none", image: "agents:1", dataDir: ctx.dataDir },
      hostEnv: { PATH: `${bin}:/usr/bin:/bin` },
    });

    // when
    await tasks.ready();

    // then
    const recorded = readFileSync(calls, "utf8").trim().split("\n");
    expect(recorded.filter((c) => c.startsWith("rm "))).toEqual(["rm -f teamhandbook-probe-0a1b2c3d-demo"]);
  });
});

describe("a private key in a process's output", () => {
  const KEY = "MIIEowIBAAKCAQEAsecretbody";
  const filler = (n: number, word = "filler") => `i=1; while [ $i -le ${n} ]; do echo ${word}$i; i=$((i+1)); done`;
  const key = (body: number) => `echo '-----BEGIN RSA PRIVATE KEY-----'; ${filler(body, KEY)}; echo '-----END RSA PRIVATE KEY-----'`;

  it.each([
    ["starts in the part left out and ends in the part kept", `${filler(4100)}; ${key(1500)}; exit 1`],
    ["starts and ends in the part kept at the end", `${filler(6000)}; ${key(10)}; exit 1`],
    ["starts in the part kept at the start and ends in the part left out", `${filler(3990)}; ${key(3000)}; ${filler(2000, "after")}; exit 1`],
  ])("given tests whose output holds a key block that %s, when the task ends, then no line of the key is in the log, the evidence or the request, and the lines after it are", async (_case, command) => {
    // given
    const { ctx } = await seeded();

    // when
    const { task, log, bare } = await run(ctx, runner(ctx, FAKE_AGENT, { testCommand: () => command }));

    // then
    expect(task).toMatchObject({ status: "needs-review", tests: "failed" });
    const evidence = await readEvidence(ctx.store, ctx.tenant, task.id, "payments-skills");
    const body = git(["notes", "--ref", localDescriptionRef(`task/${task.id}`), "show", `task/${task.id}`], bare);
    expect(JSON.stringify([task.error, log, evidence, body])).not.toContain("secretbody");
    expect(JSON.stringify([task.error, log, evidence, body])).not.toContain("END RSA PRIVATE KEY");
    const last = evidence!.checks[0]!.after[0]!.output.split("\n").at(-1);
    if (command.includes("after")) {
      expect(log).toContain("after2000");
      expect(last).toBe("after2000");
    } else {
      expect(last).toBe("[redacted:private-key]");
    }
  });

  it("given tests that stop in the middle of a key block, when the task ends, then its evidence quotes the redacted lines, not the key", async () => {
    // given
    const { ctx } = await seeded();
    const command = "echo '-----BEGIN OPENSSH PRIVATE KEY-----'; echo b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQsecretkeybody; exit 1";

    // when
    const { task, log, bare } = await run(ctx, runner(ctx, FAKE_AGENT, { testCommand: () => command }));

    // then
    const evidence = await readEvidence(ctx.store, ctx.tenant, task.id, "payments-skills");
    expect(evidence!.checks[0]!.after[0]!.output).toBe("[redacted:private-key]\n[redacted:private-key]");
    const body = git(["notes", "--ref", localDescriptionRef(`task/${task.id}`), "show", `task/${task.id}`], bare);
    expect(JSON.stringify([log, evidence, body])).not.toContain("secretkeybody");
  });

  it("given an agent that leaves a key block open and then succeeds, when the orchestrator writes its own lines, then they are not masked", async () => {
    // given
    const { ctx, root } = await seeded();
    const open = script(root, "open-key", 'console.error("-----BEGIN EC PRIVATE KEY-----");\nconsole.error("MHcCAQEEIsecretbody");\nfs.writeFileSync("note.md", "x\\n");');

    // when
    const { task, log } = await run(ctx, runner(ctx, open));

    // then
    expect(task.status).toBe("needs-review");
    expect(JSON.stringify(log)).not.toContain("secretbody");
    expect(log.at(-1)).toBe(`Opened request #1 on task/${task.id}. It waits for a person to review and merge it.`);
  });
});

describe("an agent's report that is not printable", () => {
  it("given an agent whose result summary holds a NUL and an escape, when its request opens, then the task waits for review and the description holds neither", async () => {
    // given
    const { ctx, root } = await seeded();
    const agent = join(root, "nul-summary.mjs");
    writeFileSync(agent, 'import { writeFileSync } from "node:fs";\nwriteFileSync("note.md", "x\\n");\nconsole.log(JSON.stringify({ type: "result", summary: "binary\\u0000here \\u001b[31m" }));\n');

    // when
    const { task, bare } = await run(ctx, runner(ctx, agent));

    // then
    expect(task).toMatchObject({ status: "needs-review", requestNumber: 1 });
    const [request] = await ctx.store.listRequests(ctx.tenant);
    const description = git(["notes", "--ref", localDescriptionRef(request!.branch), "show", request!.branch], bare);
    expect(description).toContain("binary�here �[31m");
    expect(description).not.toMatch(/[\u0000\u001b]/);
  });
});

describe("a failed git step in words", () => {
  it("given a git failure whose first lines are a warning and whose data directory path holds a space, when it is put in words, then it names the step and git's fatal line, and no spelling of the data directory", () => {
    // given
    const dataDir = "/srv/orchestrator data";
    const real = "/mnt/disk two/orchestrator data";
    const err = new Error(
      `Command failed: git --git-dir ${dataDir}/task-git/demo/abc --work-tree ${dataDir}/tasks/demo/abc/work fetch --quiet ${real}/mirrors/demo/x HEAD\n` +
        `warning: redirecting to ${real}/mirrors/demo/x\nhint: something\nfatal: '${real}/mirrors/demo/x' does not appear to be a git repository\n`,
    );

    // when
    const text = failureText(err, [real, dataDir]);

    // then
    expect(text).toBe("git fetch failed: fatal: '<data directory>/mirrors/demo/x' does not appear to be a git repository");
  });

  it("given a data directory reached through a link, when the mirror is gone, then the task's error holds neither the link nor the directory it leads to", async () => {
    // given
    const { ctx, root } = await seeded();
    const linked = join(root, "linked data");
    symlinkSync(ctx.dataDir, linked);
    const viaLink: OrchestratorContext = { ...ctx, dataDir: linked };
    rmSync(mirrorDir(ctx, "payments-skills"), { recursive: true, force: true });

    // when
    const { task, log } = await run(viaLink, runner(viaLink, FAKE_AGENT));

    // then
    expect(task.error).toMatch(/^git fetch failed: /);
    const shown = JSON.stringify([task.error, log]);
    expect(shown).not.toContain(linked);
    expect(shown).not.toContain(realpathSync(ctx.dataDir));
  });
});

describe("a credential where a long line is cut", () => {
  // Forty characters no secret pattern knows, so only its value can mask it.
  const PASSED = "zq9XK2mPq7RtV4wLs8NbY3cHj6Fd1Gp0Ue5Wa8Tx";
  const GITHUB = `ghp_${"Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2Yz3".slice(0, 36)}`;
  const GEMINI = `AIza${"Sy0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0u".slice(0, 35)}`;

  /** A stand-in CLI that changes one file and prints the given events as its JSON lines. */
  function cli(root: string, name: string, events: unknown[]): string {
    const file = join(root, `${name}.mjs`);
    writeFileSync(file, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync("note.md", "x\\n");\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`, { mode: 0o755 });
    return file;
  }
  const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const done = (result = "Done.") => ({ type: "result", subtype: "success", is_error: false, result, num_turns: 1 });
  const withAgent = (ctx: OrchestratorContext, adapter: AgentAdapter, hostEnv: Record<string, string | undefined>, passEnv: string[] = []) =>
    createTaskRunner(ctx, { agents: [adapter], isolation: { mode: "process", network: "open" }, testCommand: () => null, hostEnv: { PATH: process.env.PATH, ...hostEnv }, passEnv });
  const start = async (ctx: OrchestratorContext, tasks: TaskRunner, agent: string) => {
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;
    const task = await tasks.start({ repo, title: "Say a long thing", description: "", agent, user: ADMIN });
    await tasks.idle();
    return { task: (await ctx.store.getTask(ctx.tenant, task.id))!, log: (await ctx.store.taskLog(ctx.tenant, task.id, 0)).map((l) => l.text) };
  };

  it.each([
    ["where a cut at 300 would keep all but its last character", 261],
    ["where the auditor found 29 of its 40 characters", 271],
    ["where a cut at 300 would keep only its first character", 299],
    ["where the log's own cut at 2000 falls inside it", 1990],
  ])("given Claude Code saying a passed-through value %s, when the line reaches the log, then the whole value is masked", async (_case, at) => {
    // given
    const { ctx, root } = await seeded();
    const program = cli(root, "claude", [said(`${"x".repeat(at)}${PASSED} and more`), done()]);

    // when
    const { task, log } = await start(ctx, withAgent(ctx, claudeCodeAdapter(program), { SERVICE_TOKEN: PASSED }, ["SERVICE_TOKEN"]), "claude-code");

    // then
    expect(task.status).toBe("needs-review");
    // Past 2000 characters the log's own cut falls after the mask, inside its placeholder at worst.
    const masked = `${"x".repeat(at)}[redacted:credential] and more`;
    expect(log).toContain(masked.length > 2000 ? `${masked.slice(0, 2000)}…` : masked);
    expect(JSON.stringify(log)).not.toContain(PASSED.slice(0, 8));
  });

  it("given Claude Code saying a GitHub token where a cut at 300 would leave fifteen of its characters, when the line reaches the log, then no part of it does", async () => {
    // given
    const { ctx, root } = await seeded();
    const program = cli(root, "claude", [said(`${"x".repeat(284)} ${GITHUB}`), done()]);

    // when
    const { log } = await start(ctx, withAgent(ctx, claudeCodeAdapter(program), {}), "claude-code");

    // then
    expect(JSON.stringify(log)).not.toContain("ghp_");
    expect(log.some((line) => /^\[redacted:[^\]]+\]$/.test(line))).toBe(true);
  });

  it("given OpenCode saying its Gemini key in a text and in an error, both past a cut at 300, when the lines reach the log, then no part of the key does", async () => {
    // given
    const { ctx, root } = await seeded();
    const program = cli(root, "opencode", [
      { type: "text", part: { text: `${"x".repeat(280)}${GEMINI}` } },
      { type: "error", error: { name: "ProviderError", message: `${"y".repeat(270)} key ${GEMINI} refused` } },
    ]);

    // when
    const { log } = await start(ctx, withAgent(ctx, opencodeAdapter(program), { GEMINI_API_KEY: GEMINI }), "opencode");

    // then
    expect(JSON.stringify(log)).not.toContain(GEMINI.slice(0, 8));
    expect(log.filter((line) => line.includes("[redacted:credential]"))).toHaveLength(2);
  });

  it("given an agent whose report carries a token on a line longer than the log keeps, when its request opens, then the description holds no part of it", async () => {
    // given
    const { ctx, root } = await seeded();
    const program = cli(root, "claude", [done(`Done.\n${"x".repeat(1989)} ${GITHUB}`)]);

    // when
    const { task } = await start(ctx, withAgent(ctx, claudeCodeAdapter(program), {}), "claude-code");

    // then
    expect(task.status).toBe("needs-review");
    const [request] = await ctx.store.listRequests(ctx.tenant);
    const bare = localRepoPath((await ctx.store.getRepo(ctx.tenant, "payments-skills"))!.url)!;
    const description = git(["notes", "--ref", localDescriptionRef(request!.branch), "show", request!.branch], bare);
    expect(description).not.toContain("ghp_");
    expect(description).toMatch(/\[redacted:[^\]]+\]/);
  });
});
