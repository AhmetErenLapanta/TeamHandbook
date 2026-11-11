import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { createServer } from "node:net";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { AccountStore } from "./accounts.js";
import { newId } from "./ids.js";
import { localMode } from "./mode.js";
import type { MachineRecord, RunnerStore } from "./runner-store.js";

/** The port a local orchestrator asks for first; when something else holds it, any free one. */
export const LOCAL_PORT = 8080;

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Where a local orchestrator keeps its data when ORCHESTRATOR_DATA_DIR does not say: the system's place for an application's data. */
export function localDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "TeamHandbook Orchestrator");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "TeamHandbook Orchestrator");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "teamhandbook-orchestrator");
}

/**
 * The folder repositories are connected by path under: ORCHESTRATOR_LOCAL_REPOS_ROOT when set, one
 * folder an org under it when there are several, and for a local orchestrator with none the
 * person's home, where their clones are; a team's or the cloud's reads no path without it.
 */
export function localReposRoot(env: NodeJS.ProcessEnv, tenants: readonly string[], tenant: string, home: string = homedir()): string | null {
  const root = env.ORCHESTRATOR_LOCAL_REPOS_ROOT?.trim();
  if (root) return tenants.length > 1 ? join(root, tenant) : root;
  return localMode(env) ? home : null;
}

/** What a path outside that folder is told: on a local orchestrator nobody configured, the home it means, never a setting the person has not heard of. */
export function outsideReposRoot(env: NodeJS.ProcessEnv = process.env, path?: string): string {
  const wsl = path === undefined ? null : onWindowsFromWsl(path, env);
  if (wsl) return wsl;
  return !env.ORCHESTRATOR_LOCAL_REPOS_ROOT?.trim() && localMode(env) ? "that path is outside your home folder; connect a clone inside it" : "that path is outside the folder ORCHESTRATOR_LOCAL_REPOS_ROOT names";
}

/** Why a local orchestrator refuses an address to listen on: it answers this machine only, since nothing asks who is calling. */
export function localHostProblem(host: string): string | null {
  return LOOPBACK.has(host) ? null : `ORCHESTRATOR_HOST=${host} reaches beyond this machine, and a local orchestrator signs nobody in; listen on 127.0.0.1, or run it as a team's with ORCHESTRATOR_MODE=self-hosted`;
}

/** What stops a start before anything is opened: a local orchestrator told to listen beyond this machine. A team's or the cloud's is not asked. */
export function localStartProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  return localMode(env) ? localHostProblem(env.ORCHESTRATOR_HOST || "127.0.0.1") : null;
}

/** The port to listen on: `preferred` when it is free on `host`, otherwise one the system gives. */
export function pickPort(preferred: number, host: string): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(null));
      probe.listen(port, host, () => {
        const address = probe.address();
        const taken = typeof address === "object" && address ? address.port : null;
        probe.close(() => resolve(taken));
      });
    });
  return tryPort(preferred).then(async (port) => port ?? (await tryPort(0)) ?? preferred);
}

/**
 * The name a local orchestrator gives its one person: the one they gave git, or "you". Never the
 * system account's name, which a screenshot, a shared screen or a support call would carry off.
 */
export function localOwnerName(gitName: () => string | null = globalGitName): string {
  return gitName()?.trim().slice(0, 80) || "you";
}

