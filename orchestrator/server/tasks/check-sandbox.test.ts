import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../auth.js";
import { seededContext, storePrincipals } from "../test-fixtures.js";
import { fakeAgentAdapter } from "./agents.js";
import { bwrapArgs, checkPlaces, findCheckSandbox, sandboxed } from "./check-sandbox.js";
import { createTaskRunner } from "./runner.js";
import { readEvidence } from "./verify.js";

const ADMIN: Principal = { id: "a", name: "Ada Example", email: "ada@example.invalid", role: "admin", ownedTeams: [] };
const FAKE_AGENT = join(import.meta.dirname, "..", "..", "demo", "fake-agent.mjs");
const onMac = process.platform === "darwin";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in home holding a sign-in file, another project's secrets and a cache, a task's own directories inside a data directory, and a place outside both. */
function places() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "th-box-")));
  dirs.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  const task = { work: join(data, "tasks", "t1", "work"), tmp: join(data, "tasks", "t1", "tmp"), home: join(data, "tasks", "t1", "home"), git: join(data, "task-git", "t1") };
  for (const dir of [join(home, ".ssh"), join(home, "other-project"), join(home, "code", "bin"), join(home, "code", "other"), join(home, ".npm"), join(home, ".local", "bin"), join(home, ".local", "share", "keyrings"), join(root, "outside"), ...Object.values(task)]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(home, ".ssh", "id_stand_in"), "stand-in key\n");
  writeFileSync(join(home, "other-project", ".env"), "STAND_IN=1\n");
  writeFileSync(join(home, "code", "other", ".env"), "STAND_IN=2\n");
  writeFileSync(join(home, "code", "bin", "tool"), "#!/bin/sh\n");
  writeFileSync(join(home, ".npm", "cached"), "cached\n");
  writeFileSync(join(home, ".local", "share", "keyrings", "login"), "stand-in keyring\n");
  writeFileSync(join(data, "vault.key"), "stand-in vault\n");
  writeFileSync(join(task.git, "HEAD"), "ref: refs/heads/main\n");
  return { root, home, data, task, outside: join(root, "outside") };
}

