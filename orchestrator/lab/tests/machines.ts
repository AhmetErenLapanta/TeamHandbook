import { createServer, Socket } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { cleanMachine, freePort, portFree } from "../clean-machine.js";
import type { CleanMachine } from "../clean-machine.js";
import { OrchestratorClient } from "../client.js";
import { seedTeamRepo } from "../repos.js";
import { claudeStandIn, started, thePackage, until } from "../solo.js";
import type { Started } from "../solo.js";
import { lab, readHead, spareOrchestratorPort, startOrchestratorProcess, unique } from "./support.js";
import type { OrchestratorProcess } from "./support.js";

/**
 * What the scenarios of people's own machines share: a team's orchestrator whose tasks run on
 * the machine of the person who starts them, reached by the machines through a link the scenario
 * cuts and gives back, and a clean machine of one of its people connected with the command
 * Settings shows, running the packed orchestrator's runner with the stand-in claude.
 */

/** A loopback relay in front of the orchestrator: the address a machine is given, which the scenario cuts and gives back. */
export interface Link {
  url: string;
  /** Ends every open connection and refuses new ones, as a machine that lost its network sees it. */
  cut: () => Promise<void>;
  restore: () => Promise<void>;
  close: () => Promise<void>;
}

export async function loopbackLink(target: number): Promise<Link> {
  const port = await freePort();
  const open = new Set<Socket>();
  let server: Server | null = null;
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server = createServer((inbound) => {
        const outbound = new Socket();
        open.add(inbound).add(outbound);
        const drop = () => {
          inbound.destroy();
          outbound.destroy();
          open.delete(inbound);
          open.delete(outbound);
        };
        inbound.on("error", drop).on("close", drop);
        outbound.on("error", drop).on("close", drop);
        outbound.connect(target, "127.0.0.1", () => inbound.pipe(outbound).pipe(inbound));
      });
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
  const stop = async () => {
    for (const socket of open) socket.destroy();
    open.clear();
    const closing = server;
    server = null;
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
  };
  await listen();
  return { url: `http://127.0.0.1:${port}`, cut: stop, restore: listen, close: stop };
}

export interface TeamOrchestrator {
  orchestrator: OrchestratorProcess;
  tenant: string;
  /** The orchestrator as a browser reaches it: its public address, the only one it takes a sign-in from. */
  url: string;
  /** The orchestrator as a machine reaches it, and the address Settings names in the connect command. */
  link: Link;
  repoId: string;
  /** The orchestrator's data directory, its SQLite store in it. */
  dataDir: string;
  owner: OrchestratorClient;
  /** A member of its one team, and a teammate in the same team. */
  person: (key: "member" | "teammate") => { email: string; name: string };
  as: (key: "member" | "teammate") => Promise<OrchestratorClient>;
  stop: () => Promise<void>;
}

const REPO = "core-skills";
const PEOPLE = { member: "Laptop Member", teammate: "Laptop Teammate" } as const;

/**
 * A team's orchestrator on SQLite with one team repository of its own, whose tasks run on its
 * people's machines: ORCHESTRATOR_SERVER_TASKS is not set, and its public address is the link.
 */
