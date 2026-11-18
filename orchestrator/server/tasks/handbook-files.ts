import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { detectSecret } from "../plugin.js";
import { skillProblem } from "../skill-rules.js";

/** A skill or a command of the person's own, in their Claude Code folder or a project folder they opened: the only files the orchestrator writes for them. */
export type FileKind = "skill" | "command";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9:-]{0,63}$/;
export const FILE_MAX = 64 * 1024;

export type FileRefusal = "bad-name" | "too-large" | "looks-secret" | "bad-format" | "changed" | "exists" | "missing" | "outside";

const within = (outer: string, inner: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

/** Where a name's file is under a source's own Claude folder, or null for a name that is not one: a command's colons are its folders. */
export function filePath(root: string, kind: FileKind, name: string): string | null {
  if (kind === "skill") return SKILL_NAME.test(name) ? join(root, "skills", name, "SKILL.md") : null;
  if (!COMMAND_NAME.test(name) || name.includes("::") || name.endsWith(":")) return null;
  return join(root, "commands", `${name.split(":").join("/")}.md`);
}

/** The file's text and digest, or null when there is none; a file that is a link, or leads out of the root, is refused. */
export async function readOwnFile(root: string, kind: FileKind, name: string): Promise<{ content: string; digest: string } | null | { refused: FileRefusal }> {
  const path = filePath(root, kind, name);
  if (!path) return { refused: "bad-name" };
  const found = await lstat(path).catch(() => null);
  if (!found) return null;
  if (!found.isFile()) return { refused: "outside" };
  const realRoot = await realpath(root).catch(() => root);
  if (!within(realRoot, await realpath(path))) return { refused: "outside" };
  // Read through one handle and at most a byte past the limit, so a file that grew large fills no memory.
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(FILE_MAX + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > FILE_MAX) return { refused: "too-large" };
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { content, digest: digestOf(content) };
  } finally {
    await handle.close();
  }
}

/**
 * The file's text for the editor, or why it is not given: one that already looks like it holds a
 * key or a token is changed in the terminal, so the page never shows it.
 */
export async function readForEditing(root: string, kind: FileKind, name: string): Promise<{ content: string; digest: string } | null | { refused: FileRefusal }> {
  const found = await readOwnFile(root, kind, name);
  return found && "content" in found && detectSecret(found.content) ? { refused: "looks-secret" } : found;
}

/**
 * Writes a skill or command the person confirmed, only if the file is still what they saw:
 * `expected` is the digest they read, or null for a new one, which must not exist yet. Text that
 * looks like it holds a secret is refused, so a key never lands in a file Claude Code loads.
 */
export async function writeOwnFile(root: string, kind: FileKind, name: string, content: string, expected: string | null): Promise<{ digest: string } | { refused: FileRefusal; detail?: string }> {
  const path = filePath(root, kind, name);
  if (!path) return { refused: "bad-name" };
  if (Buffer.byteLength(content) > FILE_MAX) return { refused: "too-large" };
  if (detectSecret(content)) return { refused: "looks-secret" };
  const now = await readOwnFile(root, kind, name);
  if (now && "refused" in now) return now;
  if (expected === null && now) return { refused: "exists" };
  if (expected !== null && (!now || now.digest !== expected)) return { refused: now ? "changed" : "missing" };
  // The nearest folder that is there already must be inside the root before any folder is made: a skills/ that is a link out makes none outside.
  const realRoot = await realpath(root);
  let existing = dirname(path);
  while (!(await lstat(existing).then(() => true, () => false))) existing = dirname(existing);
  if (!within(realRoot, await realpath(existing))) return { refused: "outside" };
  // A skill is saved under the plugin's own rule for one, its frontmatter naming it as its folder does.
  const problem = kind === "skill" ? skillProblem(name, content) : null;
  if (problem) return { refused: "bad-format", detail: problem };
  await mkdir(dirname(path), { recursive: true });
  if (!within(realRoot, await realpath(dirname(path)))) return { refused: "outside" };
  // Written beside it under a name nobody else has, then put in its place at once, so Claude Code never reads half a file.
  const next = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(next, content, { encoding: "utf8", flag: "wx" });
  await rename(next, path).catch(async (err) => {
    await rm(next, { force: true });
    throw err;
  });
  return { digest: digestOf(content) };
}

/** Deletes a skill's folder or a command's file the person confirmed, only if it is still what they saw. */
export async function deleteOwnFile(root: string, kind: FileKind, name: string, expected: string): Promise<{ deleted: true } | { refused: FileRefusal }> {
  const now = await readOwnFile(root, kind, name);
  if (!now) return { refused: "missing" };
  if ("refused" in now) return now;
  if (now.digest !== expected) return { refused: "changed" };
  const path = filePath(root, kind, name)!;
  await rm(kind === "skill" ? dirname(path) : path, { recursive: kind === "skill", force: false });
  return { deleted: true };
}
