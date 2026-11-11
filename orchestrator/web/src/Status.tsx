import type { ReactNode } from "react";
/**
 * The two words every section says while it waits or after it fails, named for what it reads:
 * "Loading skill use…", then "Couldn't load skill use. <the orchestrator's reason>" with "Retry skill
 * use". Several sections on one page then say which one waits or failed.
 */
export function Loading({ what, panel = false }: { what: string; panel?: boolean }) {
  // The shape of what lands sits beside the words, so the page does not jump when it does.
  return (
    <div className={panel ? "panel loading" : "loading"}>
      <p className="muted" role="status">Loading {what}…</p>
      <div className="skeleton" aria-hidden="true"><span className="skeleton-line" /><span className="skeleton-line" /><span className="skeleton-line" /></div>
    </div>
  );
}

/** A load that failed always offers the next step: trying again, or the page that puts it right. */
type NextStepOf = { onRetry: () => void; next?: never } | { next: ReactNode; onRetry?: never };

export function LoadFailed({ what, reason, panel = false, ...step }: { what: string; reason: string; panel?: boolean } & NextStepOf) {
  const body = (
    <>
      <p className="error">Couldn't load {what}. {reason}</p>
      {step.onRetry ? <button type="button" className="secondary small" onClick={step.onRetry}>Retry {what}</button> : <p>{step.next}</p>}
    </>
  );
  return panel ? <div className="panel problem" role="alert">{body}</div> : <div className="problem" role="alert">{body}</div>;
}

/**
 * A refresh that failed while the page still holds what it read before: the old rows stay, and
 * this says they are the last ones loaded, so nobody reads them as current.
 */
export function RefreshFailed({ what, reason, onRetry }: { what: string; reason: string; onRetry: () => void }) {
  return (
    <div className="problem stale" role="alert">
      <p className="error">Refresh failed. Showing the last loaded {what}. {reason}</p>
      <button type="button" className="secondary small" onClick={onRetry}>Retry {what}</button>
    </div>
  );
}
