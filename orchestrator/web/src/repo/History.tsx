import { useEffect, useState } from "react";
import { api } from "../api";
import type { HistoryEntry } from "../api";
import { Loading, LoadFailed } from "../Status";

/** The commits that touch a path of the repository, or the whole repository when no path is given. */
export function History({ repoId, path, head }: { repoId: string; path?: string; head: string | null }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    // A slower answer for the previous path or head must not replace the one asked for now.
    let current = true;
    setEntries(null);
    setError(null);
    api.history(repoId, path).then(
      (e) => current && setEntries(e),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [repoId, path, head, reads]);
  if (error) return <LoadFailed what="the history" reason={error} onRetry={() => setReads((n) => n + 1)} />;
  if (!entries) return <Loading what="the history" />;
  if (!entries.length) return <p className="muted">No commits touch this path.</p>;
  return (
    <ol className="history">
      {entries.map((e) => (
        <li key={e.sha}>
          <code>{e.sha.slice(0, 7)}</code> <span>{e.subject}</span>
          <span className="muted"> by {e.author} on {e.date.slice(0, 10)}</span>
        </li>
      ))}
    </ol>
  );
}
