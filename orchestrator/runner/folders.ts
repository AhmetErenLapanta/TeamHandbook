import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { listFolders, projectFolder } from "../server/projects.js";
import { shadowUndo } from "../server/shadow-git.js";
import type { ShadowPlace } from "../server/shadow-git.js";
import type { FolderEntry, FolderList, FolderRefusal } from "../shared/projects.js";
import { folderReader } from "../server/tasks/verify.js";
import { detectVerification } from "../server/tasks/verify-detect.js";
import type { ChecksAnswer, ChecksAsk, UndoAnswer, UndoAsk } from "./link.js";

/** Where the machine looks: the person's home, the runner's data it never lists or works in, and where its shadows of folders are kept. */
export interface MachineWhere {
  home: string;
  dataDir: string;
  shadows: string;
}

/**
 * The folders on this machine its person picks a project from, as the orchestrator's screen asks
 * for them. The folder asked for is only a hint: it is read against this machine's own home and
 * data, under the same rule a local orchestrator's picker and a task's start hold it to, so the
 * orchestrator cannot have the machine list a folder that rule refuses. Every path leaves as `~`
 * and what follows it, so the machine's home and its account name stay here.
 */
export async function machineFolders(under: string | null, q: string | null, { home, dataDir }: { home: string; dataDir: string }): Promise<FolderList | { refused: FolderRefusal; message: string }> {
  const homeReal = await realpath(home).catch(() => home);
  const asked = under === null ? undefined : under === "~" ? homeReal : under.startsWith("~/") ? join(homeReal, under.slice(2)) : under;
  const listed = await listFolders(asked, q ?? undefined, { home, dataDir });
  if ("refused" in listed) return listed;
  const tilde = (path: string) => (path === homeReal ? "~" : path.startsWith(homeReal + sep) ? `~/${path.slice(homeReal.length + 1)}` : path);
  const entry = (folder: FolderEntry): FolderEntry => ({ ...folder, path: tilde(folder.path) });
  return {
    ...listed,
    under: tilde(listed.under),
    parent: listed.parent === null ? null : tilde(listed.parent),
    folders: listed.folders.map(entry),
    suggestions: listed.suggestions.map(entry),
    ...(listed.matches ? { matches: listed.matches.map(entry) } : {}),
  };
}

/**
 * A project's folder on this machine, named from its home, as this machine's own folder rule finds
 * it now, with the shadow that records it: refused when the project id is not one, the path is not
 * from the home, the rule refuses the folder, or it moved or became a link since it was opened.
 */
export async function folderPlace(path: string, projectId: string, { home, dataDir, shadows }: MachineWhere): Promise<ShadowPlace | { refused: string }> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) return { refused: "the orchestrator named the folder's project in a way this machine does not take" };
  const homeReal = await realpath(home).catch(() => home);
  const asked = path === "~" ? homeReal : path.startsWith("~/") ? join(homeReal, path.slice(2)) : null;
  if (!asked) return { refused: "the folder is not named from this machine's home" };
  const at = await projectFolder(asked, { home, dataDir });
  if ("refused" in at) return { refused: at.message };
  if (at.real !== asked) return { refused: "the folder moved or became a link since it was opened; open it again" };
  return { gitDir: join(shadows, projectId), folder: at.real, where: { home, dataDir } };
}

/** A task's change in a folder of this machine put back, as its person asked on the orchestrator's screen: only files still as the task left them. */
export async function undoInFolder(ask: UndoAsk, where: MachineWhere, working: ReadonlySet<string> = new Set()): Promise<UndoAnswer> {
  // Snapshot ids reach git as words of its command line: anything but an object id could be read as an option.
  if (![ask.before, ask.after].every((sha) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha))) return { refused: "the orchestrator named snapshots this machine does not take" };
  const place = await folderPlace(ask.path, ask.projectId, where);
  if ("refused" in place) return place;
  // The orchestrator's own undo waits for the folder's lock; here the task's agent may be writing the same files.
  if (working.has(place.folder)) return { refused: "a task is working in this folder now; undo once it ends" };
  return shadowUndo(place, ask.before, ask.after);
}

/** A folder project's checks as its files name them, read under this machine's own folder rule; nothing is run to find them. */
export async function checksInFolder(ask: ChecksAsk, where: MachineWhere): Promise<ChecksAnswer> {
  const place = await folderPlace(ask.path, ask.projectId, where);
  if ("refused" in place) return place;
  return { detected: await detectVerification(folderReader(place.folder)) };
}
