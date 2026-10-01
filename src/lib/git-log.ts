import { execFileSync } from "node:child_process";

/** One file a commit touched, with the status letter git reported for it. */
export interface CommitFile {
  /** git's raw status letter: A, M, D, R, C, T. Renames keep the R so a mass rename is countable. */
  status: string;
  path: string;
  /** Lines added and removed, or null for a binary file, which git reports as "-". */
  added: number | null;
  removed: number | null;
}

export interface RawCommit {
  sha: string;
  parents: string[];
  /** The author email exactly as git reported it. Never leaves this module's caller unhashed. */
  authorEmail: string;
  /** Author date, ISO 8601 with offset. */
  date: string;
  subject: string;
  files: CommitFile[];
}

export interface ReadCommitsOptions {
  /** Which ref to walk. A repository without it is reported by the thrown error, not skipped silently. */
  ref?: string;
  /** Passed to git as --since, e.g. "2024-01-01" or "18 months ago". */
  since?: string;
  /**
   * Turn rename detection off. On a blobless clone (--filter=blob:none) rename detection makes git
   * fetch blobs one by one over the network, which turns a one second log into minutes.
   */
  noRenames?: boolean;
  /** Test seam: what actually runs git. */
  run?: GitRunner;
}

export type GitRunner = (args: string[], cwd: string) => string;

/**
 * git's own output can be several megabytes for a repository with thousands of commits, and
 * execFileSync's default 1 MiB buffer turns that into an ENOBUFS throw rather than a short read.
 */
const MAX_OUTPUT_BYTES = 1 << 28;

const defaultRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

/** Record and field separators, chosen because a commit subject cannot contain either. */
const RECORD = "\x1e";
const FIELD = "\x1f";

/**
 * Reads one repository's history. Never fetches: mining runs against whatever the machine already
 * has, so it cannot be the reason a repository changes or a network call leaves the machine.
 *
 * --raw and --numstat together give the status letter and the line counts in a single walk; asking
 * for --name-status alongside --numstat silently keeps only one of the two.
 */
export function readCommits(repoPath: string, options: ReadCommitsOptions = {}): RawCommit[] {
  const run = options.run ?? defaultRunner;
  const args = [
    // Without this git octal-escapes any path outside ASCII, so those files would cluster as
    // separate roles from their plain-ASCII siblings.
    "-c",
    "core.quotePath=false",
    "log",
    options.ref ?? "HEAD",
    "--raw",
    "--numstat",
    `--format=${RECORD}%H${FIELD}%P${FIELD}%aE${FIELD}%aI${FIELD}%s`,
  ];
  if (options.noRenames) args.push("--no-renames");
  if (options.since) args.push(`--since=${options.since}`);
  return parseLog(run(args, repoPath));
}

/** The ref to walk, preferring the shared history over whatever the working copy has checked out. */
export function resolveRef(repoPath: string, preferred: string[], options: { run?: GitRunner } = {}): string | null {
  const run = options.run ?? defaultRunner;
  for (const ref of preferred) {
    try {
      run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
      return ref;
    } catch {
      // A ref this repository does not have. The caller learns from the returned null, not from a throw.
    }
  }
  return null;
}

/** Whether git sees a repository at this path at all. */
export function isRepository(repoPath: string, options: { run?: GitRunner } = {}): boolean {
  const run = options.run ?? defaultRunner;
  try {
    run(["rev-parse", "--git-dir"], repoPath);
    return true;
  } catch {
    return false;
  }
}

/** The line of a failed git call that says what went wrong, rather than the whole command line. */
export function gitFailure(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = stderr ? String(stderr) : error instanceof Error ? error.message : String(error);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => line.startsWith("fatal:")) ?? lines[0] ?? "git failed";
}

export function parseLog(output: string): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const record of output.split(RECORD)) {
    if (!record.trim()) continue;
    const newline = record.indexOf("\n");
    const header = newline === -1 ? record : record.slice(0, newline);
    const [sha, parents, authorEmail, date, ...rest] = header.split(FIELD);
    if (!sha || date === undefined) continue;
    // The subject is last in the format string, so anything a subject holds that looks like a
    // separator rejoins here rather than shifting every later field.
    const subject = rest.join(FIELD);
    const files = newline === -1 ? [] : parseFileBlock(record.slice(newline + 1));
    commits.push({
      sha,
      parents: (parents ?? "").split(" ").filter(Boolean),
      authorEmail: authorEmail ?? "",
      date,
      subject,
      files,
    });
  }
  return commits;
}

