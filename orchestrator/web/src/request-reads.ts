import { ApiError, call } from "./api";
import type { RequestStatusRead } from "../../shared/forge-read";

/** One file a request changes, without its patch: the list is read first and each patch when its file opens. */
export interface ChangedFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; previousPath: string | null; additions: number | null; deletions: number | null; binary: boolean; test: boolean }
/** `untracked`: files a task changed that the orchestrator keeps no copy of, such as one that looks like it holds a secret. */
export interface RequestChanges { files: ChangedFile[]; omitted: number; untracked?: { path: string; status: string }[] }
/** `note` says in words why no patch, or only part of one, is shown. */
export interface FilePatch { patch: string | null; truncated: boolean; note: string | null }

/** A path's slashes stay, each segment encoded on its own. */
const pathPart = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export interface ChangeReads { changes: () => Promise<RequestChanges>; file: (path: string) => Promise<FilePatch> }

/** The file list and each file's patch under one route, the shape a request's and a task's changes share. */
function changeReads(base: string): ChangeReads {
  return {
    changes: () => call<{ changes: RequestChanges }>("GET", base).then((r) => r.changes),
    file: (path: string) => call<{ file: FilePatch }>("GET", `${base}/${pathPart(path)}`).then((r) => r.file),
  };
}

/** The reads behind a request's changes. The one place their routes are named. */
export function requestReads(repoId: string, number: number): ChangeReads {
  return changeReads(`/api/repos/${encodeURIComponent(repoId)}/requests/${number}/changes`);
}

/** What a task changed in a folder without Git, kept by the orchestrator's own copy of it. */
export function taskChangeReads(taskId: string): ChangeReads {
  return changeReads(`/api/tasks/${encodeURIComponent(taskId)}/changes`);
}

/**
 * A task's changes read where they are: in a folder of its person's machine the orchestrator holds
 * only the paths the machine reported, so the list is drawn from those and each file says where its
 * patch is, rather than the section staying empty on the refusal.
 */
export function machineChangeReads(reads: ChangeReads, files: ChangedFile[], onAway: () => void): ChangeReads {
  let away = false;
  return {
    changes: () => reads.changes().catch((e: unknown) => {
      if (!(e instanceof ApiError && e.code === "changes-on-machine")) throw e;
      away = true;
      onAway();
      return { files, omitted: 0 };
    }),
    file: (path) => (away ? Promise.resolve({ patch: null, truncated: false, note: "its patch stays on the computer the task ran on; open the folder there to read it" }) : reads.file(path)),
  };
}

/** Where an open request stands: from its forge, or for one on this machine's own copy, from the repository. */
export function requestStatus(repoId: string, number: number): Promise<RequestStatusRead> {
  return call<{ status: RequestStatusRead }>("GET", `/api/repos/${encodeURIComponent(repoId)}/requests/${number}/status`).then((r) => r.status);
}
