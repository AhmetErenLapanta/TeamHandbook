import { appendFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange } from "../forge/types.js";
import { gitAsync } from "../git.js";
import { detectSecret } from "../plugin.js";
import type { TaskPaths } from "./isolation.js";
import { CLAUDE_PLANS_DIR } from "./profile.js";

export const MAX_FILES = 200;
export const MAX_FILE_BYTES = 1024 * 1024;

/**
 * A checkout's state at `sha`, written into the task's work tree through the task's own git
 * directory. A symbolic link in the repository arrives as a small file holding its target
 * (`core.symlinks=false`): a link to a directory outside would otherwise let the agent write
 * through it onto the host, and git keeps recording it as a link when it reads the tree back.
 */
export async function checkout(paths: TaskPaths, mirror: string, ref = "HEAD"): Promise<string> {
  await gitAsync(["init", "--bare", "--quiet", paths.git], paths.root);
  await gitAsync(["--git-dir", paths.git, "config", "core.symlinks", "false"], paths.root);
  // The plan a task that plans first writes is the agent's working note, never part of its change.
  await mkdir(join(paths.git, "info"), { recursive: true });
  await appendFile(join(paths.git, "info", "exclude"), `/${CLAUDE_PLANS_DIR}/\n`);
  await gitAsync(["--git-dir", paths.git, "fetch", "--quiet", "--no-tags", mirror, ref], paths.root);
  const sha = (await gitAsync(["--git-dir", paths.git, "rev-parse", "FETCH_HEAD"], paths.root)).trim();
  await gitAsync(["--git-dir", paths.git, "--work-tree", paths.work, "read-tree", "--reset", "-u", sha], paths.root);
  return sha;
}

export type Changes = { files: FileChange[] } | { refused: string };

/**
 * What the agent changed, read back through a git directory outside its working tree: the
 * agent never sees that directory, so whatever it wrote into the checkout - a `.git`, a
 * hook, a filter - is not what reads its own result. Content comes from the blobs git
 * stored, never by following a path, so a symbolic link is seen as a link and refused rather
 * than read through to a file elsewhere on the host.
 *
 * Every refusal fails the task closed: a change the orchestrator cannot carry whole and as text,
 * or one that looks like it holds a secret, opens no request at all.
 */
/**
 * What a repository's setup left in the checkout, settled before the agent runs: a file it
 * created (dependencies, a build) is set aside from the change, so it never rides into the
 * agent's request; a file the repository tracks that it changed refuses the task, since a setup
 * prepares a checkout and is no place to edit one. A file the setup created is set aside for
 * good, even if the agent writes to it later.
 */
export async function settleSetup(paths: TaskPaths, baseSha: string): Promise<{ refused: string } | { created: number }> {
  const g = ["--git-dir", paths.git, "--work-tree", paths.work];
  const tracked = (await gitAsync([...g, "diff", "--name-only", "-z", "--no-renames", baseSha], paths.root)).split("\0").filter(Boolean);
  if (tracked.length) {
    return { refused: `The repository's setup changed ${tracked.slice(0, 5).join(", ")}${tracked.length > 5 ? " and more" : ""}, which the repository tracks; a setup prepares a checkout and does not edit it, so the agent did not run.` };
  }
  const created = (await gitAsync([...g, "ls-files", "-z", "--others", "--exclude-standard", "--directory"], paths.root)).split("\0").filter(Boolean);
  if (created.length) {
    await mkdir(join(paths.git, "info"), { recursive: true });
    await appendFile(join(paths.git, "info", "exclude"), created.map((path) => `/${path.replace(/[\\*?[\]!# ]/g, "\\$&")}`).join("\n") + "\n");
  }
  return { created: created.length };
}

export async function collectChanges(paths: TaskPaths, baseSha: string, carriesCredential: (text: string) => boolean): Promise<Changes> {
  const g = ["--git-dir", paths.git, "--work-tree", paths.work];
  // Counted and measured before anything is staged: staging hashes every new file into the
  // task's git directory, so a 1 GB file would be copied, and thousands of files read one by
  // one, before the limits below turned them away. The task's git directory has no branch,
  // so what changed is measured against the base commit; a new file is listed, not read.
  const [tracked, untracked] = await Promise.all([
    gitAsync([...g, "diff", "--name-only", "-z", "--no-renames", baseSha], paths.root),
    gitAsync([...g, "ls-files", "-z", "--others", "--exclude-standard"], paths.root),
  ]);
  const listed = `${tracked}${untracked}`.split("\0").filter(Boolean);
  if (listed.length > MAX_FILES) return { refused: `The agent changed ${listed.length} files, over the limit of ${MAX_FILES} for one request.` };
  for (const path of listed) {
    const found = await lstat(join(paths.work, path)).catch(() => null);
    if (found?.isFile() && found.size > MAX_FILE_BYTES) return { refused: `The agent wrote ${path} at ${found.size} bytes, over the ${MAX_FILE_BYTES}-byte limit for one file.` };
  }
  await gitAsync([...g, "add", "-A"], paths.root);
  const raw = await gitAsync([...g, "diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", baseSha], paths.root);
  return rawChanges(raw, (args) => gitAsync([...g, ...args], paths.root), carriesCredential);
}

/**
 * The files a `diff --raw -z --no-renames --no-abbrev` lists, each read from the blob git stored
 * and held to the same limits: a regular text file under the size limit, with nothing in it
 * that looks like a secret or carries a credential the orchestrator passed to the agent.
 */
export async function rawChanges(raw: string, read: (args: string[]) => Promise<string>, carriesCredential: (text: string) => boolean): Promise<Changes> {
  const fields = raw.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, , mode, , sha, status] = fields[i]!.split(/[: ]/);
    const path = fields[i + 1]!;
    if (status === "D") {
      files.push({ path, content: null });
      continue;
    }
    if (mode === "120000") return { refused: `The agent made ${path} a symbolic link; the orchestrator proposes regular files only.` };
    if (mode !== "100644" && mode !== "100755") return { refused: `The agent left ${path} as something other than a regular file.` };
    const size = Number((await read(["cat-file", "-s", sha!])).trim());
    if (size > MAX_FILE_BYTES) return { refused: `The agent wrote ${path} at ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit for one file.` };
    const content = await read(["cat-file", "blob", sha!]);
    if (content.includes("\0")) return { refused: `The agent wrote ${path} as a binary file; the orchestrator proposes text files only.` };
    const secret = detectSecret(content);
    if (secret) return { refused: `The agent's change to ${path} looks like it holds a secret (${secret}); no request was opened.` };
    if (carriesCredential(content)) return { refused: `The agent's change to ${path} holds a credential the orchestrator passed to it; no request was opened.` };
    files.push({ path, content });
  }
  if (files.length > MAX_FILES) return { refused: `The agent changed ${files.length} files, over the limit of ${MAX_FILES} for one request.` };
  return { files };
}

/** A fence no line of the text can close: one backtick longer than the longest run inside it. */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}text\n${text}\n${ticks}`;
}
