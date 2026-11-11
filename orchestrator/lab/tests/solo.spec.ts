import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { answers, cleanMachine, freePort, NO_REGISTRY, packed, portFree } from "../clean-machine.js";
import { browserStandIn, claudeStandIn, install, personsRepository, runPacked, SAID_BY_INSTALL, SIGNED_IN_AS, signInAt, thePackage, until } from "../solo.js";
import type { Install } from "../solo.js";
import { Evidence } from "../evidence.js";
import { labDir } from "../state.js";

/**
 * The orchestrator on one person's machine, started with one command and used alone: no cloud,
 * no sign-up, no sign-in, no Docker and no Postgres. Tasks run with the Claude Code already signed
 * in on that machine, each in a checkout of its own.
 *
 * The machine is a clean one (lab/clean-machine.ts): a home with a git identity, an npm that
 * reaches no registry, and a PATH whose first entries refuse every agent CLI, docker and the
 * system's browser openers, so whatever is installed here, nothing real starts. The stand-in
 * claude is handed over by ORCHESTRATOR_CLAUDE_BIN alone, and the browser is a stand-in named in
 * BROWSER that writes down what it was given. The one command is the package the build makes, run
 * as `npm exec --offline --yes --package <tarball> -- <its bin> --port <port>`; the tarball's name
 * is read from the build's output. With no ORCHESTRATOR_MODE and nothing configured it is the local
 * mode; its data sits in the system's place for an application's data under the home (on Linux
 * $XDG_DATA_HOME, or ~/.local/share/teamhandbook-orchestrator; on macOS ~/Library/Application
 * Support/TeamHandbook Orchestrator) unless ORCHESTRATOR_DATA_DIR names one. It takes
 * ORCHESTRATOR_PORT, else 8080 or a free port when 8080 is held. Once it listens it signs its one
 * person in with a one-time link: the link is written into open.html in the data directory,
 * readable by that person alone, and the page's path, never the link, goes to BROWSER, else open
 * or xdg-open, unless ORCHESTRATOR_NO_BROWSER=1. The token is in no argument and no printed line.
 * It is ready when /api/health/ready answers, and stops cleanly on SIGINT, as Ctrl-C sends. The
 * stand-in claude answers in the frames the adapters' recorded transcripts hold, approvals among
 * them, since the runner inside the orchestrator reads it as it reads a person's Claude Code. Each
 * scenario keeps an evidence directory (lab/evidence.ts). The runner inside talks to the
 * orchestrator through the same calls a machine's runner makes over the network, so these steps
 * hold for both.
 */

/**
 * The whole first use on a clean machine, timed step by step into the evidence: install, start, sign
 * in, connect the person's repository by its path, start a task and, when `asks`, allow once the
 * write its agent asks for, then the branch in the person's repository, the request and review.
 */
