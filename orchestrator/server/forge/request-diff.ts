import { gitAsyncMaybe } from "../git.js";

/*
 * A request's changes for a screen that shows what a merge would bring: the list of files with
 * their status and line counts and whether each is a test, then one file's patch at a time. Read
 * from git objects, in the orchestrator's bare mirror or the person's own repository, never from a
 * checkout, and cut so a request that rewrites a vendored tree cannot fill the page or the process.
 */

/** A changed file as the list of a request's changes shows it, before its patch is asked for. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  previousPath: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** A test file, which the screen can hide on the reader's preference. */
  test: boolean;
}

export interface RequestChanges {
  base: string;
  head: string;
  files: ChangedFile[];
  /** Set when files past the limit were left out. */
  omitted: number;
}

/** One file's patch, asked for on its own; `note` says in words why none is shown. */
export interface FileDiff extends ChangedFile {
  patch: string | null;
  truncated: boolean;
  note: string | null;
}

/** More files than a review screen reads one by one. */
export const DIFF_MAX_FILES = 300;
/** One file's patch asked for on its own is cut past this: a long generated file, read on its page. */
export const FILE_PATCH_MAX = 512 * 1024;

const TEST = /(^|\/)(tests?|__tests__|specs?)\//i;
const TEST_FILE = /(\.|_)(test|spec)\.[a-z0-9]+$|_test\.go$/i;

export function isTestPath(path: string): boolean {
  return TEST.test(path) || TEST_FILE.test(path);
}

const STATUS: Record<string, ChangedFile["status"]> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "modified" };

interface Range {
  base: string;
  head: string;
}

/** The request's head, from the first of `refs` the repository holds, and where it branched from `repoHead`. */
async function range(dir: string, repoHead: string, refs: string[]): Promise<Range | string> {
  let head: string | null = null;
  for (const ref of refs) {
    head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], dir))?.trim() || null;
    if (head) break;
  }
  if (!head) return "the orchestrator's copy does not hold this request's commits yet; sync the repository to read them";
  const base = (await gitAsyncMaybe(["merge-base", repoHead, head], dir))?.trim();
  if (!base) return "this request shares no history with the default branch";
  return { base, head };
}

/** Each changed file with its status, line counts, whether it is binary and whether it is a test; the first DIFF_MAX_FILES of them. */
async function changedFiles(dir: string, { base, head }: Range): Promise<{ files: ChangedFile[]; omitted: number }> {
  const statuses = ((await gitAsyncMaybe(["diff", "--name-status", "-z", "-M", base, head], dir)) ?? "").split("\0");
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const numstat = ((await gitAsyncMaybe(["diff", "--numstat", "-z", "-M", base, head], dir)) ?? "").split("\0");
  for (let i = 0; i < numstat.length; i++) {
    const [added, deleted, path] = numstat[i]!.split("\t");
    if (added === undefined || deleted === undefined) continue;
    // A rename names its two paths in the next two fields; the new one is the second.
    const name = path === "" ? numstat[(i += 2)]! : path!;
    counts.set(name, { additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted) });
  }
  const files: ChangedFile[] = [];
  let omitted = 0;
  for (let i = 0; i < statuses.length; ) {
    const code = statuses[i++]!.charAt(0);
    if (!code) break;
    const renamed = code === "R" || code === "C";
    const previousPath = renamed ? statuses[i++]! : null;
    const path = statuses[i++]!;
    if (files.length >= DIFF_MAX_FILES) {
      omitted++;
      continue;
    }
    const count = counts.get(path) ?? { additions: null, deletions: null };
    files.push({ path, status: STATUS[code] ?? "modified", previousPath, ...count, binary: count.additions === null && count.deletions === null, test: isTestPath(path) });
  }
  return { files, omitted };
}

async function patchOf(dir: string, { base, head }: Range, file: ChangedFile, max: number): Promise<{ patch: string; truncated: boolean }> {
  const text = (await gitAsyncMaybe(["diff", "-M", base, head, "--", ...(file.previousPath ? [file.previousPath] : []), file.path], dir)) ?? "";
  const truncated = Buffer.byteLength(text) > max;
  return { patch: truncated ? Buffer.from(text).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "") : text, truncated };
}

/** The list of a request's changed files, with no patch: what the screen shows before a file is opened. */
export async function readRequestChanges(dir: string, repoHead: string, refs: string[]): Promise<RequestChanges | string> {
  const at = await range(dir, repoHead, refs);
  return typeof at === "string" ? at : { ...at, ...(await changedFiles(dir, at)) };
}

/**
 * One changed file's patch. A path the request does not change is answered as not found, so no
 * other file of the repository is read through here.
 */
export async function readRequestFile(dir: string, repoHead: string, refs: string[], path: string): Promise<FileDiff | null | string> {
  const at = await range(dir, repoHead, refs);
  if (typeof at === "string") return at;
  const file = (await changedFiles(dir, at)).files.find((f) => f.path === path);
  if (!file) return null;
  if (file.binary) return { ...file, patch: null, truncated: false, note: "a binary file; its contents are not shown" };
  const read = await patchOf(dir, at, file, FILE_PATCH_MAX);
  return { ...file, ...read, note: read.truncated ? `the patch passes ${FILE_PATCH_MAX / 1024} KB and is cut there` : null };
}
