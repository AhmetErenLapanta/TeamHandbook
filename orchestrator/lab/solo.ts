import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cleanMachine, freePort, packed } from "./clean-machine.js";
import type { CleanMachine } from "./clean-machine.js";

/**
 * What the solo scenarios share: the package and the release the build makes, the stand-ins a
 * clean machine is given for its browser and its Claude Code, the ways a person installs the
 * orchestrator, a repository of the person's own, and a session on the orchestrator they start.
 */

export const ORCHESTRATOR_DIR = join(import.meta.dirname, "..");

/** The account lab/stand-in-claude.mjs reports in its sign-in probe, which the orchestrator never shows. */
export const SIGNED_IN_AS = { email: "solo@person.example.invalid", orgName: "Solo Person's Organization" };

/** The package the build makes, once per run; LAB_PACKAGE names one already built. */
let tarball = process.env.LAB_PACKAGE ?? "";
export function thePackage(): string {
  if (tarball) return tarball;
  const built = spawnSync("npm", ["run", "--silent", "build:package"], { cwd: ORCHESTRATOR_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`npm run build:package failed: ${built.stderr}`);
  // Its last line names the tarball, then how many files and how large: "<path>.tgz (11 files, 568 KB)".
  tarball = /^(\S+\.tgz)\b/.exec(built.stdout.trim().split("\n").pop()!.trim())?.[1] ?? "";
  if (!existsSync(tarball)) throw new Error(`the build named no tarball: ${built.stdout.trim().split("\n").pop()}`);
  return tarball;
}

/** A browser that only writes down what it was asked to open. */
export function browserStandIn(root: string): { command: string; opened: () => string[] } {
  const command = join(root, "browser");
  const log = join(root, "browser.log");
  writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`);
  chmodSync(command, 0o755);
  return { command, opened: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

/** Where the stand-in claude of a clean machine writes down what each of its sessions loaded and was refused. */
export const claudeLoads = (root: string) => join(root, "claude-loads.ndjson");

/** The stand-in claude, outside the PATH, which ORCHESTRATOR_CLAUDE_BIN names; `paceMs` spaces its steps for a recording. */
/** Opens the one-time sign-in address the orchestrator printed and presses its Continue, as a person does: the page spends the address only on that press. */
export async function signInAt(page: Page, address: string): Promise<void> {
  await page.goto(address);
  // A build from before that page signs in on the visit itself.
  const press = page.getByRole("button", { name: "Continue", exact: true });
  if (await press.waitFor({ timeout: 5_000 }).then(() => true, () => false)) await press.click();
}

export function claudeStandIn(root: string, paceMs = 0, more: Record<string, string> = {}): string {
  const command = join(root, "agents", "claude");
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(command, `#!/bin/sh\nLAB_CLAUDE_LOADS='${claudeLoads(root)}' LAB_STANDIN_PACE_MS=${Math.max(0, Math.round(paceMs))} ${Object.entries(more).map(([k, v]) => `${k}='${v}'`).join(" ")} exec node '${join(ORCHESTRATOR_DIR, "lab", "stand-in-claude.mjs")}' "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}

/** The packed command, in a process group of its own, with what it prints kept. */
export function runPacked(env: NodeJS.ProcessEnv, port: number, extra: Record<string, string> = {}): { child: ChildProcess; said: () => string; exited: Promise<number | null> } {
  let said = "";
  const child = spawn("npm", ["exec", "--offline", "--yes", "--package", thePackage(), "--", "teamhandbook-orchestrator", "--port", String(port)], { env: { ...env, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk) => (said += String(chunk)));
  child.stderr!.on("data", (chunk) => (said += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, said: () => said, exited };
}

export async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, tries: number): Promise<T> {
  let value = await read();
  for (let i = 0; i < tries && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 250));
    value = await read();
  }
  return value;
}

export const REPO_ROOT = join(ORCHESTRATOR_DIR, "..");
export const SAID_BY_INSTALL = /installed (\S+); start it with: handbook-orchestrator/;

/** The release build's directory, once per run; LAB_RELEASE names one already built. */
let release = process.env.LAB_RELEASE ?? "";
export function theRelease(): string {
  if (release) return release;
  const built = spawnSync("npm", ["run", "--silent", "build:release"], { cwd: ORCHESTRATOR_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`npm run build:release failed: ${built.stderr}`);
  release = join(ORCHESTRATOR_DIR, "package-out", "release");
  return release;
}

/** A mirror of a release directory on a loopback port of the lab's own: each file by its name, and 404 for anything else. */
export async function mirrorOf(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\/+/, ""));
    const file = join(dir, name);
    if (!name || name.includes("/") || name.startsWith(".") || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export type Install = "clone" | "npx" | "install.sh";

export interface Started {
  child: ChildProcess;
  said: () => string;
  exited: Promise<number | null>;
  /** What installing printed, before the orchestrator started. */
  installed: string;
}

export function started(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, installed = ""): Started {
  let said = "";
  const child = spawn(command, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (chunk) => (said += String(chunk)));
  child.stderr!.on("data", (chunk) => (said += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, said: () => said, exited, installed };
}

/**
 * The orchestrator installed and started on the clean machine the way a person does. A clone is
 * of `ref`, this commit unless another is named, with the dependencies this checkout installed copied in, since the lab reaches no
 * registry and the clone's own npm ci is what the quality runs measure; npm start then builds and
 * starts it. The tarball runs through npm exec. install.sh comes from a mirror of this run's
 * release build, which is checked to serve that build's files before anything is installed.
 */
export async function install(how: Install, machine: CleanMachine, env: NodeJS.ProcessEnv, port: number, ref = "HEAD"): Promise<Started> {
  if (how === "npx") return started("npm", ["exec", "--offline", "--yes", "--package", thePackage(), "--", "teamhandbook-orchestrator", "--port", String(port)], env, machine.home);
  if (how === "clone") {
    const clone = join(machine.home, "TeamHandbook");
    const head = spawnSync("git", ["-C", REPO_ROOT, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).stdout.trim();
    for (const args of [["clone", "--quiet", "--no-checkout", `file://${REPO_ROOT}`, clone], ["-C", clone, "checkout", "--quiet", head]]) {
      const done = spawnSync("git", args, { env, encoding: "utf8" });
      if (done.status !== 0) throw new Error(`git ${args[0]} failed on the clean machine: ${done.stderr}`);
    }
    const copied = spawnSync("cp", [process.platform === "darwin" ? "-cR" : "-R", join(ORCHESTRATOR_DIR, "node_modules"), join(clone, "orchestrator", "node_modules")], { encoding: "utf8" });
    if (copied.status !== 0) throw new Error(`the dependencies were not copied: ${copied.stderr}`);
    // Installed after the lockfile was checked out, as an install on the clone itself would be.
    const now = new Date();
    utimesSync(join(clone, "orchestrator", "node_modules", ".package-lock.json"), now, now);
    // npm start runs the server itself, which takes its port from the environment, not from a flag.
    return started("npm", ["start"], { ...env, ORCHESTRATOR_PORT: String(port) }, clone);
  }
  const dir = theRelease();
  const mirror = await mirrorOf(dir);
  try {
    for (const file of ["manifest.json", "SHA256SUMS"]) {
      const served = Buffer.from(await (await fetch(`${mirror.url}${file}`)).arrayBuffer());
      expect(served.equals(readFileSync(join(dir, file))), `the mirror's ${file} is this run's`).toBe(true);
    }
    // The release keeps a copy of install.sh made when it was built; one built before a change to it is not this commit's.
    const script = Buffer.from(await (await fetch(`${mirror.url}install.sh`)).arrayBuffer());
    expect(script.equals(readFileSync(join(ORCHESTRATOR_DIR, "scripts", "install.sh"))), "the mirror's install.sh is this commit's").toBe(true);
    expect((await fetch(`${mirror.url}missing.tar.gz`)).status).toBe(404);
    const archive = readdirSync(dir).find((f) => f.endsWith(".tar.gz"))!;
    expect(packed(join(dir, archive), join(machine.home, "..", "release-unpacked")).missing).toEqual([]);
    // In a process of its own and awaited: the mirror answers from this process, which a blocking wait would stop.
    const installing = started("/bin/sh", ["-c", `curl -fsSL '${mirror.url}install.sh' | sh`], { ...env, HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL: mirror.url }, machine.home);
    const code = await Promise.race([installing.exited, new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 300_000))]);
    const installed = installing.said();
    if (code !== 0) throw new Error(`install.sh ended ${code}: ${installed}`);
    return started(join(machine.home, ".local", "bin", "handbook-orchestrator"), ["--port", String(port)], env, machine.home, installed);
  } finally {
    await mirror.close();
  }
}

/** A git repository of the person's own: a service with one endpoint, on main. */
export function personsRepository(machine: CleanMachine): string {
  const repo = join(machine.home, "work", "delivery-service");
  mkdirSync(join(repo, "src", "endpoints"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# delivery-service\n\nAnswers the shipments' calls, an endpoint per call under src/endpoints/.\n");
  writeFileSync(join(repo, "src", "endpoints", "shipments.ts"), 'export const shipments = { method: "GET", path: "/shipments" };\n');
  for (const args of [["init", "--quiet", "-b", "main"], ["add", "."], ["commit", "--quiet", "-m", "A service with one endpoint"]]) {
    const done = spawnSync("git", args, { cwd: repo, env: machine.env, encoding: "utf8" });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
  }
  return repo;
}

/** A solo orchestrator started from the package on a clean machine, signed in through its one-time link. */
export interface SoloSession {
  machine: CleanMachine;
  base: string;
  run: Started;
  page: Page;
  call: <T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, data?: unknown) => Promise<T>;
  /** The same, with the answer's status kept rather than thrown. */
  ask: <T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, data?: unknown) => Promise<{ status: number; json: T }>;
  stop: () => Promise<void>;
}

/** `more` adds to the orchestrator's environment, such as a stand-in on its PATH, once the clean machine is made. */
export async function soloSession(page: Page, root: string, more: (machine: CleanMachine) => NodeJS.ProcessEnv = () => ({})): Promise<SoloSession> {
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const browser = browserStandIn(root);
  const port = await freePort();
  const env = { ...machine.env, BROWSER: browser.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root), ...more(machine) };
  const run = await install("npx", machine, env, port);
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    process.kill(-run.child.pid!, "SIGINT");
    await Promise.race([run.exited, new Promise((r) => setTimeout(r, 20_000))]);
  };
  try {
    const ready = await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
    expect(ready).toEqual({ ready: true });
    const opened = await until(() => browser.opened(), (o) => o.length > 0, 40);
    await signInAt(page, /url=([^"]+)"/.exec(readFileSync(opened[0]!, "utf8"))![1]!.replace(/&amp;/g, "&"));
    const { csrf } = (await (await page.request.get(`${base}/api/me`)).json()) as { csrf: string };
    const ask = async <T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, data?: unknown) => {
      const res = await page.request.fetch(`${base}${path}`, { method, headers: { "x-csrf-token": csrf }, ...(data ? { data } : {}) });
      return { status: res.status(), json: (await res.json().catch(() => ({}))) as T };
    };
    const call = async <T>(method: "GET" | "POST" | "PATCH" | "PUT", path: string, data?: unknown) => {
      const { status, json } = await ask<T>(method, path, data);
      if (status < 200 || status >= 300) throw new Error(`${method} ${path} answered ${status}: ${JSON.stringify(json)}`);
      return json;
    };
    return { machine, base, run, page, call, ask, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Every file under a folder with its bytes, by its path in it. */
export function contents(folder: string): Record<string, string> {
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => [relative(folder, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "base64")]));
}

/**
 * A task's page as the browser draws it, once it shows the task's title or the fault a section
 * that broke while drawing shows instead; the fault's text is the failure, so a crash names its error.
 */
export async function drawnTaskPage(page: Page, address: string, title: string): Promise<void> {
  await page.goto(address);
  const heading = page.getByRole("heading", { level: 1, name: title });
  await expect(heading.or(page.getByRole("heading", { name: "Something went wrong on this page" }))).toBeVisible({ timeout: 30_000 });
  expect(await page.locator("pre.fault").allTextContents()).toEqual([]);
  await expect(heading).toBeVisible();
}
