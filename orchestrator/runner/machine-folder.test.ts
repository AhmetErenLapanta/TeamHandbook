import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAgentAdapter, opencodeAdapter } from "../server/tasks/agents.js";
import type { AgentAdapter } from "../server/tasks/agents.js";
import type { FolderWork, RunnerEvent, RunnerTask, TaskProgress } from "./link.js";
import { undoInFolder } from "./folders.js";
import { machineExecutor } from "./machine-executor.js";
import { STOPPED } from "./task.js";
import type { ExecutorHooks } from "./task.js";
import type { CheckSandbox } from "../server/tasks/check-sandbox.js";

const FAKE_AGENT = join(import.meta.dirname, "..", "demo", "fake-agent.mjs");

describe("a task in a folder without git on its person's machine", { timeout: 60_000 }, () => {
  let root: string;
  let home: string;
  let dataDir: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "machine-folder-")));
    home = join(root, "home");
    dataDir = join(home, "runner-data");
    mkdirSync(join(home, "notes"), { recursive: true });
    mkdirSync(join(home, ".hidden"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(home, "notes", "README.md"), "Notes.\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const work = (fields: Partial<FolderWork["folder"]> = {}, prompt = "Task: Add an on-call note", rules: FolderWork["rules"] = [], testCommand: string | null = null): FolderWork => ({
    prompt,
    mode: "auto",
    choices: null,
    setup: { plugin: null, mcpTools: [], deniedTools: [] },
    limits: { timeoutMs: 60_000, testCommand },
    folder: { machineId: "mch_here", projectId: "prj_notes", path: "~/notes", ...fields },
    rules,
  });

  async function run(given: FolderWork, working = new Set<string>(), env: Record<string, string> = {}, checkSandbox?: () => Promise<CheckSandbox>) {
    const log: string[] = [];
    const events: RunnerEvent[] = [];
    const records: TaskProgress[] = [];
    const hooks: ExecutorHooks = { signal: new AbortController().signal, onEvent: (event) => void events.push(event), log: (text) => void log.push(text), record: (progress) => void records.push(progress), onProcess: () => {}, decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
    const task: RunnerTask = { id: "tsk_folder_1", title: "Add an on-call note", agent: "fake", nativeSession: null, work: given };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", working, adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home, ...env }, ...(checkSandbox ? { checkSandbox } : {}) });
    return { outcome: await executor.run(task, hooks), log, events, records };
  }

  it("given a task with two attachments, one of which the orchestrator does not hand over, when it runs on the machine, then the one it got sits in the task's own folder for the agent and the other is said to be missing, and the task still goes on", async () => {
    // given
    const log: string[] = [];
    const asked: string[] = [];
    let present = false;
    const given = { ...work(), attachments: [{ id: "att_1", name: "notes.txt", kind: "text" as const }, { id: "att_2", name: "screen.png", kind: "image" as const }] };
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: (text) => void log.push(text),
      record: () => {},
      onProcess: () => {
        present = existsSync(join(dataDir, "runner", "machines", "acme", "tasks", "tsk_folder_att", "attachments", "notes.txt"));
      },
      decide: async () => ({ decision: "deny" }),
      leaseHeld: async () => true,
      attachment: async (id) => {
        asked.push(id);
        if (id === "att_2") throw new Error("not found");
        return new TextEncoder().encode("the on-call rota\n");
      },
    };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home } });

    // when
    const outcome = await executor.run({ id: "tsk_folder_att", title: "Add an on-call note", agent: "fake", nativeSession: null, work: given }, hooks);

    // then
    expect(outcome.status).toBe("needs-review");
    expect(asked).toEqual(["att_1", "att_2"]);
    expect(present).toBe(true);
    expect(log).toEqual(expect.arrayContaining(["screen.png was not fetched from the orchestrator, so the agent does not see it.", "Fetched 1 attached file(s) for the agent to read."]));
  });

  it("given a policy that keeps the person's own setup out and the team's plugin installed in their Claude Code, when a task runs on the machine, then the plugin's skills sit in the task's own skills folder for the agent", async () => {
    // given
    const installed = join(home, ".claude", "plugins", "cache", "stand-in-market", "acme-skills", "1.0.0");
    mkdirSync(join(installed, ".claude-plugin"), { recursive: true });
    mkdirSync(join(installed, "skills", "on-call-note", "references"), { recursive: true });
    writeFileSync(join(installed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-skills", version: "1.0.0" }));
    writeFileSync(join(installed, "skills", "on-call-note", "SKILL.md"), "---\nname: on-call-note\n---\nWrite the rota first.\n");
    writeFileSync(join(installed, "skills", "on-call-note", "references", "rota.md"), "Weekly.\n");
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "acme-skills@stand-in-market": [{ scope: "user", installPath: installed, version: "1.0.0" }] } }));
    const skills = join(dataDir, "runner", "machines", "acme", "tasks", "tsk_folder_skills", "team-skills", "skills", "on-call-note");
    const seen: { skill: string | null; reference: boolean } = { skill: null, reference: false };
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {
        seen.skill = existsSync(join(skills, "SKILL.md")) ? readFileSync(join(skills, "SKILL.md"), "utf8") : null;
        seen.reference = existsSync(join(skills, "references", "rota.md"));
      },
      decide: async () => ({ decision: "deny" }),
      leaseHeld: async () => true,
    };
    const given = { ...work(), setup: { plugin: { name: "acme-skills", version: "1.0.0" }, mcpTools: [], deniedTools: [], ownSetup: false } };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home } });

    // when
    await executor.run({ id: "tsk_folder_skills", title: "Add an on-call note", agent: "fake", nativeSession: null, work: given }, hooks);

    // then
    expect(seen).toEqual({ skill: expect.stringContaining("Write the rota first."), reference: true });
  });

  it("given a policy that keeps the person's own setup out and no team plugin installed, when a task runs on the machine, then the log says the team's skills are not in the run and the task goes on", async () => {
    // when
    const { log } = await run({ ...work(), setup: { plugin: { name: "acme-skills", version: "1.0.0" }, mcpTools: [], deniedTools: [], ownSetup: false } });

    // then
    expect(log).toContain("The team's skills are not in this run: the team's plugin acme-skills is not installed in your Claude Code.");
  });

  it("given a task in Auto on the person's machine, when its agent wants a tool its list does not allow, then the run is two-way, the question reaches the person as a card, and their yes lets the agent go on", async () => {
    // given
    const asked: string[] = [];
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: async (request) => {
        asked.push(`${request.tool} ${request.summary}`);
        return { decision: "allow-once" };
      },
      leaseHeld: async () => true,
    };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [fakeAgentAdapter(FAKE_AGENT)], hostEnv: { PATH: process.env.PATH, HOME: home } });

    // when
    const outcome = await executor.run({ id: "tsk_folder_auto", title: "Add an on-call note", agent: "fake", nativeSession: null, work: work({}, "Task: Add an on-call note\nstand-in: ask Bash npm test") }, hooks);

    // then
    expect(asked).toEqual(["Bash npm test"]);
    expect(outcome.status).toBe("needs-review");
  });

  it("given a task its starter asked to plan first, when it runs on their machine with an agent that plans, then its first run opens in plan mode, and a task that does not plan first opens as usual", async () => {
    // given
    const plans: (boolean | undefined)[] = [];
    const base = fakeAgentAdapter(FAKE_AGENT);
    const planning: AgentAdapter = {
      ...base,
      twoWay: {
        capabilities: { ...base.twoWay!.capabilities, plan: true },
        launch(paths, setup, { plan, ...options }) {
          plans.push(plan);
          return base.twoWay!.launch(paths, setup, options);
        },
      },
    };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [planning], hostEnv: { PATH: process.env.PATH, HOME: home } });
    const hooks: ExecutorHooks = { signal: new AbortController().signal, onEvent: () => {}, log: () => {}, record: () => {}, onProcess: () => {}, decide: async () => ({ decision: "allow-once" }), leaseHeld: async () => true };

    // when
    await executor.run({ id: "tsk_folder_plan", title: "Add an on-call note", agent: "fake", nativeSession: null, work: { ...work(), planFirst: true } }, hooks);
    await executor.run({ id: "tsk_folder_noplan", title: "Add an on-call note", agent: "fake", nativeSession: null, work: work() }, hooks);

    // then
    expect(plans).toEqual([true, undefined]);
  });

  it("given an agent that changed the folder and is still working, when its person stops the task, then the change is kept for review with why it stopped, and a stop before any change ends the task with nothing to review", async () => {
    // given
    const base = fakeAgentAdapter(FAKE_AGENT);
    const writing: AgentAdapter = {
      ...base,
      twoWay: {
        capabilities: base.twoWay!.capabilities,
        launch(paths, setup, options) {
          writeFileSync(join(paths.work, "on-call.md"), "Page the on-call engineer.\n");
          return base.twoWay!.launch(paths, setup, options);
        },
      },
    };
    const stopOnStart = () => {
      const controller = new AbortController();
      const hooks: ExecutorHooks = { signal: controller.signal, onEvent: () => {}, log: () => {}, record: () => {}, onProcess: () => setTimeout(() => controller.abort(new Error(STOPPED)), 300), decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
      return hooks;
    };
    const given = work({}, "Task: Add an on-call note\nstand-in: wait 30 seconds");

    // when
    const kept = await machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [writing], hostEnv: { PATH: process.env.PATH, HOME: home } }).run({ id: "tsk_folder_stop", title: "Add an on-call note", agent: "fake", nativeSession: null, work: given }, stopOnStart());
    const nothing = await machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [base], hostEnv: { PATH: process.env.PATH, HOME: home } }).run({ id: "tsk_folder_stop_early", title: "Add an on-call note", agent: "fake", nativeSession: null, work: given }, stopOnStart());

    // then
    expect(kept).toMatchObject({ status: "needs-review", error: STOPPED, changes: { files: [expect.objectContaining({ path: "on-call.md" })] } });
    expect(nothing).toMatchObject({ status: "interrupted" });
  });

  it("given a person whose machine runs OpenCode, when a task in their folder runs, then it runs as them on a server of its own under the session's rules, never the OpenCode first on the path, and its change is kept for review", async () => {
    // given
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho ran > "${join(root, "real-opencode-ran")}"\nexit 1\n`);
    writeFileSync(join(bin, "opencode-standin"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "opencode-serve.fake.mjs")}" "$@"\n`);
    chmodSync(join(bin, "opencode"), 0o755);
    chmodSync(join(bin, "opencode-standin"), 0o755);
    const task: RunnerTask = { id: "tsk_folder_oc", title: "Add an on-call note", agent: "opencode", nativeSession: null, work: work() };
    const hooks: ExecutorHooks = { signal: new AbortController().signal, onEvent: () => {}, log: () => {}, record: () => {}, onProcess: () => {}, decide: async () => ({ decision: "deny" }), leaseHeld: async () => true };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [opencodeAdapter(join(bin, "opencode-standin"))], hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: home } });

    // when
    const outcome = await executor.run(task, hooks);

    // then
    expect(outcome).toMatchObject({ status: "needs-review", changes: { files: [expect.objectContaining({ path: "opencode-note.md" })] } });
    expect(existsSync(join(root, "real-opencode-ran"))).toBe(false);
    const seen = readFileSync(join(home, "opencode-seen.jsonl"), "utf8");
    expect(seen).toMatch(/"permission":"bash","pattern":"\*","action":"deny"/);
  });

  it.each([
    ["Claude Code", "fake"],
    ["OpenCode", "opencode"],
  ])("given %s asking its person on the machine, when they answer after the task's time has passed, then the wait does not count and the task reaches review", async (_name, agent) => {
    // given
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "opencode-standin"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "opencode-serve.fake.mjs")}" "$@"\n`);
    chmodSync(join(bin, "opencode-standin"), 0o755);
    const given = { ...work({}, "Task: Add an on-call note\nstand-in: ask notebook_create_page quarterly notes"), mode: "approval-required" as const, limits: { timeoutMs: 1_500, testCommand: null } };
    const hooks: ExecutorHooks = {
      signal: new AbortController().signal,
      onEvent: () => {},
      log: () => {},
      record: () => {},
      onProcess: () => {},
      decide: () => new Promise((resolve) => setTimeout(() => resolve({ decision: "allow-once" }), 3_000)),
      leaseHeld: async () => true,
    };
    const executor = machineExecutor({ dataDir, org: "acme", machineId: "mch_here", adapters: [fakeAgentAdapter(FAKE_AGENT), opencodeAdapter(join(bin, "opencode-standin"))], hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: home } });

    // when
    const outcome = await executor.run({ id: `tsk_folder_wait_${agent}`, title: "Add an on-call note", agent, nativeSession: null, work: given }, hooks);

    // then
    expect(outcome).toMatchObject({ status: "needs-review" });
  });

  it("given a folder of the machine's own named from its home, when the agent edits it, then the edit stays in the folder, the machine's shadow records it outside the folder, and only the paths changed leave the machine for review", async () => {
    // when
    const { outcome, log } = await run(work());

    // then
    expect(outcome).toMatchObject({ status: "needs-review", error: null, branch: null, request: null, changes: { files: [expect.objectContaining({ path: "skills/add-an-on-call-note/SKILL.md" })] } });
    expect(outcome.changes!.before).not.toBe(outcome.changes!.after);
    expect(readFileSync(join(home, "notes", "skills", "add-an-on-call-note", "SKILL.md"), "utf8")).toContain("Add an on-call note");
    expect(existsSync(join(home, "notes", ".git"))).toBe(false);
    expect(existsSync(join(dataDir, "runner", "machines", "acme", "shadow", "prj_notes", "HEAD"))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("Written by the stand-in agent");
    expect(log).toEqual(expect.arrayContaining([expect.stringContaining("Working in notes in place")]));
  });

  it("given a team policy that keeps skill files from being edited, when the agent edits one in place, then the machine takes the edit back and the task fails with the reason the orchestrator gives in place", async () => {
    // given
    const rules: FolderWork["rules"] = [{ action: "tool.use", resource: "tool:Edit:**/SKILL.md", effect: "deny", reason: "skills are reviewed by the platform team" }];

    // when
    const { outcome } = await run(work({}, "Task: Add an on-call note", rules));

    // then
    expect(outcome).toMatchObject({ status: "failed", changes: { undone: { kept: [] } } });
    expect(outcome.error).toBe("The agent changed skills/add-an-on-call-note/SKILL.md, which the team's policy keeps from being edited: skills are reviewed by the platform team. Its change was undone.");
    expect(existsSync(join(home, "notes", "skills", "add-an-on-call-note", "SKILL.md"))).toBe(false);
    expect(readFileSync(join(home, "notes", "README.md"), "utf8")).toBe("Notes.\n");
  });

  it("given a task's change in a folder and a file the person edited after it, when they undo it from the screen, then the machine puts the task's files back and keeps the one they edited", async () => {
    // given
    const { outcome } = await run(work({}, "Task: Add an on-call note\nstand-in: write env HOME"));
    writeFileSync(join(home, "notes", "env-HOME.txt"), "edited since\n");
    const where = { home, dataDir, shadows: join(dataDir, "runner", "machines", "acme", "shadow") };
    const { before, after } = outcome.changes!;

    // when
    const undone = await undoInFolder({ nonce: "n-1", projectId: "prj_notes", path: "~/notes", before, after }, where);

    // then
    expect(undone).toEqual({ undone: ["skills/add-an-on-call-note/SKILL.md"], kept: ["env-HOME.txt"] });
    expect(existsSync(join(home, "notes", "skills"))).toBe(false);
    expect(readFileSync(join(home, "notes", "env-HOME.txt"), "utf8")).toBe("edited since\n");
  });

  it("given a task working in a folder, when an undo of an earlier task there arrives, then the machine refuses it until the task ends, and then puts the earlier change back", async () => {
    // given
    const working = new Set<string>();
    const where = { home, dataDir, shadows: join(dataDir, "runner", "machines", "acme", "shadow") };
    const { outcome: earlier } = await run(work(), working);
    const ask = { nonce: "n-1", projectId: "prj_notes", path: "~/notes", before: earlier.changes!.before, after: earlier.changes!.after };
    const running = run(work({}, "Task: Add a runbook\nstand-in: wait 2 seconds"), working);
    while (!working.size) await new Promise((r) => setTimeout(r, 20));

    // when
    const during = await undoInFolder(ask, where, working);
    await running;
    const afterwards = await undoInFolder(ask, where, working);

    // then
    expect(during).toEqual({ refused: "a task is working in this folder now; undo once it ends" });
    expect(afterwards).toMatchObject({ undone: ["skills/add-an-on-call-note/SKILL.md"] });
  });

  it.each([
    ["a snapshot shaped like an option", { before: "--output=/tmp/x" }, /snapshots this machine does not take/],
    ["a hidden folder", { path: "~/.hidden" }, /hidden/],
    ["a full path", { path: "/etc" }, /not named from this machine's home/],
  ])("given an undo naming %s, when the machine reads it, then nothing is put back", async (_case, fields, why) => {
    // given
    const where = { home, dataDir, shadows: join(dataDir, "shadow") };
    const sha = "a".repeat(40);

    // when
    const undone = await undoInFolder({ nonce: "n-1", projectId: "prj_notes", path: "~/notes", before: sha, after: sha, ...fields }, where);

    // then
    expect(undone).toMatchObject({ refused: expect.stringMatching(why) });
  });

  it("given the team's tests print a coloured line and a value of a credential in the person's environment, when they run on the machine, then each line reaches the task as it runs, as text with no terminal codes and with the credential masked", async () => {
    // given
    const value = "stand-in-credential-value-0123";
    const command = `printf '\\033[31mred check\\033[0m\\nreached with ${value}\\n'`;

    // when
    const { outcome, events } = await run(work({}, "Task: Add an on-call note", [], command), new Set(), { STAND_IN_API_TOKEN: value });

    // then
    expect(outcome.status).toBe("needs-review");
    const output = events.flatMap((e) => (e.type === "tool_output" && e.id === "tests" ? e.lines : []));
    expect(output[0]).toBe("red check");
    expect(output[1]).toMatch(/^reached with \[redacted/);
    expect(events.flatMap((e) => (e.type === "tool_call" && e.id === "tests" ? [e.status] : []))).toEqual(["started", "done"]);
    expect(JSON.stringify(events)).not.toContain(value);
  });

  const checked = (command: string): FolderWork => {
    const given = work();
    return { ...given, limits: { ...given.limits, verification: { plan: { checks: [{ command, runs: command, source: "the orchestrator's configuration" }], setup: null, approved: null }, maxRepairs: 2 } } };
  };

  it.runIf(process.platform === "darwin")("given a check that reads another project's env file and a sign-in in the person's home and writes outside the task, when it runs on this Mac, then the sandbox keeps it from all three and what it printed carries none", async () => {
    // given
    mkdirSync(join(home, ".aws"), { recursive: true });
    mkdirSync(join(home, "other-project"), { recursive: true });
    writeFileSync(join(home, ".aws", "credentials"), "stand-in-aws-secret\n");
    writeFileSync(join(home, "other-project", ".env"), "STAND_IN_OTHER=stand-in-other-value\n");
    const command = `cat ${home}/other-project/.env && echo READ-OTHER; cat ${home}/.aws/credentials && echo READ-KEY; echo x > ${home}/outside.txt && echo WROTE-OUTSIDE; exit 0`;

    // when
    const { outcome, events } = await run(work({}, "Task: Add an on-call note", [], command));

    // then
    expect(outcome.status).toBe("needs-review");
    const printed = JSON.stringify(events.filter((e) => e.type === "tool_output"));
    expect(printed).not.toContain("READ-OTHER");
    expect(printed).not.toContain("stand-in-other-value");
    expect(printed).not.toContain("READ-KEY");
    expect(printed).not.toContain("stand-in-aws-secret");
    expect(printed).not.toContain("WROTE-OUTSIDE");
    expect(existsSync(join(home, "outside.txt"))).toBe(false);
  });

  it("given a machine where no sandbox for a check starts, when a task handed checks runs, then no check runs, the agent still works, and the report names the handed checks as not run with the reason", async () => {
    // when
    const { outcome, records, log } = await run(checked("test -f skills/add-an-on-call-note/SKILL.md"), new Set(), {}, async () => ({ refused: "no sandbox starts on this stand-in machine" }));

    // then
    expect(outcome.status).toBe("needs-review");
    const [report] = records.flatMap((r) => (r.verification ? [r.verification] : []));
    expect(report).toMatchObject({ verdict: "not-run", reason: "No sandbox starts on this stand-in machine.", checks: [expect.objectContaining({ command: "test -f skills/add-an-on-call-note/SKILL.md", before: null, after: [] })] });
    expect(log).toContain("No check runs on this task: no sandbox starts on this stand-in machine.");
  });

  it("given a check that fails before the agent and passes on its change, when the task runs on the machine, then the machine runs it before and after the agent and reports both runs, leaving the verdict to the orchestrator", async () => {
    // when
    const { outcome, records } = await run(checked("test -f skills/add-an-on-call-note/SKILL.md"));

    // then
    expect(outcome.status).toBe("needs-review");
    const [report] = records.flatMap((r) => (r.verification ? [r.verification] : []));
    expect(report!.checks).toHaveLength(1);
    expect(report!.checks[0]!.before!.code).not.toBe(0);
    expect(report!.checks[0]!.after.map((run) => run.code)).toEqual([0]);
    expect(records.some((r) => r.tests !== undefined)).toBe(false);
  });

  it("given a check that passes before the agent and fails on its change, when the task runs on the machine, then the same agent gets each repair round, the change is still kept for review, and the report carries every round", async () => {
    // when
    const { outcome, records, log } = await run(checked("test ! -f skills/add-an-on-call-note/SKILL.md"));

    // then
    expect(outcome.status).toBe("needs-review");
    const [report] = records.flatMap((r) => (r.verification ? [r.verification] : []));
    expect(report!.checks[0]!.before!.code).toBe(0);
    expect(report!.checks[0]!.after.map((run) => run.code === 0)).toEqual([false, false, false]);
    expect(report!.repairs).toBe(2);
    expect(log.filter((line) => line.startsWith("Starting Demo agent"))).toHaveLength(3);
  });

  it("given an agent that writes a file and then fails, when the run ends, then the task fails and what it changed is still recorded for undo", async () => {
    // when
    const { outcome } = await run(work({}, "Task: Add an on-call note\nstand-in: write env HOME\nstand-in: fail"));

    // then
    expect(outcome).toMatchObject({ status: "failed", changes: { files: [expect.objectContaining({ path: "env-HOME.txt" })] } });
  });

  it.each([
    ["a folder on another of the person's machines", { machineId: "mch_other" }, /on another of your machines/],
    ["a hidden folder", { path: "~/.hidden" }, /hidden/],
    ["a full path in place of one from the home", { path: "/etc" }, /not named from this machine's home/],
    ["a project id that is not one", { projectId: "../../escape" }, /does not take/],
  ])("given a lease naming %s, when the machine reads it against its own rule, then nothing runs and the folder is untouched", async (_case, fields, why) => {
    // when
    const { outcome } = await run(work(fields));

    // then
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(why) });
    expect(existsSync(join(home, "notes", "skills"))).toBe(false);
  });

  it("given the folder was swapped for a link to another since it was opened, when the task starts, then it does not run there", async () => {
    // given
    mkdirSync(join(home, "elsewhere"));
    rmSync(join(home, "notes"), { recursive: true });
    symlinkSync(join(home, "elsewhere"), join(home, "notes"));

    // when
    const { outcome } = await run(work());

    // then
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/moved or became a link/) });
    expect(existsSync(join(home, "elsewhere", "skills"))).toBe(false);
  });

  it("given the folder became a git repository since it was opened, when the task starts, then it does not run in place", async () => {
    // given
    mkdirSync(join(home, "notes", ".git"));

    // when
    const { outcome } = await run(work());

    // then
    expect(outcome).toMatchObject({ status: "failed", error: expect.stringMatching(/is a git repository now/) });
  });
});
