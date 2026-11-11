import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { OrchestratorError } from "../errors.js";
import { cliEnv, LOGIN, said } from "./own-cli.js";

/*
 * A person signs their own gh or glab in from the Integrations card, as they would in a terminal:
 * the orchestrator starts the CLI's browser sign-in on their machine, shows them its one-time code
 * and the page to enter it on, and waits for the CLI to finish. The token stays in the CLI's own
 * store; the orchestrator reads none of what the CLI keeps, only the lines it prints. Nothing of the
 * person's git setup is changed: git is handed the CLI as its helper on each call, as before.
 */

export type SignInForge = "github" | "gitlab";

export type CliSignIn =
  | { state: "idle" }
  | { state: "waiting"; code: string | null; url: string | null; note?: string }
  | { state: "done"; account: string | null }
  | { state: "failed"; error: string; installed: boolean };

interface Login {
  tool: "gh" | "glab";
  name: string;
  install: string;
  args(host: string): string[];
  /** The command a person runs in a terminal when the card cannot sign them in. */
  terminal(host: string): string;
}

/**
 * gh with no terminal prints its device code and the page to enter it on and does not open a
 * browser (gh 2.103). glab's device sign-in needs GitLab 17.9, and on a GitLab other than gitlab.com
 * an OAuth application of glab's own, which it names when it is missing (glab 1.128).
 */
const LOGINS: Record<SignInForge, Login> = {
  github: { tool: "gh", name: "GitHub's gh", install: "https://cli.github.com", args: (host) => ["auth", "login", "--hostname", host, "--web"], terminal: (host) => `gh auth login --hostname ${host}` },
  gitlab: { tool: "glab", name: "GitLab's glab", install: "https://gitlab.com/gitlab-org/cli", args: (host) => ["auth", "login", "--hostname", host, "--device"], terminal: (host) => `glab auth login --hostname ${host}` },
};

/** Tokens in the environment that a CLI takes over its own sign-in, which would make this one pointless or refused. */
const SHADOWING = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"];

const CODE = /one-time code(?:: | \()([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Za-z0-9-]{6,12})/;
const URL_LINE = /(?:in your web browser|authorize): (https?:\/\/\S+)/;
const SIGNED_IN = /Logged in as (\S+)/;

/** A host as the CLI takes it on its command line: a name and a port, never anything git or the CLI reads as an option. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/;

export class SignInRefused extends OrchestratorError {
  constructor(message: string) {
    super("cli-sign-in", message, 400);
  }
}

/**
 * The page the CLI says to enter the code on, kept to be offered as a link only when it is https on
 * the forge's own host, as gh and glab name it; any other address is said as plain text.
 */
function pageOf(line: string | undefined, host: string): { url: string | null; note?: string } {
  if (!line) return { url: null };
  const url = URL.canParse(line) ? new URL(line) : null;
  return url && url.protocol === "https:" && url.host === host && !url.username && !url.password ? { url: url.href } : { url: null, note: said(`the CLI asks you to open ${line}`) };
}

/** A device code lasts fifteen minutes on GitHub; a sign-in still waiting after that is stopped. */
export const SIGN_IN_MS = 15 * 60_000;

const running = new Map<string, { state: CliSignIn; stop: () => void }>();

const keyOf = (kind: SignInForge, host: string) => `${kind} ${host}`;

/** The sign-in for this forge and host as it stands: waiting with its code, done, failed, or none started. */
export function cliSignInState(kind: SignInForge, host: string): CliSignIn {
  return running.get(keyOf(kind, host))?.state ?? { state: "idle" };
}

/**
 * Starts the person's CLI sign-in for `host`, or answers the one already waiting there. The code
 * and the page come back as soon as the CLI prints them; `cliSignInState` follows it to the end.
 */
export async function startCliSignIn(kind: SignInForge, host: string, limitMs = SIGN_IN_MS): Promise<CliSignIn> {
  if (!HOST.test(host)) throw new SignInRefused(`${said(host)} is not a host name to sign in to`);
  const key = keyOf(kind, host);
  const now = running.get(key);
  if (now?.state.state === "waiting") return now.state;
  const login = LOGINS[kind];
  const env = { ...Object.fromEntries(Object.entries(cliEnv()).filter(([name]) => !SHADOWING.includes(name))), NO_COLOR: "1" };
  // Run outside any checkout, so the CLI reads no repository's remotes; stdin is closed, so nothing waits on a prompt.
  const child = spawn(login.tool, login.args(host), { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
  const entry: { state: CliSignIn; stop: () => void } = { state: { state: "waiting", code: null, url: null }, stop: () => child.kill("SIGTERM") };
  running.set(key, entry);
  let told = "";
  const settle = (state: CliSignIn) => {
    if (entry.state.state === "waiting") entry.state = state;
  };
  const read = (chunk: Buffer) => {
    told = `${told}${chunk.toString("utf8")}`.slice(-8_000);
    if (entry.state.state !== "waiting") return;
    entry.state = { state: "waiting", code: CODE.exec(told)?.[1] ?? null, ...pageOf(URL_LINE.exec(told)?.[1], host) };
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  const timer = setTimeout(() => {
    settle({ state: "failed", installed: true, error: `the sign-in to ${host} was not finished in ${Math.round(limitMs / 60_000)} minutes; press Sign in again` });
    child.kill("SIGTERM");
  }, limitMs);
  timer.unref();
  const ended = new Promise<void>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settle(err.code === "ENOENT" ? { state: "failed", installed: false, error: `${login.name} is not on this machine; install it from ${login.install}, then press Check again` } : { state: "failed", installed: true, error: `${login.tool} did not start: ${said(err.message)}` });
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const account = SIGNED_IN.exec(told)?.[1] ?? null;
      const last = told.trim().split("\n").filter(Boolean).at(-1) ?? "";
      settle(code === 0 ? { state: "done", account: account && LOGIN.test(account) ? account : null } : { state: "failed", installed: true, error: `${login.tool} did not sign in to ${host}: ${said(last) || `it ended with ${code}`}; press Sign in again, or run \`${login.terminal(host)}\` in a terminal` });
      resolve();
    });
  });
  // The code is printed within a moment; until then, or until the CLI ends, the card is told it waits.
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 3_000).unref()), new Promise<void>((resolve) => {
    const seen = () => {
      if (entry.state.state !== "waiting" || entry.state.code || entry.state.url) resolve();
    };
    child.stdout.on("data", seen);
    child.stderr.on("data", seen);
  })]);
  return entry.state;
}

/** Stops a sign-in still waiting, as the orchestrator stops; one that ended stays as it ended. */
export function stopCliSignIns(): void {
  for (const entry of running.values()) if (entry.state.state === "waiting") entry.stop();
}