function globalGitName(): string | null {
  try {
    return execFileSync("git", ["config", "--global", "--get", "user.name"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const MACHINE_SETTING = "local.machine";

/** The id of the machine row a local orchestrator keeps for its own runner, or null where it keeps none. */
export async function localMachineId(store: Pick<AccountStore, "getSetting">, tenant: string): Promise<string | null> {
  return store.getSetting(tenant, MACHINE_SETTING);
}

/**
 * The one machine row a local orchestrator keeps for its person: it runs their tasks itself, so
 * there is no pairing, key or token, and its leases are held under this id as a connected
 * machine's are. Made at the first start, found again at every one after.
 */
export async function localMachine(store: RunnerStore & Pick<AccountStore, "getSetting" | "setSetting">, tenant: string, owner: { id: string }, name: string = hostname(), platform: string = process.platform): Promise<MachineRecord> {
  const kept = await store.getSetting(tenant, MACHINE_SETTING);
  const found = kept ? (await store.listMachines(tenant, owner.id)).find((m) => m.id === kept && !m.revokedAt) : undefined;
  if (found) return found;
  const machine: MachineRecord = { tenant, id: newId("mch"), userId: owner.id, name, platform, publicKey: "", agents: [], createdAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null };
  // The hash of random bytes thrown away: no request carries a token that names this machine.
  await store.insertMachine({ ...machine, tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex") }, null);
  await store.setSetting(tenant, MACHINE_SETTING, machine.id);
  return machine;
}

const ADDRESS_FILE = "address";

/** Writes where this local orchestrator answers into its data directory, readable by its own user only, so a second start can point there. */
export function writeLocalAddress(dataDir: string, url: string): void {
  const file = join(dataDir, ADDRESS_FILE);
  writeFileSync(file, `${url}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The address the orchestrator holding this data directory wrote, when it wrote one on this machine. */
export function runningAddress(dataDir: string): string | null {
  const file = join(dataDir, ADDRESS_FILE);
  if (!existsSync(file)) return null;
  const url = readFileSync(file, "utf8").trim();
  return /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url) ? url : null;
}

const REENTRY_FILE = "reentry";
const REENTRY_HEADER = "x-reentry-secret";

/**
 * The secret a second start shows the running orchestrator to be given a fresh sign-in link: a
 * file in the data directory only the person's own user reads, so another user or a page in the
 * browser asks in vain.
 */
export function reentrySecret(dataDir: string): string {
  const file = join(dataDir, REENTRY_FILE);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("base64url"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

/** The one route a second local start calls: the reentry secret in, a fresh one-time link out. */
export function localLinkRoutes(dataDir: string, freshLink: () => Promise<string>): Hono {
  const app = new Hono();
  app.post("/api/local/link", async (c) => {
    const given = Buffer.from(c.req.header(REENTRY_HEADER) ?? "");
    const kept = Buffer.from(reentrySecret(dataDir));
    if (given.length !== kept.length || !timingSafeEqual(given, kept)) return c.json({ error: "not this machine's orchestrator" }, 403);
    return c.json({ url: await freshLink() }, 200, { "cache-control": "no-store" });
  });
  return app;
}

/** Asks the orchestrator already running on this data directory for a fresh link; null when it does not answer. */
export async function askForLink(dataDir: string, running: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const answer = await fetcher(`${running}api/local/link`, { method: "POST", headers: { [REENTRY_HEADER]: reentrySecret(dataDir) } }).catch(() => null);
  if (!answer?.ok) return null;
  const { url } = (await answer.json().catch(() => ({}))) as { url?: unknown };
  return typeof url === "string" && url.startsWith(running) ? url : null;
}

const OPEN_FILE = "open.html";

/**
 * A page in the data directory, readable by the person's own user only, that sends the browser on
 * to `url`. The browser is opened on this file rather than on the link: a command's arguments are
 * listed for every user of the machine, and the link carries the one-time sign-in token.
 */
export function signInPage(dataDir: string, url: string): string {
  const file = join(dataDir, OPEN_FILE);
  const quoted = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${quoted}"><title>TeamHandbook Orchestrator</title><a href="${quoted}">Open TeamHandbook Orchestrator</a>\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** What a start tells the person about signing in: the browser opening, or, when it is left closed, the page to open themselves. */
export function signInSentence(page: string, opened: boolean): string {
  return opened ? `It opens in your browser; to sign in from another browser on this machine, open ${page} in it within five minutes.` : `Open ${page} in your browser within five minutes to sign in.`;
}

type Spawner = (command: string, args: string[]) => { unref: () => void; on: (event: "error", listener: () => void) => unknown };

/**
 * What a folder on Windows, reached from WSL under /mnt/, is told when it is refused as outside the
 * home: where to put it instead, so git and the agent work on WSL's own disk. Null anywhere else.
 */
export function onWindowsFromWsl(path: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return runsInWsl(env) && path.startsWith("/mnt/") ? "that folder is on Windows, outside your home folder in WSL; clone it inside WSL, for instance into ~/code, where git and the agent are fast" : null;
}

/** Whether this Linux is Windows' Subsystem for Linux, where the browser is Windows' and xdg-open is usually missing. */
export function runsInWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** How Windows names a file of this Linux under WSL, or the target unchanged when it is an address; null when the distribution is not named. */
function windowsTarget(target: string, env: NodeJS.ProcessEnv): string | null {
  if (!target.startsWith("/")) return target;
  return env.WSL_DISTRO_NAME ? `\\\\wsl$\\${env.WSL_DISTRO_NAME}${target.replace(/\//g, "\\")}` : null;
}

/**
 * Opens the orchestrator's address in the person's browser: the command BROWSER names, or the
 * system's own opener; under WSL wslview, and Windows' own start when wslview is not installed.
 * ORCHESTRATOR_NO_BROWSER=1 leaves it closed; a browser that does not open is no failure, since the
 * address is printed too. Returns the command used, or null.
 */
export function openBrowser(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: Spawner = (command, args) => spawn(command, args, { stdio: "ignore", detached: true }),
  wsl: boolean = platform === "linux" && runsInWsl(env),
): string | null {
  if (env.ORCHESTRATOR_NO_BROWSER === "1") return null;
  const start = (command: string, args: string[], fallback: () => void = () => undefined) => {
    const child = run(command, args);
    child.on("error", fallback);
    child.unref();
    return command;
  };
  if (env.BROWSER?.trim()) return start(env.BROWSER.trim(), [url]);
  if (platform === "darwin") return start("open", [url]);
  if (platform === "win32") return start("cmd", ["/c", "start", "", url]);
  if (wsl) {
    return start("wslview", [url], () => {
      const target = windowsTarget(url, env);
      if (target) start("cmd.exe", ["/c", "start", "", target]);
    });
  }
  return start("xdg-open", [url]);
}