export async function teamOrchestrator(scenario: string): Promise<TeamOrchestrator> {
  const tenant = unique(scenario);
  const dir = join(lab.dir, scenario, tenant);
  const bare = join(dir, "repos", `${REPO}.git`);
  seedTeamRepo(lab.path, { id: REPO, team: "Core", reviewers: [], labels: [], skills: [{ slug: "first-skill", description: "Use when a laptop takes a task.", body: "1. Begin.\n" }] }, bare, `file://${bare}`, join(dir, "scratch"));
  const port = spareOrchestratorPort(1);
  // An orchestrator another run left there answers the health check this one waits for, and refuses this run's setup code.
  expect(await portFree(port), `port ${port} is free`).toBe(true);
  const link = await loopbackLink(port);
  const code = unique("setup");
  const orchestrator = await startOrchestratorProcess({ port, tenant, dataDir: join(dir, "data"), store: "sqlite", setupCode: code, repos: [{ id: REPO, team: "Core", url: `file://${bare}` }], env: { ORCHESTRATOR_SERVER_TASKS: "0", ORCHESTRATOR_AGENTS: "claude-code", ORCHESTRATOR_PUBLIC_URL: link.url } });
  const stop = async () => {
    await orchestrator.stop();
    await link.close();
  };
  try {
    const owner = await OrchestratorClient.setup(orchestrator.url, code, { email: `owner@${tenant}.example.invalid`, name: "Laptop Owner" }, lab.password);
    const person = (key: "member" | "teammate") => ({ email: `${key}@${tenant}.example.invalid`, name: PEOPLE[key] });
    for (const key of ["member", "teammate"] as const) await owner.ok("POST", "/api/users", { ...person(key), role: "member", teams: ["Core"], password: lab.password });
    await readHead(owner, REPO);
    return { orchestrator, tenant, url: link.url, link, repoId: REPO, dataDir: join(dir, "data"), owner, person, as: (key) => OrchestratorClient.signIn(orchestrator.url, person(key).email, lab.password), stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Signs a person in on the orchestrator's own page, signed out of whoever was before. */
export async function signInOnPage(page: Page, team: TeamOrchestrator, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto(team.url);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(lab.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(new RegExp(`/${team.tenant}/`));
}

export interface Laptop {
  machine: CleanMachine;
  name: string;
  /** The machine's id at the orchestrator, once it is connected. */
  id: string;
  /** The command it was connected with, as Settings showed it: the address and the one-time code last. */
  command: string[];
  runner: Started;
  stop: () => Promise<void>;
}

/** The command that connects a machine, as Settings > Your machines shows it to the person signed in on the page. */
export async function connectCommand(page: Page, team: TeamOrchestrator): Promise<string[]> {
  await page.goto(`${team.url}/${team.tenant}/settings/machines`);
  await page.getByRole("button", { name: "Connect a machine" }).first().click();
  const command = (await page.locator(".copy-text code").first().textContent({ timeout: 30_000 }))!.trim().split(/\s+/);
  expect(command.slice(0, 3)).toEqual(["handbook-orchestrator", "runner", "connect"]);
  return command;
}

/** The packed orchestrator's runner on a clean machine, given a command as Settings shows it. */
export function runOnMachine(root: string, command: string[], name: string): { machine: CleanMachine; runner: Started } {
  const machine = cleanMachine(root, process.env.PATH ?? "");
  // Named here so the machine's own host name stays out of the orchestrator's store and the evidence.
  const runner = started("npm", ["exec", "--offline", "--yes", "--package", thePackage(), "--", ...command, "--name", name], { ...machine.env, ORCHESTRATOR_CLAUDE_BIN: claudeStandIn(root) }, machine.home);
  return { machine, runner };
}

export async function stopRunner(runner: Started): Promise<void> {
  // A runner that already ended has no process group left to signal.
  if (runner.child.exitCode !== null || runner.child.signalCode !== null) return;
  process.kill(-runner.child.pid!, "SIGINT");
  await Promise.race([runner.exited, new Promise((r) => setTimeout(r, 20_000))]);
}

/**
 * A person's laptop connected once with the command Settings shows them: connected once the
 * person's list of machines names it, or failed with what the runner said when it ended first.
 */
export async function connectLaptop(page: Page, team: TeamOrchestrator, key: "member" | "teammate", root: string): Promise<Laptop> {
  const name = `${key}-laptop`;
  await signInOnPage(page, team, team.person(key).email);
  const command = await connectCommand(page, team);
  const { machine, runner } = runOnMachine(root, command, name);
  try {
    const client = await team.as(key);
    const listed = await until(() => client.ok<{ machines: { id: string; name: string; revokedAt: string | null }[] }>("GET", "/api/machines").then((r) => r.machines.find((m) => m.name === name && !m.revokedAt)), (m) => m !== undefined || runner.child.exitCode !== null, 480);
    expect(listed, `the runner ended ${runner.child.exitCode}: ${runner.said()}`).toBeDefined();
    return { machine, name, id: listed!.id, command, runner, stop: () => stopRunner(runner) };
  } catch (err) {
    await stopRunner(runner);
    throw err;
  }
}