/**
 * The raw block carries the status letter, the numstat block the line counts, and the two are keyed
 * by path. A rename's raw line holds both the old and the new path; the new one is what later
 * commits will use, so that is the one kept.
 */
function parseFileBlock(block: string): CommitFile[] {
  const byPath = new Map<string, CommitFile>();
  const order: string[] = [];
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) {
      const fields = line.split("\t");
      const meta = fields[0]!.split(" ");
      const status = meta[meta.length - 1] ?? "";
      const path = fields[fields.length - 1];
      if (!path) continue;
      if (!byPath.has(path)) order.push(path);
      byPath.set(path, { status, path, added: null, removed: null });
      continue;
    }
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    // The counts only annotate a file the raw block already listed. A numstat path that matches
    // none would otherwise become a second, invented file in the commit.
    const existing = byPath.get(renamedTo(fields.slice(2).join("\t")));
    if (!existing) continue;
    // A binary file's counts are "-", which parses to null rather than to zero: zero would make a
    // large binary change look like a formatting-only commit.
    existing.added = fields[0] === "-" ? null : Number(fields[0]);
    existing.removed = fields[1] === "-" ? null : Number(fields[1]);
  }
  return order.map((path) => byPath.get(path)!);
}

/**
 * numstat writes a rename in git's compact form, `src/{old => new}/File.kt` or `old.kt => new.kt`,
 * where the raw block has the plain new path. This recovers that path.
 */
export function renamedTo(path: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`.replace(/\/\/+/g, "/").replace(/^\//, "");
  const arrow = path.indexOf(" => ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

/**
 * Author names for a walk, keyed by commit.
 *
 * Deliberately a SEPARATE read rather than another field on `RawCommit`. A name added to that
 * record would ride along into every unit, cluster and shape built from it, and the one guarantee
 * the mining path makes is that no author identity survives into what is written down. Here the
 * name has exactly one consumer - the screen that drops a piece of evidence mentioning a person -
 * and it never enters a record that is serialized.
 */
export function readAuthorNames(repoPath: string, options: ReadCommitsOptions = {}): Map<string, string[]> {
  const run = options.run ?? defaultRunner;
  // BOTH spellings of the name. `%aN` is the one a .mailmap has rewritten and `%an` is the one
  // the commit actually carries; where a mailmap maps an account to a full name the two differ,
  // and a subject mentioning the account would be invisible to a screen that only knew the
  // rewritten form. Screening is fail-closed, so it gets both.
  const args = ["log", options.ref ?? "HEAD", `--format=%H${FIELD}%aN${FIELD}%an`];
  if (options.since) args.push(`--since=${options.since}`);
  const names = new Map<string, string[]>();
  for (const line of run(args, repoPath).split("\n")) {
    if (!line) continue;
    const [sha, mapped, raw] = line.split(FIELD);
    if (!sha) continue;
    const both = [mapped, raw].filter((n): n is string => Boolean(n));
    if (both.length) names.set(sha, [...new Set(both)]);
  }
  return names;
}

/**
 * One commit's patch, limited to the paths asked for.
 *
 * `--unified=3` rather than git's default because a hunk is quoted to show what the step looks
 * like, and a hunk with no surrounding lines reads as a diff rather than as code. Renames and
 * binaries come back as headers with no body, which is what a reader should see for them anyway.
 */
export function readPatch(
  repoPath: string,
  sha: string,
  paths: string[],
  options: { run?: GitRunner } = {},
): string {
  if (paths.length === 0) return "";
  const run = options.run ?? defaultRunner;
  const args = [
    "-c",
    "core.quotePath=false",
    "show",
    sha,
    "--format=",
    "--unified=3",
    "--no-color",
    "--no-ext-diff",
    "--",
    ...paths,
  ];
  try {
    return run(args, repoPath);
  } catch {
    // A path that no longer resolves in this commit is not a reason to lose the whole packet;
    // the caller simply gets one hunk fewer.
    return "";
  }
}
