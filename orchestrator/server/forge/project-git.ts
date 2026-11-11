import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { OrchestratorError } from "../errors.js";
import { redactLine } from "../log.js";
import { detectSecret, nonInteractiveEnv } from "../plugin.js";

/*
 * Git in the person's own folder, as the person: "Make this a Git repository", "Commit these
 * changes" and a clone from GitHub or GitLab. Their own git config, identity, ssh key and
 * credential helper do the work; the orchestrator reads none of them beyond the name and address
 * a commit is signed with, and passes nothing of its own. No hook of the folder runs: a
 * repository's own scripts are not run without the person asking.
 */

export class ProjectGitRefused extends OrchestratorError {
  constructor(message: string, status: 400 | 404 | 409 | 413 | 502 = 409) {
    super("project-git", message, status);
  }
}

/** The most files a commit here takes, and their size in all: past these, the person commits in the folder. */
export const COMMIT_MAX_FILES = 2000;
export const COMMIT_MAX_BYTES = 100 * 1024 * 1024;
/** How much of a file is read to tell whether it holds a secret. */
const SCAN_BYTES = 1024 * 1024;

const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

// These point git at another repository or hand it settings no file shows, past the folder's own settings judged below.
const GIT_STEERING = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/;

function personEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(nonInteractiveEnv(process.env)).filter(([name]) => !name.startsWith("ORCHESTRATOR_") && !GIT_STEERING.test(name)));
  return { ...env, GIT_LITERAL_PATHSPECS: "1", ...extra };
}

/**
 * Settings in a repository's own config that have git run a program: a filter, a diff or merge
 * driver, a signing program, an ssh command, an editor or pager, a credential helper, or another
 * file pulled in. An agent working in a folder writes its .git/config as easily as any file, so a
 * folder whose own config holds one is not committed from here. The hooks path and fsmonitor are
 * set off on every call, so a folder that sets them, as husky does, is still committed.
 */
const RUNS_A_PROGRAM = /^(filter\.|gpg\.|credential\.|include\.|includeif\.|merge\.[^.]+\.driver$|diff\.external$|diff\.[^.]+\.(textconv|command)$|core\.(sshcommand|editor|pager|askpass|gitproxy)$|sequence\.editor$)/i;