describe("the sandbox a check runs in on a person's own orchestrator", { timeout: 120_000 }, () => {
  it.runIf(onMac)("given seatbelt on this Mac, when a check reaches across the person's home, a project beside a bin on the PATH, the data directory, the git directory and an agent's socket, then only the tool caches, that bin and the task's own directories answer", async () => {
    // given
    const at = places();
    const box = await findCheckSandbox("darwin");
    if ("refused" in box) throw new Error(box.refused);
    const socket = join(at.outside, "agent.sock");
    const agent = createServer((c) => c.end("hi")).listen(socket);
    await new Promise((r) => agent.once("listening", r));
    const reach = `node -e "require('net').connect(process.argv[1]).on('connect',()=>{console.log('REACHED-AGENT');process.exit(0)}).on('error',()=>process.exit(0))" ${socket}`;
    const script = [
      `cat ${at.home}/.ssh/id_stand_in && echo READ-KEY`,
      `cat ${at.home}/other-project/.env && echo READ-OTHER-PROJECT`,
      `cat ${at.home}/code/other/.env && echo READ-BESIDE-A-PATH-BIN`,
      `cat ${at.home}/code/bin/tool >/dev/null && echo READ-PATH-BIN`,
      `cat ${at.home}/.local/share/keyrings/login && echo READ-KEYRING`,
      `cat ${at.home}/.npm/cached >/dev/null && echo READ-CACHE`,
      `cat ${at.data}/vault.key && echo READ-VAULT`,
      `cat ${at.task.git}/HEAD >/dev/null && echo READ-GIT`,
      `echo x > ${at.task.git}/config && echo WROTE-GIT`,
      `echo x > ${at.outside}/f && echo WROTE-OUTSIDE`,
      `echo x > ${at.task.work}/f && echo WROTE-WORK`,
      `echo x > ${at.task.tmp}/f && echo WROTE-TMP`,
      reach,
      "exit 0",
    ].join("; ");

    // when
    const inv = await sandboxed(box, checkPlaces(at.task, { home: at.home, path: `${join(at.home, "code", "bin")}:${join(at.home, ".local", "bin")}:${process.env.PATH ?? ""}` }, at.data, "darwin"), { program: "/bin/sh", args: ["-c", script], env: { PATH: process.env.PATH ?? "" }, cwd: at.task.work });
    const said = await new Promise<string>((done) => execFile(inv.program, inv.args, { cwd: inv.cwd, env: inv.env, encoding: "utf8" }, (_err, stdout) => done(stdout)));
    agent.close();

    // then
    expect(said.trim().split("\n")).toEqual(["READ-PATH-BIN", "READ-CACHE", "READ-GIT", "WROTE-WORK", "WROTE-TMP"]);
    expect(existsSync(join(at.outside, "f"))).toBe(false);
  });

  it("given a person's home, their PATH and a task's directories, when a check's places are laid out, then the home and the data directory are hidden, the caches and each PATH directory alone open read-only, never the folder a PATH bin sits in, the sign-ins and cache tokens hidden again, and the task's directories open last", () => {
    // given
    const at = places();

    // when
    const laid = checkPlaces(at.task, { home: at.home, path: `${join(at.home, "code", "bin")}:${join(at.home, "bin")}:/usr/bin` }, at.data, "linux");

    // then
    expect(laid.hidden.slice(0, 3)).toEqual([at.home, at.data, "/tmp"]);
    expect(laid.tools).toEqual(expect.arrayContaining([join(at.home, ".npm"), join(at.home, ".local", "bin"), join(at.home, "code", "bin"), join(at.home, "bin")]));
    expect(laid.tools).not.toContain(at.home);
    expect(laid.tools).not.toContain(join(at.home, "code"));
    expect(laid.secrets).toEqual(expect.arrayContaining([join(at.home, ".ssh"), join(at.home, ".local", "share", "keyrings"), join(at.home, ".cache", "huggingface")]));
    expect(laid).toMatchObject({ readable: [at.task.git], writable: [at.task.work, at.task.tmp, at.task.home] });
  });

  it("given the layered places, when bubblewrap's arguments are written, then the file system is read-only and each layer follows in order: hidden, tools back read-only, sign-ins hidden again, the task's directories back", () => {
    // given
    const at = places();
    const layers = { hidden: [at.home], tools: [join(at.home, ".local")], secrets: [join(at.home, ".local", "share", "keyrings"), join(at.data, "vault.key")], readable: [at.task.git], writable: [at.task.work] };

    // when
    const args = bwrapArgs(layers, new Set([at.home, join(at.home, ".local", "share", "keyrings")])).join(" ");

    // then
    expect(args.startsWith("--ro-bind / / --dev /dev --proc /proc")).toBe(true);
    const at_ = (part: string) => args.indexOf(part);
    expect(at_(`--tmpfs ${at.home}`)).toBeLessThan(at_(`--ro-bind ${join(at.home, ".local")} ${join(at.home, ".local")}`));
    expect(at_(`--ro-bind ${join(at.home, ".local")} `)).toBeLessThan(at_(`--tmpfs ${join(at.home, ".local", "share", "keyrings")}`));
    expect(args).toContain(`--ro-bind /dev/null ${join(at.data, "vault.key")}`);
    expect(at_(`--tmpfs ${join(at.home, ".local", "share", "keyrings")}`)).toBeLessThan(at_(`--bind ${at.task.work} ${at.task.work}`));
    expect(args).toContain(`--ro-bind ${at.task.git} ${at.task.git}`);
  });

  it("given Linux with no bubblewrap and a platform with no sandbox, when the sandbox is looked for, then each answers why no check runs", async () => {
    // when
    const linux = await findCheckSandbox("linux", "/nowhere");
    const other = await findCheckSandbox("win32");

    // then
    expect(linux).toEqual({ refused: expect.stringContaining("bubblewrap (bwrap)") });
    expect(other).toEqual({ refused: "no sandbox for a check is known on win32" });
  });

  it("given a local orchestrator that finds no sandbox, when a task with the configuration's check runs, then the check never runs, the task still reaches review, and its log and evidence say why in one line", async () => {
    // given
    const { ctx, root } = await seededContext("th-box-run-", ["payments-skills"]);
    dirs.push(root);
    ctx.mode = "local";
    await storePrincipals(ctx, ADMIN);
    const marker = join(root, "check-ran");
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => `touch ${marker}`, hostEnv: { PATH: process.env.PATH }, checkSandbox: async () => ({ refused: "no sandbox for a check is known on this machine" }) });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Add an on-call note", description: "", agent: "fake", user: ADMIN });
    await tasks.idle();

    // then
    expect(existsSync(marker)).toBe(false);
    expect(await ctx.store.getTask(ctx.tenant, started.id)).toMatchObject({ status: "needs-review", tests: "skipped" });
    expect((await ctx.store.taskLog(ctx.tenant, started.id, 0)).map((l) => l.text)).toContain("No check runs on this task: no sandbox for a check is known on this machine.");
    expect(await readEvidence(ctx.store, ctx.tenant, started.id, repo.id)).toMatchObject({ verdict: "not-run", reason: "No sandbox for a check is known on this machine." });
  });

  it.runIf(onMac)("given a task whose directories sit in a data directory under the person's home, when a Node check resolves and loads its own file, then it does, while the home itself still neither lists nor reads", async () => {
    // given
    const root = realpathSync(mkdtempSync(join(tmpdir(), "th-box-under-home-")));
    dirs.push(root);
    const home = join(root, "home");
    const data = join(home, "Library", "Application Support", "handbook-orchestrator");
    const task = { work: join(data, "tasks", "t1", "work"), tmp: join(data, "tasks", "t1", "tmp"), home: join(data, "tasks", "t1", "home"), git: join(data, "task-git", "t1") };
    for (const dir of Object.values(task)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "notes.txt"), "the person's own\n");
    writeFileSync(join(task.work, "check.js"), "console.log('LOADED')\n");
    const box = await findCheckSandbox("darwin");
    if ("refused" in box) throw new Error(box.refused);
    const script = [
      `node -e "require('fs').realpathSync(process.argv[1]); console.log('RESOLVED')" '${task.work}/check.js'`,
      `node '${task.work}/check.js'`,
      `ls '${home}' >/dev/null 2>&1 && echo LISTED-HOME`,
      `cat '${home}/notes.txt' 2>/dev/null && echo READ-HOME`,
      "exit 0",
    ].join("; ");

    // when
    const inv = await sandboxed(box, checkPlaces(task, { home, path: process.env.PATH ?? "" }, data, "darwin"), { program: "/bin/sh", args: ["-c", script], env: { PATH: process.env.PATH ?? "" }, cwd: task.work });
    const said = execFileSync(inv.program, inv.args, { cwd: inv.cwd, env: inv.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    // then
    expect(said.trim().split("\n")).toEqual(["RESOLVED", "LOADED"]);
  });

  it.runIf(onMac)("given a local orchestrator on this Mac and a check that reaches for the person's sign-in and outside the task, when the task runs, then the check runs in seatbelt: neither reaches, and its own writes land", async () => {
    // given
    const { ctx, root } = await seededContext("th-box-mac-", ["payments-skills"]);
    dirs.push(root);
    ctx.mode = "local";
    await storePrincipals(ctx, ADMIN);
    const home = join(realpathSync(root), "person");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_stand_in"), "stand-in key\n");
    const outside = join(realpathSync(root), "outside");
    const check = `cat ${home}/.ssh/id_stand_in && echo READ-KEY; echo x > ${outside} && echo WROTE-OUTSIDE; echo x > "$TMPDIR/note" && echo WROTE-TMP; exit 0`;
    const tasks = createTaskRunner(ctx, { agents: [fakeAgentAdapter(FAKE_AGENT)], isolation: { mode: "process", network: "open" }, testCommand: () => check, hostEnv: { PATH: process.env.PATH, HOME: home } });
    const repo = (await ctx.store.getRepo(ctx.tenant, "payments-skills"))!;

    // when
    const started = await tasks.start({ repo, title: "Add an on-call note", description: "", agent: "fake", user: ADMIN });
    await tasks.idle();

    // then
    const evidence = (await readEvidence(ctx.store, ctx.tenant, started.id, repo.id))!;
    const output = evidence.checks[0]!.after.at(-1)!.output;
    expect(output).toContain("WROTE-TMP");
    expect(output).not.toContain("READ-KEY");
    expect(output).not.toContain("WROTE-OUTSIDE");
    expect(existsSync(outside)).toBe(false);
  });
});