async function firstUse(page: Page, how: Install, asks: boolean): Promise<void> {
  // given
  const stamp = `${how.replace(/\W/g, "")}${asks ? "-asks" : ""}-${Date.now().toString(36)}`;
  const root = join(labDir(), "solo", stamp);
  const machine = cleanMachine(root, process.env.PATH ?? "");
  const browser = browserStandIn(root);
  const repo = personsRepository(machine);
  const repoHead = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const proof = new Evidence(labDir(), `solo-first-use-${stamp}`, []);
  const port = await freePort();
  const env = { ...machine.env, BROWSER: browser.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root) };
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const mark = (step: string) => (times[step] = Math.round((Date.now() - t0) / 1000));

  // when the person installs and starts it
  const run = await install(how, machine, env, port);
  mark("installed");
  const base = `http://127.0.0.1:${port}`;
  try {
    if (how === "install.sh") {
      expect(run.installed).toMatch(SAID_BY_INSTALL);
      expect(run.installed).toContain("cosign is not installed, so the release signature was not checked; the checksums were");
    }
    const ready = await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 2400);
    expect(ready).toEqual({ ready: true });
    mark("ready");
    // and the browser opens the page it is handed
    const opened = await until(() => browser.opened(), (o) => o.length > 0, 40);
    const link = /url=([^"]+)"/.exec(readFileSync(opened[0]!, "utf8"))![1]!.replace(/&amp;/g, "&");
    proof.add(new URL(link).searchParams.get("token") ?? "");
    await signInAt(page, link);
    await expect(page.locator("body")).not.toContainText(/Sign in|Sign up|Create your organization/);
    mark("signed in");
    const { csrf } = (await (await page.request.get(`${base}/api/me`)).json()) as { csrf: string };
    const call = async <T>(method: "GET" | "POST", path: string, data?: unknown): Promise<T> => {
      const res = await page.request.fetch(`${base}${path}`, { method, headers: { "x-csrf-token": csrf }, ...(data ? { data } : {}) });
      if (!res.ok()) throw new Error(`${method} ${path} answered ${res.status()}: ${await res.text()}`);
      return (await res.json()) as T;
    };

    // and Welcome's agent step reads Claude Code ready, signed in through its own login, with none of the account's own details
    const readiness = await until(() => call<{ agents: { id: string; ready: boolean; checks: { name: string; status: string; detail: string }[] }[] }>("GET", "/api/agents/readiness?fresh=1"), (r) => r.agents.some((a) => a.id === "claude-code" && a.ready), 120);
    const claude = readiness.agents.find((a) => a.id === "claude-code")!;
    expect(claude.ready).toBe(true);
    expect(claude.checks.find((c) => c.name === "Sign-in")).toMatchObject({ status: "ok", detail: expect.stringContaining("signed in (claude.ai)") });
    const options = await call<{ agents: { id: string; readiness: { ready: boolean } | null }[] }>("GET", "/api/tasks/options");
    expect(options.agents.find((a) => a.id === "claude-code")?.readiness?.ready).toBe(true);
    for (const said of [JSON.stringify(readiness), JSON.stringify(options), await page.locator("body").innerText()]) {
      expect(said).not.toContain(SIGNED_IN_AS.email);
      expect(said).not.toContain(SIGNED_IN_AS.orgName);
    }
    mark("agent ready");

    // and connects the repository by its path
    const { repo: connected } = await call<{ repo: { id: string } }>("POST", "/api/repos", { forge: "path", kind: "code", url: repo, team: "Delivery" });
    await until(() => call<{ repos: { id: string; head: string | null }[] }>("GET", "/api/repos").then((r) => r.repos.find((x) => x.id === connected.id)?.head ?? null), Boolean, 480);
    mark("connected");

    // and starts a task that asks before it writes
    const { task } = await call<{ task: { id: string } }>("POST", "/api/tasks", { title: "Expose the delivery-window endpoint", description: asks ? "stand-in: ask before writing" : "", repoId: connected.id, agent: "claude-code", ...(asks ? { mode: "approval-required" } : {}) });
    mark("started");
    if (asks) {
      const pending = await until(() => call<{ requests: { id: string; status: string }[] }>("GET", `/api/tasks/${task.id}/requests`).then((r) => r.requests.find((q) => q.status === "pending") ?? null), Boolean, 1200);
      expect(pending, "the agent's question").not.toBeNull();
      mark("asked");
      await call("POST", `/api/tasks/${task.id}/requests/${pending!.id}`, { answer: { decision: "allow_once" } });
      mark("answered");
    }
    const done = await until(() => call<{ task: { status: string; requestNumber: number | null; request: { branch: string; status: string } | null; error: string | null } }>("GET", `/api/tasks/${task.id}`).then((r) => r.task), (t) => !["queued", "running"].includes(t.status) && (t.status !== "needs-review" || t.requestNumber !== null), 2400);
    mark("finished");

    // then the task waits for review with its request recorded, and its branch is in the person's repository
    expect([done.status, done.error]).toEqual(["needs-review", null]);
    expect(done.requestNumber).not.toBeNull();
    const branch = done.request!.branch;
    proof.json("branch.json", { branch });
    expect(branch).not.toBe("main");
    expect(spawnSync("git", ["-C", repo, "show", `${branch}:src/endpoints/delivery-window.ts`], { encoding: "utf8" }).stdout).toContain('path: "/delivery-window"');
    // and the person's own checkout is as it was
    expect(spawnSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe("main");
    expect(spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim()).toBe(repoHead);
    expect(spawnSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
    // and no page on the way asked to sign up or sign in
    await page.goto(`${base}/`);
    await expect(page.locator("body")).not.toContainText(/Sign in|Sign up|Create your organization/);
  } finally {
    process.kill(-run.child.pid!, "SIGINT");
    await Promise.race([run.exited, new Promise((r) => setTimeout(r, 20_000))]);
    proof.json("timing.json", { how, asks, seconds: times });
    proof.write("installed.txt", run.installed);
    proof.write("printed.txt", run.said());
    proof.json("trapped.json", machine.trapped());
  }
  // and nothing real was reached: no claude but the stand-in, no docker, no browser
  expect(machine.trapped().filter((c) => ["claude", "docker", "open", "xdg-open", "wslview"].includes(c.name))).toEqual([]);
}

test.describe("the orchestrator alone on a person's machine", () => {
  test("given a clean machine with git, node and npm and nothing else, when the person runs the packed command with no setting, then no real CLI is reached, the package installs from its tarball alone with the new names, the browser is handed a page holding a one-time localhost link that signs the one owner in with no sign-up, sign-in, organization or invitation step, the API refuses a caller without that cookie and a used link, it answers on the loopback address only and will not start on another, its data is one SQLite file in the home's place for application data, and Ctrl-C stops it", async ({ page }) => {
    test.setTimeout(600_000);
    // given a clean machine, a free port, a registry that answers nothing, and the package with the new names
    const root = join(labDir(), "solo", `first-${Date.now().toString(36)}`);
    const machine = cleanMachine(root, process.env.PATH ?? "");
    const browser = browserStandIn(root);
    const proof = new Evidence(labDir(), `solo-first-${Date.now().toString(36)}`, []);
    const port = await freePort();
    expect(await portFree(port)).toBe(true);
    expect(spawnSync("npm", ["config", "get", "registry"], { env: machine.env, encoding: "utf8" }).stdout.trim()).toBe(NO_REGISTRY);
    expect(await answers(NO_REGISTRY)).toBe(false);
    const installs = packed(thePackage(), join(root, "unpacked"));
    expect(installs).toMatchObject({ name: "teamhandbook-orchestrator", oldNamePaths: [], missing: [] });
    expect(installs.bins).toEqual(expect.arrayContaining(["handbook-orchestrator", "teamhandbook-orchestrator"]));

    // when the person runs it with nothing set but the browser and the stand-in agent
    const env = { ...machine.env, BROWSER: browser.command, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root) };
    const run = runPacked(env, port);
    const base = `http://127.0.0.1:${port}`;
    try {
      const ready = await until(() => fetch(`${base}/api/health/ready`).then((r) => r.json() as Promise<{ ready?: boolean }>, (): { ready?: boolean } => ({})), (r) => r.ready === true, 480);
      const opened = await until(() => browser.opened(), (o) => o.length > 0, 40);

      // then it is up, and the browser was handed a page only the person reads, holding the one-time link
      expect(ready).toEqual({ ready: true });
      expect(opened).toHaveLength(1);
      const signInPage = opened[0]!;
      expect(signInPage.endsWith("open.html")).toBe(true);
      expect(statSync(signInPage).mode & 0o777).toBe(0o600);
      const link = /url=([^"]+)"/.exec(readFileSync(signInPage, "utf8"))![1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<");
      const token = new URL(link).searchParams.get("token") ?? "";
      proof.add(token);
      expect([new URL(link).origin, token.length > 0]).toEqual([base, true]);
      // and the token is in no printed line and in no process's arguments
      expect(run.said()).not.toContain(token);
      expect(spawnSync("ps", ["-axo", "args"], { encoding: "utf8" }).stdout).not.toContain(token);

      // when the browser opens that link
      await page.goto(link);

      // then the one owner is signed in, at /, with no step asking for an account, an organization or an invitation
      expect(new URL(page.url()).search).toBe("");
      await expect(page.locator("body")).not.toContainText(/Sign in|Sign up|Create your organization|Invite/);
      const me = await page.request.get(`${base}/api/me`);
      expect(me.status()).toBe(200);
      expect(await me.json()).toMatchObject({ user: { mode: "local", role: "owner" } });
      // and without the cookie, or with the same link again, nothing answers
      expect((await fetch(`${base}/api/me`)).status).toBe(401);
      expect((await fetch(link, { redirect: "manual" })).status).toBe(410);
      // and only this machine reaches it
      const beyond = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
      if (beyond) expect(await answers(`http://${beyond.address}:${port}/api/health`)).toBe(false);
      // and its data is one SQLite file in the home's place for application data
      const place = process.platform === "darwin" ? join(machine.home, "Library", "Application Support", "TeamHandbook Orchestrator") : join(machine.home, ".local", "share", "teamhandbook-orchestrator");
      expect(existsSync(join(place, "orchestrator.db"))).toBe(true);

      // when it is started on an address beyond the machine
      const otherPort = await freePort();
      const wide = runPacked(env, otherPort, { ORCHESTRATOR_HOST: "0.0.0.0", ORCHESTRATOR_DATA_DIR: join(root, "wide-data") });
      const wideCode = await Promise.race([wide.exited, new Promise<"still running">((r) => setTimeout(() => r("still running"), 60_000))]);

      // then it stops before it listens, saying why
      if (wideCode === "still running") process.kill(-wide.child.pid!, "SIGKILL");
      expect(wideCode).not.toBe("still running");
      expect(wideCode).not.toBe(0);
      expect(wide.said()).toMatch(/ORCHESTRATOR_HOST/);
      expect(await portFree(otherPort)).toBe(true);
    } finally {
      // and Ctrl-C stops it, and nothing real was reached on the way: no claude but the stand-in, no docker, no browser
      process.kill(-run.child.pid!, "SIGINT");
      await Promise.race([run.exited, new Promise((r) => setTimeout(r, 20_000))]);
      proof.write("printed.txt", run.said());
      proof.json("trapped.json", machine.trapped());
      proof.json("opened.json", browser.opened());
    }
    expect(await portFree(port)).toBe(true);
    expect(machine.trapped().filter((call) => ["claude", "docker", "open", "xdg-open", "wslview"].includes(call.name))).toEqual([]);
  });

  // The measure of "done" for the orchestrator on one machine: the whole first use, timed, for each way it is installed.
  for (const how of ["clone", "npx", "install.sh"] as const) {
    test(`given a clean machine and a repository of the person's own, when the person installs the orchestrator by ${how}, starts it, connects that repository by its path and starts a task, then the agent's branch is in the person's repository with the change on it, the request is recorded and the task waits for review, the person's own checkout is as it was, no page asked to sign up or sign in, nothing real was reached, and each step's time is in the evidence`, async ({ page }) => {
      test.setTimeout(900_000);
      await firstUse(page, how, false);
    });
  }

  test("given a clean machine and a repository of the person's own, when the person starts a task that asks before it writes and allows the write once on its page, then the write is made, the branch is in the person's repository and the task waits for review", async ({ page }) => {
    test.setTimeout(900_000);
    await firstUse(page, "npx", true);
  });

  test.fixme("given the orchestrator running alone, when the person connects a repository from the stand-in GitLab with their own git sign-in and adds their own Jira token, then the clone uses the person's git identity, the sprint's issues show, and a task started from one opens its request on the stand-in GitLab under their name", async () => {
    // given the person's git signed in to the stand-in GitLab, and a personal token for the stand-in Jira
    // when they connect the repository by its address and add the token in settings
    // then the clone asked the stand-in GitLab as that person, and the sprint's issues are listed
    // when they start a task from an issue
    // then its request opens on the stand-in GitLab as theirs, and the Jira token is not in any log
  });

  test.fixme("given the orchestrator running alone, when the person runs the same command again, then no second orchestrator starts and the browser is handed a fresh link to the one running, and once it is stopped with Ctrl-C the command opens on the same data with the repository and the task still there, asking nothing new", async () => {
    // given a repository connected and a task finished
    // when the command is run a second time on the same data directory
    // then it starts no second orchestrator: it asks the running one for a fresh link and hands the browser its page, as the first start did
    // and the fresh link signs the person in, and the first link stays used
    // when the first is stopped with SIGINT and the command run again
    // then it exits cleanly first, and the second start lists the repository and the task, and nothing asks for setup again
  });

  test.fixme("given the same code started as a team's self-hosted orchestrator, when someone opens it, then it asks them to sign in as before, so the local mode is the default only on one person's machine and never opens a shared one", async () => {
    // given the orchestrator started in team mode on the lab's data
    // when a browser opens it with no session
    // then the sign-in page shows, and the API answers 401 without a session
  });
});
