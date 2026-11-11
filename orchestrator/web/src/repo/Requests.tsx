import { useEffect, useState } from "react";
import { api } from "../api";
import type { PendingScan, PendingShare } from "../api";
import { RequestList } from "../Editing";
import { ForgeState } from "../ForgeState";
import { Hint } from "../Hint";
import { requestReads } from "../request-reads";
import { RequestDiff } from "../RequestDiff";
import { WORDS } from "../words";
import type { RepoPanelProps } from "./types";

/**
 * What waits to be merged in the team repository that the orchestrator did not open - a teammate's
 * share, a hand-made request - as its forge lists it now. The orchestrator's own are counted and
 * left to the list above. Read-only: the forge is where it is reviewed.
 */
const SCAN: Record<PendingScan["state"], { badge: string; text: string }> = {
  clean: { badge: "ok", text: "nothing unusual" },
  attention: { badge: "warn", text: "to look at" },
  refused: { badge: "error", text: "would not be shared as written" },
  unread: { badge: "neutral", text: "not read yet" },
};

/**
 * What the orchestrator found reading a waiting request on its own copy: the state at a glance, and
 * under it each finding with the file, the line, how much it can do on a teammate's machine,
 * and the line itself unless it looks like it holds a secret.
 */
function ScanResult({ scan }: { scan: PendingScan | null }) {
  if (!scan) return <span className="muted">not read yet</span>;
  const shown = SCAN[scan.state];
  const label = scan.state === "attention" ? `${scan.findings.length} ${shown.text}` : shown.text;
  return (
    <div className="scan">
      <span className={`badge ${shown.badge}`}>{label}</span>
      {scan.state === "unread" && scan.reason ? <p className="muted small">{scan.reason}</p> : null}
      {scan.findings.length ? (
        <details>
          <summary>What was found</summary>
          <ul className="plain scan-findings">
            {scan.findings.map((f, i) => (
              <li key={`${f.path}:${f.line ?? ""}:${i}`}>
                <span className="mono">{f.path}{f.line ? `:${f.line}` : ""}</span>
                {f.risk ? <> <span className={`badge ${f.risk === "high" ? "error" : "warn"}`}>{f.risk} risk</span></> : null}
                {f.level === "refused" ? <> <span className="badge error">not shared as written</span></> : null}
                <p className="muted small">{f.detail}</p>
                {f.evidence ? <code className="scan-evidence">{f.evidence}</code> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PendingShares({ repoId, version }: { repoId: string; version: number }) {
  const [read, setRead] = useState<{ pending: PendingShare[] | null; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    api.pending(repoId).then(setRead, (e: Error) => setError(e.message));
  }, [repoId, version]);
  const others = read?.pending?.filter((p) => !p.byOrchestrator) ?? [];
  const ours = (read?.pending?.length ?? 0) - others.length;
  return (
    <section className="panel" aria-labelledby="pending-h">
      <h2 id="pending-h">Waiting to be merged <span className="count">{read?.pending ? others.length : ""}</span></h2>
      {read?.pending && ours ? <p className="muted">{ours} more, opened from the orchestrator, {ours === 1 ? "is" : "are"} under Requests from the orchestrator.</p> : null}
      {error ? <p className="error">{error}</p> : !read ? <p className="muted">Reading the forge…</p> : !read.pending ? <p className="muted">{read.reason}</p> : !others.length ? <p className="muted">Nothing else waits to be merged.</p> : (
        <table className="row-cards">
          <thead><tr><th>Request</th><th>Branch</th><th>By</th><th>Updated</th><th>Read before merging</th></tr></thead>
          <tbody>
            {others.map((p) => (
              <tr key={`${p.number ?? ""}:${p.fromFork ? "fork" : ""}:${p.branch}`}>
                <td className="rc-title">
                  {p.url ? <a href={p.url} target="_blank" rel="noreferrer noopener">{p.number !== null ? `#${p.number} ` : ""}{p.title}</a> : <>{p.number !== null ? `#${p.number} ` : ""}{p.title}</>}
                  {p.fromFork ? <> <span className="badge warn">from a fork</span></> : null}
                  {p.number !== null ? <RequestDiff reads={requestReads(repoId, p.number)} /> : null}
                </td>
                <td className="mono rc-extra">{p.branch}</td>
                <td className="rc-meta">{p.author}</td>
                <td className="rc-meta">{p.updatedAt.slice(0, 16).replace("T", " ")}</td>
                <td className="rc-wide">
                  <ScanResult scan={p.scan ?? null} />
                  {p.number !== null && p.url?.startsWith("http") ? <ForgeState request={{ repoId, number: p.number, status: "open", provider: "hosted" }} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The requests the orchestrator opened on the repository, and what else waits to be merged there. */
export function Requests({ repo, me, onChanged, requestsRead }: RepoPanelProps) {
  const [requestCount, setRequestCount] = useState<number | null>(null);
  return (
    <>
      <section className="panel" aria-labelledby="req-h">
        <h2 id="req-h">Requests from the orchestrator <span className="count">{requestCount ?? ""}</span></h2>
        <p className="muted">Nothing reaches teammates until a reviewer merges it. <Hint label="requests">{WORDS.request.means}</Hint></p>
        <RequestList repoId={repo.id} repos={[repo]} me={me} version={requestsRead} onCounts={(r) => setRequestCount(r.counts.open + r.counts.merged + r.counts.closed)} onChanged={onChanged} />
      </section>

      <PendingShares repoId={repo.id} version={requestsRead} />
    </>
  );
}
