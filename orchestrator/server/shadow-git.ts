import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, rm, rmdir, writeFile, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { OrchestratorContext } from "./app.js";
import { readRequestChanges, readRequestFile } from "./forge/request-diff.js";
import type { FileDiff, RequestChanges } from "./forge/request-diff.js";
import { gitAsync, gitAsyncBytes, gitAsyncMaybe } from "./git.js";
import { detectSecret } from "./plugin.js";
import { CLAUDE_PLANS_DIR } from "./tasks/profile.js";
import { projectFolder } from "./projects.js";
import type { Where } from "./projects.js";
import type { RepoRecord } from "./store.js";
import { Redactor } from "./tasks/redact.js";

/*
 * A shadow git: the record of a folder that is not a git repository, kept in the orchestrator's
 * data so a task's changes there can be shown and undone. Nothing is written into the folder but
 * an undo. Every call checks the folder against the project rule again, so one turned into a link
 * after it was opened is refused, and runs git with no hook, fsmonitor, protocol or global setting.
 */

/** Where one project's shadow lives, the folder it records, and what the folder rule checks it against. */
export interface ShadowPlace {
  gitDir: string;
  folder: string;
  where: Where;
}

export const SHADOW_MAX_FILES = 5_000;
export const SHADOW_MAX_FILE_BYTES = 5 * 1024 * 1024;

// Kept out of every snapshot: what tools rebuild, and nested repositories, which would become gitlinks.
const EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", ".DS_Store", ".git/", ".git", `/${CLAUDE_PLANS_DIR}/`];
// Files named like this hold keys and passwords: their content never reaches the orchestrator's data.
const SECRET_NAME = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_[a-z0-9]+|.*\.p12|\.npmrc|\.netrc)$/i;

/** What a snapshot leaves out because it looks like a secret: its path and the digest of its content, never the content. */
interface Untracked {
  path: string;
  sha256: string;
}

export type ShadowRefusal = { refused: string };

/** The shadow of one project on this orchestrator. */
export function shadowPlaceOf(ctx: OrchestratorContext, project: Pick<RepoRecord, "id" | "url">): ShadowPlace {
  return { gitDir: join(ctx.dataDir, "shadow", ctx.tenant, project.id), folder: project.url, where: { dataDir: ctx.dataDir } };
}