/** Refuses a folder whose git settings would run a program of the folder's own, or whose .git leads elsewhere. */
function judgeFolderGit(folder: string): void {
  const dotGit = join(folder, ".git");
  if (!lstatSync(dotGit).isDirectory()) throw new ProjectGitRefused("this folder's .git leads elsewhere; commit in the folder yourself");
  for (const file of ["config", "config.worktree"]) {
    const path = join(dotGit, file);
    if (!existsSync(path)) continue;
    // `--file` reads that one file and no include of it, and runs nothing.
    const names = execFileSync("git", ["config", "--file", path, "--list", "--name-only"], { env: personEnv(), encoding: "utf8" }).split("\n").filter(Boolean);
    const runs = names.find((name) => RUNS_A_PROGRAM.test(name));
    if (runs) throw new ProjectGitRefused(`this folder's own git settings run a program (${runs}); commit in the folder yourself`);
    // A working tree set elsewhere, or a bare repository, has git read and commit files outside this folder.
    const bare = execFileSync("git", ["config", "--file", path, "--type=bool", "--default=false", "--get", "core.bare"], { env: personEnv(), encoding: "utf8" }).trim() === "true";
    const elsewhere = names.find((name) => name.toLowerCase() === "core.worktree") ?? (bare ? "core.bare" : undefined);
    if (elsewhere) throw new ProjectGitRefused(`this folder's own git settings work on files outside it (${elsewhere}); commit in the folder yourself`);
  }
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function personGit(args: string[], cwd: string, extra?: Record<string, string>): Promise<Ran> {
  return new Promise((done) => {
    execFile("git", [...SAFE, ...args], { cwd, env: personEnv(extra), timeout: 300_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const said = (ran: Ran) => redactLine((ran.stderr || ran.stdout).replace(/\p{C}+/gu, " ").trim().slice(0, 300));

/** `git init` in the folder and nothing more: no file is added and nothing is committed. */
export async function initRepository(folder: string): Promise<void> {
  if (existsSync(join(folder, ".git"))) throw new ProjectGitRefused("this folder is a Git repository already");
  const ran = await personGit(["init", "--quiet"], folder);
  if (ran.code !== 0) throw new ProjectGitRefused(`git did not make this folder a repository: ${said(ran)}`, 502);
}

export interface CommitFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Its size in the folder; null for a deleted file. */
  bytes: number | null;
  /** Its name or its contents look like a secret: the screen leaves it unticked. */
  secretLike: boolean;
}

export interface CommitPreview {
  files: CommitFile[];
  omitted: number;
  /** No commit yet: this one is the repository's first. */
  first: boolean;
}

// The names sunucu's shadow copy keeps out too; a file with one is listed unticked, and a live edit of one carries no patch.
export const SECRET_NAME = /(^|\/)(\.env(\..*)?|[^/]*\.pem|[^/]*\.key|id_[^/]*|[^/]*\.p12|\.npmrc|\.netrc|credentials[^/]*)$/i;

async function secretIn(folder: string, path: string): Promise<string | null> {
  const file = join(folder, path);
  const stat = await lstat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  const head = (await readFile(file)).subarray(0, SCAN_BYTES);
  return head.includes(0) ? null : detectSecret(head.toString("utf8"));
}

const STATUS = (code: string): CommitFile["status"] => (code.includes("R") ? "renamed" : code.includes("D") ? "deleted" : code === "??" || code.includes("A") ? "added" : "modified");

/** What a commit of the folder's changes would take, as `git status` lists them, its .gitignore heeded. */
export async function commitPreview(folder: string): Promise<CommitPreview> {
  if (!existsSync(join(folder, ".git"))) throw new ProjectGitRefused("this folder is not a Git repository yet");
  judgeFolderGit(folder);
  const ran = await personGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], folder);
  if (ran.code !== 0) throw new ProjectGitRefused(`git did not read the folder's changes: ${said(ran)}`, 502);
  const fields = ran.stdout.split("\0");
  const files: CommitFile[] = [];
  let omitted = 0;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename names its old path in the next field.
    if (code.includes("R") || code.includes("C")) i++;
    if (files.length >= COMMIT_MAX_FILES) {
      omitted++;
      continue;
    }
    const status = STATUS(code);
    const stat = status === "deleted" ? null : await lstat(join(folder, path)).catch(() => null);
    const secretLike = SECRET_NAME.test(path) || (status !== "deleted" && (await secretIn(folder, path)) !== null);
    files.push({ path, status, bytes: stat ? stat.size : null, secretLike });
  }
  const first = (await personGit(["rev-parse", "--verify", "--quiet", "HEAD"], folder)).code !== 0;
  return { files, omitted, first };
}

/**
 * The folder's changes committed as the person, with the message they gave, every file but those
 * they left out, and only those: what they had staged by hand beyond them does not go in. A file
 * whose contents look like a secret is refused even when it was ticked.
 */
export async function commitChanges(folder: string, message: string, exclude: readonly string[]): Promise<{ headSha: string }> {
  const subject = message.trim();
  if (!subject || /[\r\n]/.test(subject)) throw new ProjectGitRefused("a commit has a message, one line long", 400);
  const preview = await commitPreview(folder);
  // Judged again right before git writes: the folder is written to between the preview and the commit.
  judgeFolderGit(folder);
  if (preview.omitted) throw new ProjectGitRefused(`more than ${COMMIT_MAX_FILES} files changed; commit in the folder yourself`, 413);
  const left = new Set(exclude);
  const taken = preview.files.filter((f) => !left.has(f.path));
  if (!taken.length) throw new ProjectGitRefused("nothing to commit");
  if (taken.reduce((sum, f) => sum + (f.bytes ?? 0), 0) > COMMIT_MAX_BYTES) throw new ProjectGitRefused(`the changes pass ${COMMIT_MAX_BYTES / 1024 / 1024} MB; commit in the folder yourself`, 413);
  for (const file of taken) {
    const secret = file.status === "deleted" ? null : await secretIn(folder, file.path);
    if (secret) throw new ProjectGitRefused(`${file.path} looks like it holds a ${secret}; leave it out of the commit`);
  }
  for (const key of ["user.name", "user.email"]) {
    if (!(await personGit(["config", "--get", key], folder)).stdout.trim()) throw new ProjectGitRefused(`your git has no ${key}; set it with \`git config --global ${key} "..."\`, then commit again`);
  }
  // A new file joins the index as intent-to-add, so `--only` takes it with the rest and nothing else.
  const added = taken.filter((f) => f.status === "added").map((f) => f.path);
  if (added.length) {
    const ran = await personGit(["add", "--intent-to-add", "--", ...added], folder);
    if (ran.code !== 0) throw new ProjectGitRefused(`git did not take the new files: ${said(ran)}`, 502);
  }
  const ran = await personGit(["commit", "--quiet", "--no-verify", "--only", "-m", subject, "--", ...taken.map((f) => f.path)], folder);
  if (ran.code !== 0) throw new ProjectGitRefused(`git did not commit: ${said(ran)}`, 502);
  return { headSha: (await personGit(["rev-parse", "HEAD"], folder)).stdout.trim() };
}

/** A folder name for a clone: letters, digits, dots, dashes and underscores, starting with neither a dot nor a dash. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Where a clone goes and what it is cloned from: an https address with no user or token in it, or
 * an ssh one (ssh://, or user@host:path). Anything else, file://, ext::, git://, plain http, or an
 * address git would read as an option, is refused. With no place given it goes to ~/code/<name>.
 */
export function cloneTarget(url: string, home: string, into?: string): { url: string; into: string } {
  const address = url.trim();
  const https = /^https:\/\//i.test(address) && URL.canParse(address) ? new URL(address) : null;
  const ssh = /^ssh:\/\/[^\s/@]+@?[^\s/]*\/\S+$/i.test(address) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s/][^\s]*$/.test(address);
  if (address.startsWith("-") || (!https && !ssh) || (https && (https.username || https.password))) throw new ProjectGitRefused("a repository address over https or ssh, with no user or token in it", 400);
  const name = basename((https ? https.pathname : address.replace(/^.*[:/]/, "")).replace(/\/+$/, "")).replace(/\.git$/, "");
  if (!NAME.test(name)) throw new ProjectGitRefused(`"${name}" is not a folder name for the clone; give a place for it`, 400);
  return { url: address, into: into ?? join(home, "code", name) };
}

/**
 * A clone made with the person's own git into a folder that does not exist yet, never into one
 * that does. Redirects are not followed and only `protocols` are reached. A clone that fails leaves
 * no folder behind.
 */
export async function cloneRepository(url: string, into: string, protocols = "https:ssh"): Promise<void> {
  if (existsSync(into)) throw new ProjectGitRefused(`${into} already exists; choose another place`);
  await mkdir(dirname(into), { recursive: true });
  const ran = await personGit(["-c", "http.followRedirects=false", "clone", "--quiet", "--", url, into], dirname(into), { GIT_ALLOW_PROTOCOL: protocols });
  if (ran.code !== 0) {
    await rm(into, { recursive: true, force: true });
    throw new ProjectGitRefused(`git did not clone it: ${said(ran)}`, 502);
  }
}

/**
 * Why a request does not merge into the branch checked out in the person's own working copy, or
 * null when it does: the folder's own git settings run nothing and work on no file outside it, and
 * no tracked file holds a change of theirs the merge would meet. Untracked files git checks itself.
 */
export async function checkoutBusy(folder: string): Promise<string | null> {
  try {
    judgeFolderGit(folder);
  } catch {
    return "its own git settings run a program or work on files outside it";
  }
  const status = await personGit(["status", "--porcelain", "--untracked-files=no"], folder);
  if (status.code !== 0) return `git did not read it: ${said(status)}`;
  return status.stdout.trim() ? "it has changes not committed" : null;
}

/**
 * Moves the branch checked out in the person's working copy forward to `ref` of the repository at
 * `from`, and its files with it, as `git merge --ff-only` does, with the folder's hooks off: a merge
 * the orchestrator makes runs none of the person's programs. Git refuses rather than overwrite a
 * file of theirs; the reason comes back.
 */
export async function fastForwardCheckout(folder: string, from: string, ref: string): Promise<string | null> {
  const fetched = await personGit(["fetch", "--quiet", "--no-tags", from, `${ref}:refs/orchestrator/merged`], folder);
  if (fetched.code !== 0) return `git did not read the merge: ${said(fetched)}`;
  const moved = await personGit(["merge", "--ff-only", "--quiet", "refs/orchestrator/merged"], folder);
  await personGit(["update-ref", "-d", "refs/orchestrator/merged"], folder);
  return moved.code === 0 ? null : said(moved);
}
