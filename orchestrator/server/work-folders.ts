import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectSecret } from "./plugin.js";
import { ASKS_FIRST, ROOTS, SKIPPED, homeReal, projectFolder } from "./projects.js";
import type { Where } from "./projects.js";

/** A folder a task can be routed to, from what the person already works in; nobody picks one. */
export interface WorkFolder {
  /** The folder's real path. */
  path: string;
  name: string;
  /** When the person last worked there, as Claude Code's own files or the CLAUDE.md say. */
  usedAt: string;
  /** How many sessions Claude Code kept there, counted from file names alone: the folder it is used in most is the usual one. */
  sessions: number;
  /** The CLAUDE.md's first heading: the folder's own words, untrusted, so a prompt fences it as data. */
  about: string | null;
  from: "claude-code" | "claude-md" | "added";
}

export interface PoolWhere extends Where {
  /** Claude Code's own folder, CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeDir?: string;
  /** The orchestrator's own code, which is never a folder a task of the person's goes to. */
  ownCode?: string;
  /** The folders the person opened as projects, Add a folder in Settings among them: theirs by that act. */
  opened?: readonly string[];
}

const POOL = 20;
const ABOUT_MAX = 120;
const HEAD_BYTES = 4096;
const WALK_DEPTH = 2;
const WALK_ENTRIES = 3_000;
const WALK_MS = 1_000;
// Where cli-main.ts and update-routes.ts find the package, the same in a checkout and in a release.
const OWN_CODE = dirname(dirname(fileURLToPath(import.meta.url)));
// An SDK's samples, a toolchain's cache, an archive and the factory's worktrees hold repositories and CLAUDE.md files nobody works in.
const NOT_WORK = /sdk|archive|backup|worktrees/i;
const TOOLCHAINS = new Set(["go", "flutter", "android", "anaconda3", "miniconda3"]);

// Claude Code names a project's folder after its path, every character but a letter or a digit turned into "-".
export const encoded = (name: string) => name.replace(/[^a-zA-Z0-9]/g, "-");

const within = (outer: string, inner: string) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const mtimeOf = (path: string) => stat(path).then((s) => s.mtime, () => null);

/**
 * The folder a Claude Code project's name stands for, found by walking the disk from the home
 * folder: the name loses which "-" was a "/", so each step takes a child whose encoded name the
 * rest starts with, the longest first, and backs out of one that leads nowhere.
 */
