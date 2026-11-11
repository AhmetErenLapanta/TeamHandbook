import { execFile, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { nonInteractiveEnv } from "./plugin.js";

export const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 64 * 1024 * 1024;

export interface Identity {
  name: string;
  email: string;
}

/**
 * git for a server: never prompts, never reads the host account's global or system config.
 * An orchestrator runs under a service account on a shared host; whatever that account's
 * ~/.gitconfig says (a credential helper, a rewrite of URLs, a hook path) belongs to the
 * host, not to the teams whose repositories the orchestrator reads.
 *
 * A commit's author is whoever asked for the change; the committer is always the orchestrator.
 * A forge shows the author, so a request reads as the person's, while the committer still
 * says which tool wrote it.
 */
/** Who every orchestrator commit names as its committer. */
export function orchestratorCommitter(): Identity {
  return { name: process.env.ORCHESTRATOR_GIT_NAME ?? "TeamHandbook Orchestrator", email: process.env.ORCHESTRATOR_GIT_EMAIL ?? "orchestrator@teamhandbook.invalid" };
}

function gitEnv(author?: Identity): NodeJS.ProcessEnv {
  return {
    ...nonInteractiveEnv(process.env),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: author?.name ?? process.env.ORCHESTRATOR_GIT_NAME ?? "TeamHandbook Orchestrator",
    GIT_AUTHOR_EMAIL: author?.email ?? process.env.ORCHESTRATOR_GIT_EMAIL ?? "orchestrator@teamhandbook.invalid",
    GIT_COMMITTER_NAME: orchestratorCommitter().name,
    GIT_COMMITTER_EMAIL: orchestratorCommitter().email,
  };
}

/**
 * The same git, blocking. Every call holds the whole process until git exits - sign-in,
 * the usage receiver and task logs included - so a request path uses `gitAsync`. This stays
 * for setup work that runs before the server listens (the demo seed, test fixtures) and for
 * code not moved yet.
 */
export function git(args: string[], cwd: string, input?: string, author?: Identity): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    stdio: ["pipe", "pipe", "pipe"],
    env: gitEnv(author),
  });
}

/** Blocking git, but a missing object or path is an answer (null) rather than an exception. */
export function gitMaybe(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Blocking git whose output is bytes, for `cat-file --batch`, where sizes are counted in bytes. */
export function gitBytes(args: string[], cwd: string, input?: string, maxBuffer = MAX_OUTPUT): Buffer {
  return execFileSync("git", args, { cwd, input, timeout: GIT_TIMEOUT_MS, maxBuffer, stdio: ["pipe", "pipe", "pipe"], env: gitEnv() });
}

export interface GitRunOptions {
  /** Ends git when the request that asked for it goes away; only for reads, never inside a write's turn. */
  signal?: AbortSignal;
  /** A larger output allowance for one call, such as listing a very large tree. */
  maxBuffer?: number;
  /**
   * Settings for this one call, given as git's GIT_CONFIG_* environment: a fetch credential
   * travels here, never in an argument (which `ps` shows) or a URL (which the mirror's config keeps).
   */
  env?: Record<string, string>;
}

function run(args: string[], cwd: string, input: string | undefined, author: Identity | undefined, encoding: "utf8" | "buffer", options: GitRunOptions): Promise<string | Buffer> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      { cwd, encoding, timeout: GIT_TIMEOUT_MS, maxBuffer: options.maxBuffer ?? MAX_OUTPUT, env: { ...gitEnv(author), ...options.env }, ...(options.signal ? { signal: options.signal } : {}) },
      (err, stdout, stderr) => {
        // The blocking call's error carries stdout and stderr; this one is given the same, so
        // a caller that reads git's message (a sync error shown on screen) reads it either way.
        // A folder that is gone makes Node report "spawn git ENOENT", which reads as if git
        // itself were missing; the caller is told which repository is no longer there.
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(cwd)) fail(new RepositoryGone(cwd));
        else if (err) fail(Object.assign(err, { stdout, stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr }));
        else done(stdout);
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/** A folder git was asked to work in is gone; `path` says which, for whoever decides how to tell it. */
export class RepositoryGone extends Error {
  constructor(readonly path: string) {
    super(`the repository at ${path} is no longer there`);
  }
}

/** git as above, without holding the process: the orchestrator keeps answering while it runs. */
export async function gitAsync(args: string[], cwd: string, input?: string, author?: Identity, options: GitRunOptions = {}): Promise<string> {
  return (await run(args, cwd, input, author, "utf8", options)) as string;
}

export async function gitAsyncMaybe(args: string[], cwd: string, options: GitRunOptions = {}): Promise<string | null> {
  try {
    return await gitAsync(args, cwd, undefined, undefined, options);
  } catch (err) {
    // A read the caller gave up on is not an answer that the object is missing.
    if (options.signal?.aborted || stoppedFromOutside(err)) throw err;
    return null;
  }
}

/**
 * git ended by a signal this process did not send it. Ctrl-C in a terminal, or a stop sent to the
 * orchestrator's process group, reaches every git it started along with it; what such a git
 * wrote on its way out ("Could not read from remote repository") says nothing about the repository.
 */
export function stoppedFromOutside(err: unknown): boolean {
  const ended = err as { signal?: unknown; killed?: unknown } | null;
  return Boolean(ended?.signal) && !ended?.killed;
}

export async function gitAsyncBytes(args: string[], cwd: string, input?: string, options: GitRunOptions = {}): Promise<Buffer> {
  return (await run(args, cwd, input, undefined, "buffer", options)) as Buffer;
}

const lanes = new Map<string, Promise<unknown>>();

/**
 * One name for a repository however it is spelled - through a symbolic link, with a trailing
 * slash - and the same name before and after it exists: the real path of the nearest folder
 * that exists, with the rest of the path after it. A mirror's first clone queues under the
 * same name as the sync that comes once the clone has made the folder.
 */
export function turnKey(repository: string): string {
  let existing = resolve(repository);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(existsSync(existing) ? realpathSync(existing) : existing, ...rest);
}

/**
 * Runs `work` after every earlier piece of work for the same repository has finished. A
 * blocking git made writes to one repository take turns for free; with git running in the
 * background, two requests could otherwise move the same ref at once - two merges computed
 * from one head, or a sync fetching into a mirror another sync is fetching into.
 */
export function oneAtATime<T>(repository: string, work: () => Promise<T>): Promise<T> {
  const key = turnKey(repository);
  const turn = (lanes.get(key) ?? Promise.resolve()).then(work, work);
  const settled = turn.then(
    () => undefined,
    () => undefined,
  );
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return turn;
}

/** Runs `work` for each item in order, at most `atOnce` at a time; once `signal` is aborted no further item begins. */
export async function eachAtMost<T>(items: readonly T[], atOnce: number, work: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  const waiting = [...items];
  const worker = async () => {
    while (waiting.length && !signal?.aborted) await work(waiting.shift()!);
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, waiting.length) }, worker));
}

/**
 * Waits until every turn started so far, and every turn queued behind it, has finished, or
 * until `limitMs` has passed. A stop waits here so that a merge already under way either
 * completes or never began: one cut off between its steps leaves a request whose record and
 * repository disagree.
 */
export async function drainTurns(limitMs: number): Promise<boolean> {
  const deadline = Date.now() + limitMs;
  while (lanes.size) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await Promise.race([Promise.all(lanes.values()), new Promise((resolve) => setTimeout(resolve, left))]);
  }
  return true;
}
