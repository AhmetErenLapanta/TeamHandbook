import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { encoded } from "../work-folders.js";
import { fence } from "./changes.js";
import { Redactor } from "./redact.js";
import { printable } from "./runner.js";

/** A folder a task can work in, as the person's own Claude Code use and CLAUDE.md files name it; `about` is the file's first heading. */
export interface FolderCandidate {
  path: string;
  name: string;
  about: string | null;
  usedAt: string | null;
  /** How many Claude Code sessions the person ran there: where a task goes when nothing in it points elsewhere. */
  sessions?: number;
}

/** What Claude Code loads of a folder's own when a session starts there: the context a task in another folder goes without. */
export interface FolderLoaded {
  skills: number;
  claudeMd: boolean;
  memory: boolean;
}

/** Where a task was sent and why: the model's short reason, or none when its starter named the folder; `fallback` marks the folder the person uses most, taken when nothing pointed to one. */
export interface Routing {
  path: string;
  reason: string;
  fallback: boolean;
  loaded?: FolderLoaded;
}

const REASON_MAX = 120;

/**
 * The one read-only question that picks a task's folder: the task's words and each candidate's name and first heading,
 * every one of them quoted as data, since a folder's heading and an issue are written by others.
 */
export function routingPrompt(words: string, candidates: readonly FolderCandidate[]): string {
  const listed = candidates.map((c, at) => `${at + 1}. ${c.name}${c.about ? ` - ${c.about}` : ""}`).join("\n");
  return [
    "Pick the one folder this task belongs in. Answer with its number, a colon and at most ten words on why, on one line, and nothing else.",
    "",
    "The task, quoted as data:",
    fence(words),
    "",
    "The folders, by name and the first heading of their CLAUDE.md, quoted as data:",
    fence(listed),
  ].join("\n");
}

/**
 * The folder the model's answer names, or null when it names none of the candidates: the folder used last was once taken
 * then, and a fresh install's last folder was the orchestrator's own checkout, so the person is asked instead.
 */
export function routed(answer: string | null, candidates: readonly FolderCandidate[]): Routing | null {
  const picked = /^\s*(\d{1,3})\s*[:.)-]\s*(.*)$/m.exec(answer ?? "");
  const at = picked ? Number(picked[1]) - 1 : -1;
  if (at < 0 || at >= candidates.length) return null;
  const reason = new Redactor([]).line(printable(picked![2]!.trim())).slice(0, REASON_MAX);
  return { path: candidates[at]!.path, reason, fallback: false };
}

/**
 * The folder the person ran the most Claude Code sessions in, for a task nothing in it points to: its skills, CLAUDE.md
 * and memory are the ones they built their work on. None when no session is known, and the person is asked.
 */
export function mostUsed(candidates: readonly FolderCandidate[]): Routing | null {
  const most = candidates.reduce<FolderCandidate | null>((best, c) => ((c.sessions ?? 0) > (best?.sessions ?? 0) ? c : best), null);
  return most ? { path: most.path, reason: "", fallback: true } : null;
}

/** Claude Code's own folder, where it keeps each project's memory. */
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Counts what a session in the folder loads of the folder's own, by the files' presence alone: none is read. */
export async function folderLoaded(folder: string, claudeDir: string = claudeHome()): Promise<FolderLoaded> {
  const there = (path: string) => stat(path).then((s) => s.isFile(), () => false);
  const skills = await readdir(join(folder, ".claude", "skills")).catch(() => [] as string[]);
  const found = await Promise.all(skills.map((name) => there(join(folder, ".claude", "skills", name, "SKILL.md"))));
  return {
    skills: found.filter(Boolean).length,
    claudeMd: (await there(join(folder, "CLAUDE.md"))) || (await there(join(folder, ".claude", "CLAUDE.md"))),
    memory: await there(join(claudeDir, "projects", encoded(folder), "memory", "MEMORY.md")),
  };
}

/** The task's second line: what the person's own context in the folder gives the agent, or that it gives none. */
export function loadedLine(path: string, loaded: FolderLoaded): string {
  const parts = [loaded.skills ? `${loaded.skills} skill${loaded.skills === 1 ? "" : "s"}` : "", loaded.claudeMd ? "CLAUDE.md" : "", loaded.memory ? "memory" : ""].filter(Boolean);
  return parts.length ? `Loaded: ${parts.join(", ")} from ${path}.` : `Nothing of ${path}'s own is loaded: it has no CLAUDE.md, skills or memory.`;
}

/** The first line of the task's log: where it works and why. */
export const routingLine = (routing: Routing): string =>
  routing.fallback ? `Working in ${routing.path}, the folder you use most.` : routing.reason ? `Working in ${routing.path} (matches '${routing.reason}').` : `Working in ${routing.path}, the folder its starter picked.`;