const flags = (p: ShadowPlace) => ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "core.symlinks=false", "--git-dir", p.gitDir, "--work-tree", p.folder];
// Every place git reads objects and the index from is the shadow's own, whatever the process's environment says.
// A path is read as itself, never as a pattern: a file named `*` names that file alone.
const env = (p: ShadowPlace) => ({ GIT_INDEX_FILE: join(p.gitDir, "index"), GIT_OBJECT_DIRECTORY: join(p.gitDir, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_LITERAL_PATHSPECS: "1" });
const git = (p: ShadowPlace, args: string[], input?: string) => gitAsync([...flags(p), ...args], p.gitDir, input, undefined, { env: env(p) });

/** The folder as the rule finds it now, refused when it is not the one the project was opened on. */
async function checked(p: ShadowPlace): Promise<string | ShadowRefusal> {
  const at = await projectFolder(p.folder, p.where);
  if ("refused" in at) return { refused: at.message };
  return at.real === p.folder ? at.real : { refused: "this folder moved or became a link since it was opened; open it again" };
}

async function ready(p: ShadowPlace): Promise<void> {
  await mkdir(p.gitDir, { recursive: true, mode: 0o700 });
  await chmod(p.gitDir, 0o700);
  if (!(await lstat(join(p.gitDir, "HEAD")).catch(() => null))) {
    await gitAsync(["init", "-q", "--bare", p.gitDir], dirname(p.gitDir));
    // Bare so nothing of git lands in the folder; told it has a work tree, the one given with each call.
    await gitAsync(["--git-dir", p.gitDir, "config", "core.bare", "false"], dirname(p.gitDir));
  }
  await mkdir(join(p.gitDir, "info"), { recursive: true });
  await writeFile(join(p.gitDir, "info", "exclude"), `${EXCLUDES.join("\n")}\n`);
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Records the folder as it is now and returns the snapshot's id. Counted and measured before
 * anything is hashed, as a task's own changes are; a folder past the limits is refused, and a
 * task does not start in it. Links are not recorded; a file that looks like a secret is kept as
 * its digest alone.
 */
export async function shadowSnapshot(p: ShadowPlace, label: string): Promise<{ sha: string } | ShadowRefusal> {
  const folder = await checked(p);
  if (typeof folder !== "string") return folder;
  await ready(p);
  const listed = (await git(p, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter((path) => path && !path.endsWith("/"));
  const paths = [...new Set(listed)];
  if (paths.length > SHADOW_MAX_FILES) return { refused: `this folder holds ${paths.length} files, over the ${SHADOW_MAX_FILES} a folder without git is tracked with; make it a git repository, or open a smaller folder` };
  const kept: string[] = [];
  const untracked: Untracked[] = [];
  for (const path of paths) {
    const found = await lstat(join(folder, path)).catch(() => null);
    if (!found?.isFile()) continue;
    if (found.size > SHADOW_MAX_FILE_BYTES) return { refused: `${path} is ${found.size} bytes, over the ${SHADOW_MAX_FILE_BYTES} a file in a folder without git is tracked with` };
    const content = await readFile(join(folder, path));
    if (SECRET_NAME.test(path) || detectSecret(content.toString("utf8"))) untracked.push({ path, sha256: sha256(content) });
    else kept.push(path);
  }
  await git(p, ["read-tree", "--empty"]);
  if (kept.length) await git(p, ["update-index", "--add", "-z", "--stdin"], kept.map((path) => `${path}\0`).join(""));
  const tree = (await git(p, ["write-tree"])).trim();
  const parent = (await gitAsyncMaybe([...flags(p), "rev-parse", "--verify", "--quiet", "refs/heads/snapshots"], p.gitDir))?.trim();
  const message = `${label.replace(/[\r\n]+/g, " ").slice(0, 200)}\n\n${JSON.stringify({ untracked })}\n`;
  const sha = (await git(p, ["-c", "user.name=TeamHandbook Orchestrator", "-c", "user.email=orchestrator@teamhandbook.invalid", "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], message)).trim();
  await git(p, ["update-ref", "refs/heads/snapshots", sha]);
  return { sha };
}

async function untrackedOf(p: ShadowPlace, sha: string): Promise<Map<string, string>> {
  const body = (await gitAsyncMaybe([...flags(p), "log", "-1", "--format=%b", sha], p.gitDir)) ?? "";
  const line = body.split("\n").find((l) => l.startsWith("{"));
  const listed = line ? ((JSON.parse(line) as { untracked?: Untracked[] }).untracked ?? []) : [];
  return new Map(listed.map((u) => [u.path, u.sha256]));
}

/** What a task changed between two snapshots, in the shape a request's changes are shown in; files kept as digests alone are listed apart, with no content and no undo. */
export async function shadowChanges(p: ShadowPlace, before: string, after: string): Promise<(RequestChanges & { untracked: { path: string; status: "added" | "modified" | "deleted" }[] }) | string> {
  const folder = await checked(p);
  if (typeof folder !== "string") return folder.refused;
  const changes = await readRequestChanges(p.gitDir, before, [after]);
  if (typeof changes === "string") return changes;
  const [was, now] = [await untrackedOf(p, before), await untrackedOf(p, after)];
  const untracked = [...new Set([...was.keys(), ...now.keys()])].sort().flatMap((path) => {
    const status = !was.has(path) ? "added" : !now.has(path) ? "deleted" : was.get(path) !== now.get(path) ? "modified" : null;
    return status ? [{ path, status: status as "added" | "modified" | "deleted" }] : [];
  });
  return { ...changes, untracked };
}

/** One changed file's patch, masked line by line, and withheld whole when it still looks like a secret. */
export async function shadowFile(p: ShadowPlace, before: string, after: string, path: string): Promise<FileDiff | null | string> {
  const folder = await checked(p);
  if (typeof folder !== "string") return folder.refused;
  const file = await readRequestFile(p.gitDir, before, [after], path);
  if (!file || typeof file === "string" || file.patch === null) return file;
  const redactor = new Redactor();
  const masked = file.patch.split("\n").map((line) => redactor.line(line)).join("\n");
  return detectSecret(masked) ? { ...file, patch: null, note: "its change looks like it holds a secret; it is not shown" } : { ...file, patch: masked };
}

/** A path from git, refused unless it stays inside the folder and every folder on its way is a real folder, not a link. */
async function safeTarget(folder: string, path: string): Promise<string | null> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  const target = join(folder, path);
  const rel = relative(folder, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  let at = folder;
  for (const part of rel.split(sep).slice(0, -1)) {
    at = join(at, part);
    const found = await lstat(at).catch(() => null);
    if (found && !found.isDirectory()) return null;
  }
  const self = await lstat(target).catch(() => null);
  return self?.isSymbolicLink() ? null : target;
}

/**
 * Puts the files a task changed back as they were before it, only those still as the task left
 * them: a file the person changed since is kept and listed, never written over. A link, or a path
 * that leads out of the folder, is not touched.
 */
export async function shadowUndo(p: ShadowPlace, before: string, after: string, only?: ReadonlySet<string>): Promise<{ undone: string[]; kept: string[] } | ShadowRefusal> {
  const folder = await checked(p);
  if (typeof folder !== "string") return folder;
  // Each path on its own, a rename as the deletion and the addition it is, so undoing one puts the
  // old file back as well as taking the new one away.
  const listed = await gitAsyncMaybe([...flags(p), "diff", "--name-only", "--no-renames", "-z", before, after], p.gitDir);
  if (listed === null) return { refused: "these snapshots are not this project's" };
  // A regular file's entry alone: a folder or a submodule line is never written back as a file.
  const entry = async (sha: string, path: string) => {
    const line = (await gitAsyncMaybe([...flags(p), "ls-tree", "-z", sha, "--", path], p.gitDir, { env: env(p) }))?.split("\0")[0] ?? "";
    const [mode, , blob] = line.split(/[ \t]/);
    return blob && (mode === "100644" || mode === "100755") ? { mode, blob } : null;
  };
  // The folders that held something before the task, which an undo leaves even when they end up empty.
  const held = new Set((await gitAsync([...flags(p), "ls-tree", "-r", "-z", "--name-only", before], p.gitDir, undefined, undefined, { env: env(p) })).split("\0").filter(Boolean).flatMap((path) => path.split("/").slice(0, -1).map((_, n, parts) => parts.slice(0, n + 1).join("/"))));
  const undone: string[] = [];
  const kept: string[] = [];
  // `only`: the files the person picked; every other path of the change stays as the agent left it.
  for (const path of listed.split("\0").filter(Boolean).filter((path) => !only || only.has(path)).sort()) {
    const target = await safeTarget(folder, path);
    const left = await entry(after, path);
    const now = await lstat(target ?? join(folder, path)).catch(() => null);
    const nowSha = target && now?.isFile() ? (await gitAsync([...flags(p), "hash-object", "--", target], p.gitDir, undefined, undefined, { env: env(p) })).trim() : null;
    // Still as the task left it: the same content, or still gone when the task deleted it.
    if (!target || (left === null ? now !== null : nowSha !== left.blob)) {
      kept.push(path);
      continue;
    }
    const was = await entry(before, path);
    if (was === null) {
      await rm(target, { force: true });
      // A folder the task made for the file goes with it once nothing is left in it.
      for (let dir = dirname(path); dir !== "." && !held.has(dir); dir = dirname(dir)) {
        if (!(await rmdir(join(folder, dir)).then(() => true, () => false))) break;
      }
    } else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await gitAsyncBytes([...flags(p), "cat-file", "blob", was.blob], p.gitDir, undefined, { env: env(p) }));
      await chmod(target, was.mode === "100755" ? 0o755 : 0o644);
    }
    undone.push(path);
  }
  return { undone, kept };
}

/** Deletes a project's shadow, when the project is removed. */
export async function removeShadow(p: ShadowPlace): Promise<void> {
  await rm(p.gitDir, { recursive: true, force: true });
}
