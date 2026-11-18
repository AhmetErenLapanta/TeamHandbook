import { useId, useRef, useState } from "react";
import { ATTACHMENT_ACCEPT, fileProblem, filesOf } from "./attachments";
import type { ChosenFile } from "./attachments";

let counter = 0;

/** The files a box is given, taken from a drop, a paste or the picker: each a chip with its size and a way to take it out. */
export function addFiles(held: ChosenFile[], found: File[]): { files: ChosenFile[]; problems: string[] } {
  const files = [...held];
  const problems: string[] = [];
  for (const file of found) {
    const problem = fileProblem(file, files.length);
    if (problem) problems.push(problem);
    else files.push({ key: `file-${++counter}`, file, state: "waiting" });
  }
  return { files, problems };
}

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * The files for a task, as chips under the box they belong to. Dropping or pasting into the box
 * works as the link does; a refused file is said at once in one line, and a failed upload offers a retry.
 */
export function FileChips({ files, onChange, onRetry, disabled = false }: { files: ChosenFile[]; onChange: (next: ChosenFile[]) => void; onRetry?: (key: string) => void; disabled?: boolean }) {
  const [problems, setProblems] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const take = (found: File[]) => {
    if (!found.length) return;
    const next = addFiles(files, found);
    setProblems(next.problems);
    onChange(next.files);
  };
  return (
    <div className={`file-chips${over ? " dropping" : ""}`} data-file-drop="" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); take(filesOf(e.dataTransfer)); } }} onPaste={(e) => { const found = filesOf(e.clipboardData); if (found.length) { e.preventDefault(); take(found); } }}>
      <input ref={input} id={id} type="file" multiple accept={ATTACHMENT_ACCEPT} className="visually-hidden" tabIndex={-1} aria-label="Choose files" onChange={(e) => { take([...(e.target.files ?? [])]); e.target.value = ""; }} />
      {files.length ? (
        <ul className="plain chips" aria-label="Files">
          {files.map((f) => (
            <li key={f.key} className={`chip-pick on${f.state === "failed" ? " failed" : ""}`}>
              <span className="mono" dir="auto">{f.file.name}</span> <span className="muted small">{size(f.file.size)}{f.state === "sending" ? ", Sending…" : ""}</span>
              {f.state === "failed" ? <> <span className="error small">Not sent</span>{onRetry ? <> <button type="button" className="link small" onClick={() => onRetry(f.key)}>Try again</button></> : null}</> : null}
              {f.state === "sending" || f.state === "sent" ? null : <button type="button" className="ghost small" disabled={disabled} aria-label={`Remove ${f.file.name}`} onClick={() => onChange(files.filter((x) => x.key !== f.key))}>×</button>}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted small">
        <button type="button" className="link" disabled={disabled} onClick={() => input.current?.click()}>Attach files</button>
      </p>
      {over ? <p className="muted small">Drop to attach</p> : null}
      {problems.map((p) => <p key={p} className="error small" role="alert">{p}</p>)}
    </div>
  );
}

/**
 * Sends the files that are not sent yet, one after another, each chip saying where it stands; the
 * ids of all of them come back, or the first failure is thrown with its chip marked and the rest left waiting.
 */
export async function uploadChosen(files: ChosenFile[], upload: (file: File) => Promise<{ id: string }>, set: (next: ChosenFile[]) => void): Promise<string[]> {
  let now = files;
  const mark = (key: string, patch: Partial<ChosenFile>) => {
    now = now.map((f) => (f.key === key ? { ...f, ...patch } : f));
    set(now);
  };
  const ids: string[] = [];
  for (const f of files) {
    if (f.state === "sent" && f.id) {
      ids.push(f.id);
      continue;
    }
    mark(f.key, { state: "sending" });
    try {
      const sent = await upload(f.file);
      mark(f.key, { state: "sent", id: sent.id });
      ids.push(sent.id);
    } catch (err) {
      mark(f.key, { state: "failed", error: (err as Error).message });
      throw err;
    }
  }
  return ids;
}