async function decode(rest: string, at: string): Promise<string | null> {
  const children = (await readdir(at, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && rest.startsWith(encoded(d.name)))
    .sort((a, b) => b.name.length - a.name.length);
  for (const child of children) {
    const own = encoded(child.name);
    if (rest === own) return join(at, child.name);
    if (rest[own.length] !== "-") continue;
    const found = await decode(rest.slice(own.length + 1), join(at, child.name));
    if (found) return found;
  }
  return null;
}

/** Each Claude Code project under the home folder, by its folder's name alone, and when it was last used: no file in it is opened. */
async function claudeCodeFolders(projects: string, home: string): Promise<{ path: string; usedAt: Date; sessions: number }[]> {
  const prefix = `${encoded(home)}-`;
  const names = (await readdir(projects, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory() && d.name.startsWith(prefix));
  const used: { name: string; usedAt: Date; sessions: number }[] = [];
  for (const d of names) {
    const dir = join(projects, d.name);
    // A session appends to its file, which leaves the folder's own time where it was: the newest file says when.
    const files = await readdir(dir).catch(() => [] as string[]);
    const times = await Promise.all(files.map((f) => mtimeOf(join(dir, f))));
    const newest = [await mtimeOf(dir), ...times].reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
    if (newest) used.push({ name: d.name, usedAt: newest, sessions: files.filter((f) => f.endsWith(".jsonl")).length });
  }
  used.sort((a, b) => b.usedAt.getTime() - a.usedAt.getTime());
  // The folder used most is never cut, however long ago it was last used: tasks go there when nothing says otherwise.
  const usual = used.reduce<(typeof used)[number] | null>((best, u) => (!best || u.sessions > best.sessions ? u : best), null);
  const found: { path: string; usedAt: Date; sessions: number }[] = [];
  for (const u of used) {
    if (found.length >= POOL * 2 && u !== usual) continue;
    const path = await decode(u.name.slice(prefix.length), home);
    if (path) found.push({ path, usedAt: u.usedAt, sessions: u.sessions });
  }
  return found;
}

/** The folders carrying a CLAUDE.md in the places code is usually kept, a bounded walk that never enters a folder macOS asks a permission for. */
async function claudeMdFolders(home: string): Promise<{ path: string; usedAt: Date }[]> {
  const started = Date.now();
  let visited = 0;
  const found: { path: string; usedAt: Date }[] = [];
  const queue = ROOTS.map((root) => ({ path: root ? join(home, root) : home, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length && visited < WALK_ENTRIES && Date.now() - started < WALK_MS) {
    const { path, depth } = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const names = await readdir(path, { withFileTypes: true }).catch(() => []);
    visited += names.length;
    for (const d of names) {
      if (!d.isDirectory() || d.name.startsWith(".") || SKIPPED.has(d.name.toLowerCase())) continue;
      if (path === home && ASKS_FIRST.has(d.name.toLowerCase())) continue;
      const child = join(path, d.name);
      const at = await mtimeOf(join(child, "CLAUDE.md"));
      if (at) found.push({ path: child, usedAt: at });
      if (depth + 1 < WALK_DEPTH) queue.push({ path: child, depth: depth + 1 });
    }
  }
  return found;
}

/** The CLAUDE.md's first heading, from its first few kilobytes, or null when it has none or it looks like it holds a secret. */
async function aboutOf(folder: string): Promise<string | null> {
  const file = await open(join(folder, "CLAUDE.md"), "r").catch(() => null);
  if (!file) return null;
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await file.read(head, 0, HEAD_BYTES, 0);
    const line = head.subarray(0, bytesRead).toString("utf8").split("\n").find((l) => /^#{1,6}\s+\S/.test(l));
    const text = line?.replace(/^#+\s+/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (!text || detectSecret(text)) return null;
    return text.length > ABOUT_MAX ? `${text.slice(0, ABOUT_MAX - 1)}…` : text;
  } finally {
    await file.close();
  }
}

/**
 * The git folder every worktree of a repository shares, found by walking up from a folder to its `.git` and reading the
 * pointer files alone: two folders with the same answer are one repository's checkouts, the factory's worktrees of the
 * orchestrator among them. Null where no git folder is above it.
 */
async function commonGitDir(start: string): Promise<string | null> {
  for (let at = start; ; at = dirname(at)) {
    const dotGit = join(at, ".git");
    const found = await lstat(dotGit).catch(() => null);
    if (found?.isDirectory()) return realpath(dotGit).catch(() => null);
    if (found?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, "utf8").catch(() => ""))?.[1]?.trim();
      if (!pointer) return null;
      const own = resolve(at, pointer);
      const common = (await readFile(join(own, "commondir"), "utf8").catch(() => "")).trim();
      return realpath(common ? resolve(own, common) : own).catch(() => null);
    }
    if (dirname(at) === at) return null;
  }
}

/** Whether a folder is one the person's work goes to: by the folder rule, and none of an SDK, an archive, the factory's worktrees or the orchestrator's own code. */
async function isWork(path: string, where: Required<Where>, ownReal: string, ownGit: string | null): Promise<string | null> {
  const checked = await projectFolder(path, where);
  if ("refused" in checked) return null;
  const parts = relative(await homeReal(where.home), checked.real).split(sep);
  if (parts.some((p) => NOT_WORK.test(p) || TOOLCHAINS.has(p.toLowerCase()))) return null;
  // The orchestrator's own code and every checkout of its repository; a folder holding such a checkout among others stays.
  if (within(ownReal, checked.real)) return null;
  if (ownGit && (await commonGitDir(checked.real)) === ownGit) return null;
  return checked.real;
}

/**
 * The folders a task is routed among, the most recently used first: the projects the person's
 * Claude Code has worked in, read by their names alone, and the folders carrying a CLAUDE.md.
 */
export async function workFolders({ home = homedir(), dataDir, claudeDir, ownCode = OWN_CODE, opened = [] }: PoolWhere): Promise<WorkFolder[]> {
  const where = { home, dataDir };
  const homeAt = await homeReal(home);
  const ownReal = await homeReal(ownCode);
  const ownGit = await commonGitDir(ownReal);
  const projects = join(claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")), "projects");
  const sources = [
    ...(await Promise.all(opened.map(async (path) => ({ path, usedAt: (await mtimeOf(path)) ?? new Date(0), from: "added" as const })))),
    ...(await claudeCodeFolders(projects, homeAt)).map((f) => ({ ...f, from: "claude-code" as const })),
    ...(await claudeMdFolders(homeAt)).map((f) => ({ ...f, from: "claude-md" as const })),
  ];
  // A folder the person added is never cut by the cap: adding it is the one act that says it is theirs. Nor is the one used most.
  const found = new Map<string, { usedAt: Date; from: WorkFolder["from"]; sessions: number }>();
  for (const source of sources) {
    const real = await isWork(source.path, where, ownReal, ownGit);
    if (!real) continue;
    const sessions = "sessions" in source ? source.sessions : 0;
    const known = found.get(real);
    if (known) known.sessions += sessions;
    else found.set(real, { usedAt: source.usedAt, from: source.from, sessions });
  }
  const byTime = [...found].sort(([, a], [, b]) => b.usedAt.getTime() - a.usedAt.getTime());
  const usual = byTime.reduce<(typeof byTime)[number] | null>((best, row) => (!best || row[1].sessions > best[1].sessions ? row : best), null);
  const used = [...byTime.slice(0, POOL), ...byTime.slice(POOL).filter((row) => row[1].from === "added" || (row === usual && row[1].sessions > 0))];
  return Promise.all(used.map(async ([path, { usedAt, from, sessions }]) => ({ path, name: basename(path), usedAt: usedAt.toISOString(), sessions, about: await aboutOf(path), from })));
}
