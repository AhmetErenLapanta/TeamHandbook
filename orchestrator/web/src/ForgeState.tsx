import { useEffect, useState } from "react";
import type { ChecksSummary, Mergeability, RequestComment, RequestStatusRead, ReviewSummary } from "../../shared/forge-read";
import { requestStatus } from "./request-reads";
import type { RequestRecord } from "./api";

// A page lists up to fifty requests and each read asks the forge several things; three at a time
// keeps a page from spending the team's forge rate limit in one load.
const AT_ONCE = 3;
let running = 0;
const waiting: (() => void)[] = [];
async function inTurn<T>(read: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await read();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function checksLine(c: ChecksSummary): string {
  const failing = c.checks.filter((x) => x.state === "failure").length;
  if (c.state === "failing") return `${failing || "some"} ${failing === 1 ? "check" : "checks"} failing`;
  return { passing: "checks passing", pending: "checks running", "no-ci": "no CI", unknown: "no check reported yet" }[c.state];
}

function reviewLine(r: ReviewSummary): string {
  if (r.decision === "approved") return r.approvedBy.length ? `approved by ${r.approvedBy.join(", ")}` : "approved";
  return { "changes-requested": "changes requested", pending: "waiting for a reviewer", none: "no reviewer asked" }[r.decision];
}

function mergeLine(m: Mergeability): string | null {
  if (m.state === "not-open") return null;
  if (m.state === "blocked") return m.reason ? `blocked: ${m.reason}` : "blocked";
  return { mergeable: "ready to merge", conflict: "has a conflict to resolve", checking: "checking whether it merges" }[m.state];
}

/** What people said on a request, in a few words: how many, and who spoke last; a bot's notes are not what a reader waits on. */
export function commentsLine(comments: RequestComment[]): string | null {
  const said = comments.filter((c) => c.kind !== "bot");
  if (!said.length) return null;
  return `${said.length} ${said.length === 1 ? "comment" : "comments"}, the newest from ${said[0]!.author}`;
}

/** The words of a status line: whether it merges, then what its forge adds, which a request on this machine's own copy has none of. */
export function statusLine(status: Pick<RequestStatusRead, "source" | "detail" | "comments">): { merge: string | null; tone: string; rest: string } {
  const { detail } = status;
  const merge = mergeLine(detail.mergeability);
  const failing = detail.checks.state === "failing";
  const tone = detail.mergeability.state === "mergeable" && !failing ? "ok" : detail.mergeability.state === "conflict" || detail.mergeability.state === "blocked" || failing ? "warn" : "neutral";
  const rest = status.source === "local" ? [] : [checksLine(detail.checks), reviewLine(detail.review), commentsLine(status.comments)];
  return { merge, tone, rest: rest.filter(Boolean).join(", ") };
}

/**
 * An open request as it stands now, in one line under its status: whether it merges, with the
 * reason when it does not, and on a forge its checks, its review and what people said. One
 * already merged or closed needs no line.
 */
export function ForgeState({ request }: { request: Pick<RequestRecord, "repoId" | "number" | "status" | "provider" | "heldHead" | "heldReason"> }) {
  const [status, setStatus] = useState<RequestStatusRead | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const open = request.status === "open";
  const local = request.provider === "local";
  useEffect(() => {
    if (!open) return;
    let current = true;
    inTurn(() => requestStatus(request.repoId, request.number)).then(
      (read) => current && setStatus(read),
      (e: Error) => current && setProblem(e.message),
    );
    return () => {
      current = false;
    };
  }, [request.repoId, request.number, open]);
  if (!open) return null;
  // A push after the check holds the request whatever its forge says: it does not merge until a later push passes.
  if (request.heldHead || request.heldReason !== undefined) {
    return (
      <p className="small forge-state">
        <span className="state warn">changed after the check</span> <span className="muted">{request.heldReason ? `${request.heldReason.charAt(0).toUpperCase()}${request.heldReason.slice(1)}. ` : ""}It merges once a later push passes the team's rules.</span>
      </p>
    );
  }
  // A request on this machine's own copy reads in a moment from the repository, so it shows
  // nothing until it has, and a read that fails leaves its row as it was before the line existed.
  if (problem) return local ? null : <p className="muted small forge-state">Where it stands is not known: {problem}</p>;
  if (!status) return local ? null : <p className="muted small forge-state">Reading the forge…</p>;
  const line = statusLine(status);
  if (!line.merge && !line.rest) return null;
  return (
    <p className="small forge-state">
      {line.merge ? <><span className={`state ${line.tone}`}>{line.merge}</span> </> : null}
      {line.rest ? <span className="muted">{line.rest}</span> : null}
    </p>
  );
}
