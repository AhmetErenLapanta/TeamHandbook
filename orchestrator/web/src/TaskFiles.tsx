import { useEffect, useState } from "react";
import { attachmentsApi } from "./api";
import type { TaskAttachment } from "./api";

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * What a task was given, in the rail after what was asked: each file by name as a link that
 * opens it, with its size. A task given none draws no heading; a read that fails draws nothing.
 */
export function TaskFiles({ id, reads }: { id: string; reads: number }) {
  const [files, setFiles] = useState<TaskAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    attachmentsApi.list(id).then((found) => current && setFiles(found), () => current && setFiles([]));
    return () => {
      current = false;
    };
  }, [id, reads]);
  if (!files.length) return null;
  const open = (file: TaskAttachment) => {
    setProblem(null);
    attachmentsApi.url(id, file.id).then((url) => window.open(url, "_blank", "noopener"), (e: Error) => setProblem(e.message));
  };
  return (
    <section aria-labelledby="task-files-h">
      <h2 id="task-files-h">Files</h2>
      <ul className="plain">
        {files.map((f) => (
          <li key={f.id}>
            <button type="button" className="link mono" dir="auto" onClick={() => open(f)}>{f.name}</button> <span className="muted small">{size(f.size)}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">The agent reads them; they are not part of its change.</p>
      {problem ? <p className="error small" role="alert">{problem}</p> : null}
    </section>
  );
}
